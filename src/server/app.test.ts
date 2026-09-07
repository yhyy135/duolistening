import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { Resource, Settings, Transcript } from "../shared/model.ts";
import { createApp } from "./app.ts";
import { createLibrary } from "./library.ts";
import type {
  ImportJobs,
  JobState,
  Library,
  PodcastFeed,
  Storage,
  TextModel,
} from "./ports.ts";
import { createLocalMediaServer, createLocalStorage } from "./storage/local.ts";
import { ModelError } from "./text-model.ts";

const PASSWORD = "hunter2";
const TOKEN = createHash("sha256").update(PASSWORD).digest("hex");

const resource = (id: string): Resource => ({
  id,
  source: { kind: "youtube", url: "https://youtu.be/abc" },
  title: "episode405",
  durationSec: 1555,
  targetLanguage: "ja",
  nativeLanguage: "zh-CN",
  importedAt: "2026-09-06T00:00:00.000Z",
  phase: "ready",
});

const transcript: Transcript = [{ startSec: 0, endSec: 2, text: "自己紹介をします" }];

describe("http app", () => {
  let storage: Storage;
  let library: Library;
  let rootDir: string;
  let started: JobState[];
  let checked: Settings[];
  let retried: string[];
  let asked: string[];
  let app: ReturnType<typeof createApp>;

  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-http-"));
    storage = createLocalStorage({ rootDir });
    library = createLibrary(storage);
    started = [];
    asked = [];
    checked = [];
    retried = [];

    const importJobs: ImportJobs = {
      start: async (ref) => {
        const state: JobState = { id: "job-1", resourceId: "job-1", phase: "queued" };
        started.push({ ...state, failureReason: JSON.stringify(ref) });
        return state;
      },
      retry: async (id) => {
        retried.push(id);
        return { id, resourceId: id, phase: "queued" };
      },
      get: (id) => (id === "job-1" ? { id, resourceId: id, phase: "ready" } : null),
      watch: async function* (id) {
        yield { id, resourceId: id, phase: "transcribing" };
        yield { id, resourceId: id, phase: "ready" };
      },
    };

    const podcastFeed: PodcastFeed = {
      listEpisodes: async (feedUrl) => ({
        feedTitle: "Let's Talk in Japanese!",
        episodes: [{ title: `from ${feedUrl}`, audioUrl: "https://cdn.example.com/405.mp3" }],
      }),
    };

    const textModel = (_settings: Settings): TextModel => ({
      complete: async (prompt) => {
        asked.push(prompt);
        return "This sentence introduces yourself.";
      },
      completeJson: async () => {
        throw new Error("unused");
      },
    });

    app = createApp({
      storage,
      library,
      importJobs,
      podcastFeed,
      textModel,
      // Records what the route decided to probe, which is the part worth testing
      // here: the merge of the posted edit with what is already stored.
      checkSettings: async (settings) => {
        checked.push(settings);
        return {
          textModel: { ok: true, detail: "" },
          transcriptionModel: { ok: false, detail: "Not configured." },
        };
      },
      password: PASSWORD,
      serveMedia: createLocalMediaServer(rootDir),
    });
  });

  describe("the access gate", () => {
    it("turns away a request with no token", async () => {
      assert.equal((await app.request("/api/library")).status, 401);
    });

    it("turns away a wrong password", async () => {
      const response = await app.request("/api/session", {
        method: "POST",
        body: JSON.stringify({ password: "letmein" }),
      });
      assert.equal(response.status, 401);
    });

    it("hands back a token and a cookie for the right password", async () => {
      const response = await app.request("/api/session", {
        method: "POST",
        body: JSON.stringify({ password: PASSWORD }),
      });

      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { token: string }).token, TOKEN);
      const cookie = response.headers.get("set-cookie") ?? "";
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Strict/i);
    });

    it("accepts the cookie too, since <audio> cannot send headers", async () => {
      const response = await app.request("/api/library", {
        headers: { cookie: `duolistening_session=${TOKEN}` },
      });
      assert.equal(response.status, 200);
    });

    it("lets everything through when no password is configured", async () => {
      const open = createApp({
        storage,
        library,
        importJobs: {
          start: async () => ({ id: "x", resourceId: "x", phase: "queued" }),
        } as never,
        checkSettings: (() => {}) as never,
        podcastFeed: {} as never,
        textModel: () => ({}) as never,
      });
      assert.equal((await open.request("/api/library")).status, 200);
    });
  });

  describe("settings", () => {
    it("never sends the API keys to the browser", async () => {
      await storage.writeDoc("settings.json", {
        textModel: { baseUrl: "https://a", apiKey: "sk-supersecret1234", model: "m" },
        transcriptionModel: {
          baseUrl: "https://a",
          apiKey: "sk-anothersecret5678",
          model: "w",
        },
        nativeLanguage: "zh-CN",
        targetLanguage: "ja",
      });

      const body = (await (
        await app.request("/api/settings", { headers: auth })
      ).json()) as Settings;

      assert.equal(body.textModel.apiKey, "••••1234");
      assert.equal(body.transcriptionModel.apiKey, "••••5678");
      assert.equal(body.textModel.baseUrl, "https://a", "only the key is hidden");
    });

    it("tests what is on screen, with the real key behind any mask", async () => {
      await storage.writeDoc("settings.json", {
        textModel: { baseUrl: "https://a", apiKey: "sk-supersecret1234", model: "m" },
        transcriptionModel: { baseUrl: "https://a", apiKey: "sk-keep-me", model: "w" },
        nativeLanguage: "zh-CN",
        targetLanguage: "ja",
      });

      const response = await app.request("/api/settings/check", {
        method: "POST",
        headers: auth,
        // What the screen holds after the user retyped one model name and left the
        // keys alone: one mask, one untouched real key.
        body: JSON.stringify({
          textModel: { baseUrl: "https://a", apiKey: "••••1234", model: "m2" },
          transcriptionModel: { baseUrl: "https://a", apiKey: "sk-keep-me", model: "w" },
          nativeLanguage: "zh-CN",
          targetLanguage: "ja",
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        textModel: { ok: true, detail: "" },
        transcriptionModel: { ok: false, detail: "Not configured." },
      });

      const probed = checked[0] as Settings;
      assert.equal(
        probed.textModel.apiKey,
        "sk-supersecret1234",
        "probing with the mask itself would fail against every provider",
      );
      assert.equal(
        probed.textModel.model,
        "m2",
        "but the edited model name is what gets tried",
      );
    });

    it("does not store what it was asked to test", async () => {
      await storage.writeDoc("settings.json", {
        textModel: { baseUrl: "https://a", apiKey: "sk-supersecret1234", model: "m" },
        transcriptionModel: { baseUrl: "https://a", apiKey: "sk-keep-me", model: "w" },
        nativeLanguage: "zh-CN",
        targetLanguage: "ja",
      });

      await app.request("/api/settings/check", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          textModel: { baseUrl: "https://nope", apiKey: "sk-typo", model: "m" },
          transcriptionModel: { baseUrl: "https://a", apiKey: "sk-keep-me", model: "w" },
          nativeLanguage: "zh-CN",
          targetLanguage: "ja",
        }),
      });

      const stored = await storage.readDoc<Settings>("settings.json");
      assert.equal(stored?.textModel.baseUrl, "https://a", "a test is not a save");
    });

    it("rejects a malformed body rather than probing nonsense", async () => {
      const response = await app.request("/api/settings/check", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ textModel: "not a slot" }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(checked, []);
    });

    it("keeps the stored key when the browser sends the mask back unchanged", async () => {
      await storage.writeDoc("settings.json", {
        textModel: { baseUrl: "https://a", apiKey: "sk-supersecret1234", model: "m" },
        transcriptionModel: { baseUrl: "https://a", apiKey: "sk-keep-me", model: "w" },
        nativeLanguage: "zh-CN",
        targetLanguage: "ja",
      });

      await app.request("/api/settings", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({
          textModel: { baseUrl: "https://a", apiKey: "••••1234", model: "m2" },
          transcriptionModel: { baseUrl: "https://a", apiKey: "sk-brand-new", model: "w" },
          nativeLanguage: "en",
          targetLanguage: "ja",
        }),
      });

      const stored = await storage.readDoc<Settings>("settings.json");
      assert.equal(
        stored?.textModel.apiKey,
        "sk-supersecret1234",
        "untouched key survives a save",
      );
      assert.equal(stored?.textModel.model, "m2", "the rest of the edit still applies");
      assert.equal(stored?.transcriptionModel.apiKey, "sk-brand-new");
      assert.equal(stored?.nativeLanguage, "en");
    });

    it("refuses a malformed body instead of storing half of it", async () => {
      const slot = { baseUrl: "https://a", apiKey: "k", model: "m" };
      for (const body of [
        { textModel: slot, nativeLanguage: "en", targetLanguage: "ja" }, // no transcription slot
        {
          textModel: slot,
          transcriptionModel: slot,
          nativeLanguage: "en",
          targetLanguage: "xx",
        },
        {
          textModel: "not an object",
          transcriptionModel: slot,
          nativeLanguage: "en",
          targetLanguage: "ja",
        },
        {},
      ]) {
        const response = await app.request("/api/settings", {
          method: "PUT",
          headers: auth,
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, `should have rejected ${JSON.stringify(body)}`);
      }
      assert.equal(await storage.readDoc("settings.json"), null, "nothing was written");
    });
  });

  describe("library", () => {
    it("lists the shelf", async () => {
      await library.save(resource("abc"), { transcript });
      const body = (await (
        await app.request("/api/library", { headers: auth })
      ).json()) as Resource[];
      assert.deepEqual(
        body.map((entry) => entry.id),
        ["abc"],
      );
    });

    it("returns a Resource with a fresh playback URL", async () => {
      await library.save(resource("abc"), { transcript });
      const body = (await (
        await app.request("/api/library/abc", { headers: auth })
      ).json()) as { playbackUrl: string; transcript: Transcript };

      assert.equal(body.transcript[0]?.text, "自己紹介をします");
      assert.equal(body.playbackUrl, "/media/resources/abc/audio.m4a");
    });

    it("404s an id it has never heard of", async () => {
      assert.equal((await app.request("/api/library/nope", { headers: auth })).status, 404);
    });

    it("deletes", async () => {
      await library.save(resource("abc"), { transcript });
      const response = await app.request("/api/library/abc", {
        method: "DELETE",
        headers: auth,
      });

      assert.equal(response.status, 204);
      assert.deepEqual(await library.list(), []);
    });

    it("saves a playback position, and rejects a nonsensical one", async () => {
      await library.save(resource("abc"));

      const ok = await app.request("/api/library/abc/position", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ seconds: 81.5 }),
      });
      assert.equal(ok.status, 204);
      assert.equal((await library.get("abc"))?.resource.lastPositionSec, 81.5);

      // sendBeacon, used to save on tab close, can only POST — the route answers to
      // both methods so that save path works too.
      const beacon = await app.request("/api/library/abc/position", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ seconds: 90 }),
      });
      assert.equal(beacon.status, 204);
      assert.equal((await library.get("abc"))?.resource.lastPositionSec, 90);

      const bad = await app.request("/api/library/abc/position", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ seconds: "soon" }),
      });
      assert.equal(bad.status, 400);
    });

    it("retries a failed import", async () => {
      await library.save({
        ...resource("abc"),
        phase: "failed",
        failureReason: "model is down",
      });

      const response = await app.request("/api/library/abc/retry", {
        method: "POST",
        headers: auth,
      });

      assert.equal(response.status, 202);
      assert.deepEqual(retried, ["abc"]);
      const state = (await response.json()) as { resourceId: string };
      assert.equal(state.resourceId, "abc");
    });

    it("refuses to retry a Resource that already imported", async () => {
      await library.save(resource("abc"));

      const response = await app.request("/api/library/abc/retry", {
        method: "POST",
        headers: auth,
      });

      assert.equal(
        response.status,
        409,
        "re-importing a good Resource is a delete, not a retry",
      );
      assert.deepEqual(retried, [], "and the job is never even asked");
    });

    it("reports a retry of an unknown Resource as not found", async () => {
      const response = await app.request("/api/library/nope/retry", {
        method: "POST",
        headers: auth,
      });

      assert.equal(response.status, 404);
      assert.deepEqual(retried, []);
    });
  });

  describe("imports", () => {
    it("starts one from a YouTube URL", async () => {
      const response = await app.request("/api/imports", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ source: { kind: "youtube", url: "https://youtu.be/abc" } }),
      });

      assert.equal(response.status, 202);
      assert.equal(started.length, 1);
    });

    it("rejects a source it cannot make sense of", async () => {
      for (const source of [
        { kind: "youtube", url: "javascript:alert(1)" },
        { kind: "podcast", feedUrl: "https://f", episodeUrl: "not-a-url", title: "x" },
        { kind: "carrier-pigeon", url: "https://example.com" },
        null,
      ]) {
        const response = await app.request("/api/imports", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ source }),
        });
        assert.equal(response.status, 400, `should have rejected ${JSON.stringify(source)}`);
      }
      assert.equal(started.length, 0);
    });

    it("streams progress as server-sent events", async () => {
      const response = await app.request("/api/imports/job-1/events", { headers: auth });

      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const body = await response.text();
      assert.match(body, /"phase":"transcribing"/);
      assert.match(body, /"phase":"ready"/);
    });
  });

  describe("ask AI", () => {
    it("asks in the target language and answers in the native one", async () => {
      await storage.writeDoc("settings.json", {
        textModel: { baseUrl: "https://a", apiKey: "k", model: "m" },
        transcriptionModel: { baseUrl: "https://a", apiKey: "k", model: "w" },
        nativeLanguage: "zh-CN",
        targetLanguage: "ja",
      });

      const response = await app.request("/api/ask", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: "今日は自己紹介をします" }),
      });

      assert.equal(response.status, 200);
      assert.match(asked[0] ?? "", /Japanese/);
      assert.match(asked[0] ?? "", /Simplified Chinese/);
      assert.match(asked[0] ?? "", /今日は自己紹介をします/);
    });

    it("passes a model failure through with its reason, not as a generic 500", async () => {
      const failing = createApp({
        storage,
        library,
        importJobs: {} as never,
        podcastFeed: {} as never,
        checkSettings: (() => {}) as never,
        password: PASSWORD,
        textModel: () => ({
          complete: async () => {
            throw new ModelError("auth", "bad key");
          },
          completeJson: async () => ({}) as never,
        }),
      });

      const response = await failing.request("/api/ask", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: "hi" }),
      });

      assert.equal(response.status, 502);
      assert.equal(((await response.json()) as { reason: string }).reason, "auth");
    });
  });

  describe("media", () => {
    beforeEach(async () => {
      const source = path.join(rootDir, "source.m4a");
      await fs.writeFile(source, "0123456789");
      await storage.writeMedia("resources/abc/audio.m4a", source);
    });

    it("serves the whole file when nothing is asked for", async () => {
      const response = await app.request("/media/resources/abc/audio.m4a", { headers: auth });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(await response.text(), "0123456789");
    });

    it("serves a byte range, which is how seeking works at all", async () => {
      const response = await app.request("/media/resources/abc/audio.m4a", {
        headers: { ...auth, range: "bytes=2-5" },
      });

      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
      assert.equal(await response.text(), "2345");
    });

    it("reads an open-ended and a suffix range the way the spec says", async () => {
      const openEnded = await app.request("/media/resources/abc/audio.m4a", {
        headers: { ...auth, range: "bytes=7-" },
      });
      assert.equal(await openEnded.text(), "789");

      const suffix = await app.request("/media/resources/abc/audio.m4a", {
        headers: { ...auth, range: "bytes=-3" },
      });
      assert.equal(await suffix.text(), "789", "bytes=-3 means the last three bytes");
    });

    it("rejects a range past the end", async () => {
      const response = await app.request("/media/resources/abc/audio.m4a", {
        headers: { ...auth, range: "bytes=99-200" },
      });
      assert.equal(response.status, 416);
    });

    it("will not serve a path that climbs out of the storage root", async () => {
      const response = await app.request("/media/..%2F..%2Fetc%2Fpasswd", { headers: auth });
      assert.equal(response.status, 400);
    });
  });
});
