import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { SourceRef } from "../shared/model.ts";
import type { AudioTool, IngestedMedia, Ingestor, ProgressFn } from "./ports.ts";

const execFileAsync = promisify(execFile);

export type IngestFailure = "unavailable" | "blocked" | "network" | "tool_missing" | "unusable";

export class IngestError extends Error {
  readonly reason: IngestFailure;

  constructor(reason: IngestFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IngestError";
    this.reason = reason;
  }
}

export interface IngestorOptions {
  /** Used to measure podcast audio; yt-dlp reports YouTube durations itself. */
  audio: AudioTool;
  ytDlpPath?: string;
  fetch?: typeof globalThis.fetch;
  /** Injected so the argument building and error mapping can be tested without yt-dlp. */
  run?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Fetches the audio for a SourceRef into a working directory.
 *
 * YouTube goes through yt-dlp because a browser cannot reach those streams and the
 * signature handling is a moving target maintained upstream; podcasts are a plain
 * HTTP download of the episode's enclosure.
 */
export function createIngestor(options: IngestorOptions): Ingestor {
  const ytDlp = options.ytDlpPath ?? "yt-dlp";
  const doFetch = options.fetch ?? globalThis.fetch;
  const run =
    options.run ?? ((file, args) => execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 }));

  async function ingestYouTube(url: string, workDir: string): Promise<IngestedMedia> {
    const output = path.join(workDir, "audio.%(ext)s");
    let stdout: string;
    try {
      ({ stdout } = await run(ytDlp, [
        "--no-playlist", // a link with a list= parameter must still import one video
        "--extract-audio",
        "--audio-format",
        "m4a",
        "--output",
        output,
        // Downloads and prints the metadata in one pass, so there is no second call
        // that could disagree with what was actually fetched.
        "--no-simulate",
        "--dump-single-json",
        "--no-progress",
        url,
      ]));
    } catch (error) {
      throw toIngestError(error);
    }

    const info = parseInfoJson(stdout);
    const audioPath = await findAudio(workDir);
    return {
      title: info.title ?? url,
      durationSec: info.durationSec ?? (await options.audio.durationSec(audioPath)),
      audioPath,
    };
  }

  async function ingestPodcast(
    ref: Extract<SourceRef, { kind: "podcast" }>,
    workDir: string,
    onProgress?: ProgressFn,
  ): Promise<IngestedMedia> {
    let response: Response;
    try {
      response = await doFetch(ref.episodeUrl, { redirect: "follow" });
    } catch (cause) {
      throw new IngestError("network", `Could not reach ${ref.episodeUrl}`, { cause });
    }
    if (!response.ok || !response.body) {
      throw new IngestError(
        response.status === 404 ? "unavailable" : "network",
        `Episode download failed with ${response.status}`,
      );
    }

    const audioPath = path.join(workDir, `audio${extensionFor(ref.episodeUrl)}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    let received = 0;

    const body = response.body as unknown as Readable;
    if (total > 0 && onProgress) {
      body.on("data", (chunk: Buffer) => {
        received += chunk.length;
        onProgress(Math.min(1, received / total));
      });
    }
    await pipeline(body, createWriteStream(audioPath));

    return {
      title: ref.title,
      durationSec: await options.audio.durationSec(audioPath),
      audioPath,
    };
  }

  return {
    ingest(ref: SourceRef, workDir: string, onProgress?: ProgressFn): Promise<IngestedMedia> {
      return ref.kind === "youtube"
        ? ingestYouTube(ref.url, workDir)
        : ingestPodcast(ref, workDir, onProgress);
    },
  };
}

/** yt-dlp prints one JSON object; anything else on stdout is noise around it. */
export function parseInfoJson(stdout: string): { title?: string; durationSec?: number } {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const info = JSON.parse(line) as { title?: unknown; duration?: unknown };
      return {
        ...(typeof info.title === "string" && { title: info.title }),
        ...(typeof info.duration === "number" && { durationSec: info.duration }),
      };
    } catch {
      // keep looking; a progress line can start with a brace
    }
  }
  return {};
}

/**
 * yt-dlp names the file itself (the extension depends on what it could extract), so
 * the directory is asked rather than assumed.
 */
async function findAudio(workDir: string): Promise<string> {
  const found = (await fs.readdir(workDir)).find((name) => name.startsWith("audio."));
  if (!found) throw new IngestError("unusable", "yt-dlp produced no audio file");
  return path.join(workDir, found);
}

export function toIngestError(error: unknown): IngestError {
  const failure = error as { code?: string; stderr?: string; message?: string };
  if (failure.code === "ENOENT") {
    return new IngestError("tool_missing", "yt-dlp is not installed or not on PATH");
  }

  const stderr = failure.stderr ?? failure.message ?? "";
  if (
    /private video|video unavailable|has been removed|does not exist|members-only/i.test(stderr)
  ) {
    return new IngestError("unavailable", firstUsefulLine(stderr));
  }
  // Phrases, not bare words: matching on "age" alone also matches "webpage", which
  // turned every failed page fetch into a reported age restriction.
  if (
    /geo-?restrict|in your country|blocked in your|sign in to confirm|age-?restrict|confirm your age|login required/i.test(
      stderr,
    )
  ) {
    return new IngestError("blocked", firstUsefulLine(stderr));
  }
  return new IngestError("network", firstUsefulLine(stderr) || "yt-dlp failed");
}

function firstUsefulLine(stderr: string): string {
  return (
    stderr
      .split("\n")
      .map((line) => line.replace(/^ERROR:\s*/i, "").trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function extensionFor(url: string): string {
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.(mp3|m4a|aac|ogg|opus|wav|mp4)$/.test(extension) ? extension : ".mp3";
}
