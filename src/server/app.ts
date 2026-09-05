import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import {
  LANGUAGES,
  LANGUAGE_NAMES,
  storageKeys,
  type LanguageCode,
  type ModelSlot,
  type Settings,
  type SourceRef,
} from "../shared/model.ts";
import type { ImportJobs, Library, PodcastFeed, Storage, TextModel } from "./ports.ts";
import { applySettingsEdit, maskSettings, readSettings, writeSettings } from "./settings.ts";
import { ModelError } from "./text-model.ts";

const SESSION_COOKIE = "duolistening_session";

export interface AppOptions {
  storage: Storage;
  library: Library;
  importJobs: ImportJobs;
  podcastFeed: PodcastFeed;
  textModel: (settings: Settings) => TextModel;
  /**
   * The shared access gate (ADR 0001). Leaving it empty disables the gate, which is
   * reasonable on a laptop and reckless on a public host — main.ts says so loudly.
   */
  password?: string;
  /**
   * Serves audio bytes for local storage. Absent under S3, where playback URLs are
   * presigned and the browser never asks us for the audio.
   */
  serveMedia?: (key: string, rangeHeader: string | null) => Promise<Response>;
}

export function createApp(options: AppOptions) {
  const { storage, library, importJobs, podcastFeed } = options;
  const expected = options.password ? tokenFor(options.password) : null;

  const app = new Hono();

  /**
   * Accepts the token as a bearer header (what the SPA sends) or a cookie (what an
   * <audio> element can send, since it cannot set headers).
   */
  app.use("*", async (context, next) => {
    if (!expected) return next();
    // Only the data is gated. The SPA shell has to load before anyone can be asked
    // for a password, and it holds nothing worth hiding.
    if (!/^\/(api|media)\//.test(context.req.path)) return next();
    if (context.req.path === "/api/session" && context.req.method === "POST") return next();

    const header = context.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const presented = header || getCookie(context, SESSION_COOKIE) || "";
    if (!sameToken(presented, expected)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.post("/api/session", async (context) => {
    if (!expected) return context.json({ token: null });

    const { password } = await readJson<{ password?: unknown }>(context.req.raw);
    if (typeof password !== "string" || !sameToken(tokenFor(password), expected)) {
      return context.json({ error: "wrong password" }, 401);
    }

    const token = tokenFor(password);
    setCookie(context, SESSION_COOKIE, token, {
      httpOnly: true,
      // Strict is also the CSRF story: no cross-site request carries this cookie,
      // and every state-changing route needs it.
      sameSite: "Strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return context.json({ token });
  });

  /** Lets the SPA find out whether the token it kept is still good. */
  app.get("/api/session", (context) => context.json({ ok: true, required: expected !== null }));

  app.get("/api/settings", async (context) =>
    context.json(maskSettings(await readSettings(storage))),
  );

  app.put("/api/settings", async (context) => {
    const edit = parseSettings(await readJson<unknown>(context.req.raw));
    if (!edit) return context.json({ error: "malformed settings" }, 400);

    const merged = applySettingsEdit(await readSettings(storage), edit);
    await writeSettings(storage, merged);
    return context.json(maskSettings(merged));
  });

  app.get("/api/library", async (context) => context.json(await library.list()));

  app.get("/api/library/:id", async (context) => {
    const id = context.req.param("id");
    const found = await library.get(id);
    if (!found) return context.json({ error: "not found" }, 404);

    return context.json({
      ...found,
      // Fetched per request, never stored: an S3 presigned URL expires.
      playbackUrl: await storage.playbackUrl(storageKeys.audio(id)),
    });
  });

  app.delete("/api/library/:id", async (context) => {
    await library.remove(context.req.param("id"));
    return context.body(null, 204);
  });

  app.put("/api/library/:id/position", async (context) => {
    const { seconds } = await readJson<{ seconds?: unknown }>(context.req.raw);
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      return context.json({ error: "seconds must be a non-negative number" }, 400);
    }
    await library.savePosition(context.req.param("id"), seconds);
    return context.body(null, 204);
  });

  app.post("/api/imports", async (context) => {
    const body = await readJson<{ source?: unknown }>(context.req.raw);
    const source = parseSourceRef(body.source);
    if (!source) return context.json({ error: "unrecognised source" }, 400);

    return context.json(await importJobs.start(source), 202);
  });

  app.get("/api/imports/:id/events", (context) => {
    const id = context.req.param("id");
    if (!importJobs.get(id)) return context.json({ error: "not found" }, 404);

    return streamSSE(context, async (stream) => {
      for await (const state of importJobs.watch(id)) {
        await stream.writeSSE({ data: JSON.stringify(state) });
      }
    });
  });

  app.get("/api/podcast/episodes", async (context) => {
    const feedUrl = context.req.query("feedUrl");
    if (!feedUrl) return context.json({ error: "feedUrl is required" }, 400);
    return context.json(await podcastFeed.listEpisodes(feedUrl));
  });

  app.post("/api/ask", async (context) => {
    const { text } = await readJson<{ text?: unknown }>(context.req.raw);
    if (typeof text !== "string" || !text.trim()) {
      return context.json({ error: "text is required" }, 400);
    }

    const settings = await readSettings(storage);
    const answer = await options.textModel(settings).complete(askPrompt(text, settings));
    return context.json({ answer });
  });

  app.get("/media/*", async (context) => {
    if (!options.serveMedia) return context.json({ error: "not found" }, 404);
    const key = decodeURIComponent(context.req.path.replace(/^\/media\//, ""));
    return options.serveMedia(key, context.req.header("range") ?? null);
  });

  app.onError((error, context) => {
    // A model failure is the provider's fault, not the caller's: pass the reason
    // through so the UI can say "your key is wrong" instead of "something broke".
    if (error instanceof ModelError) {
      return context.json({ error: error.message, reason: error.reason }, 502);
    }
    return context.json({ error: error.message }, 500);
  });

  return app;
}

/**
 * The fixed ask-AI template, generalised past the original Chinese-only wording so
 * it still works for someone whose native language is not Chinese.
 */
function askPrompt(text: string, settings: Settings): string {
  const target = languageName(settings.targetLanguage);
  const native = languageName(settings.nativeLanguage);
  return `Help me understand this ${target} sentence — its grammar, vocabulary and nuance. Answer in ${native}.\n\n${text}`;
}

function languageName(code: LanguageCode): string {
  return LANGUAGE_NAMES[code] ?? code;
}

/** Settings arrive from the browser, so every field is checked before it is stored. */
function parseSettings(value: unknown): Settings | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;

  const textModel = parseSlot(candidate["textModel"]);
  const transcriptionModel = parseSlot(candidate["transcriptionModel"]);
  const nativeLanguage = parseLanguage(candidate["nativeLanguage"]);
  const targetLanguage = parseLanguage(candidate["targetLanguage"]);
  if (!textModel || !transcriptionModel || !nativeLanguage || !targetLanguage) return null;

  return { textModel, transcriptionModel, nativeLanguage, targetLanguage };
}

function parseSlot(value: unknown): ModelSlot | null {
  if (!value || typeof value !== "object") return null;
  const slot = value as Record<string, unknown>;
  const { baseUrl, apiKey, model } = slot;
  if (typeof baseUrl !== "string" || typeof apiKey !== "string" || typeof model !== "string") {
    return null;
  }
  return { baseUrl, apiKey, model };
}

function parseLanguage(value: unknown): LanguageCode | null {
  return LANGUAGES.includes(value as LanguageCode) ? (value as LanguageCode) : null;
}

function parseSourceRef(value: unknown): SourceRef | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;

  if (source["kind"] === "youtube" && isUrl(source["url"])) {
    return { kind: "youtube", url: source["url"] };
  }
  if (
    source["kind"] === "podcast" &&
    isUrl(source["feedUrl"]) &&
    isUrl(source["episodeUrl"]) &&
    typeof source["title"] === "string"
  ) {
    return {
      kind: "podcast",
      feedUrl: source["feedUrl"],
      episodeUrl: source["episodeUrl"],
      title: source["title"],
    };
  }
  return null;
}

function isUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

async function readJson<T>(request: Request): Promise<Partial<T>> {
  try {
    return ((await request.json()) as Partial<T>) ?? {};
  } catch {
    return {};
  }
}

function tokenFor(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

/** Constant-time, so the gate does not leak the token one character at a time. */
function sameToken(presented: string, expected: string): boolean {
  const a = Buffer.from(presented.padEnd(expected.length).slice(0, expected.length));
  const b = Buffer.from(expected);
  return timingSafeEqual(a, b) && presented.length === expected.length;
}
