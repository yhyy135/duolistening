import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { Storage } from "../ports.ts";
import { assertValidKey, assertValidPrefix } from "./key.ts";

export interface LocalStorageOptions {
  /** Directory everything lives under. Created on demand. */
  rootDir: string;
  /**
   * Path the server mounts its Range-capable media route on. `playbackUrl` returns
   * URLs beneath it, so the two have to agree.
   */
  mediaRoute?: string;
}

/** Storage backed by the deployer's own disk (ADR 0007). */
export function createLocalStorage(options: LocalStorageOptions): Storage {
  const root = path.resolve(options.rootDir);
  const mediaRoute = options.mediaRoute ?? "/media";
  const resolve = (key: string) => path.join(root, key);

  async function copyInto(from: string, to: string): Promise<void> {
    await fs.mkdir(path.dirname(to), { recursive: true });
    // Copy rather than rename: the source often sits in a temp working directory
    // on another filesystem, and renaming would take it away from its owner.
    await fs.copyFile(from, to);
  }

  return {
    async readDoc<T>(key: string): Promise<T | null> {
      assertValidKey(key);
      try {
        return JSON.parse(await fs.readFile(resolve(key), "utf8")) as T;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async writeDoc<T>(key: string, value: T): Promise<void> {
      assertValidKey(key);
      const destination = resolve(key);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      // Write-then-rename: a crash mid-write would otherwise truncate the Library
      // index, and rename within one directory is atomic. The random suffix matters
      // — two concurrent writes to one key must not pick the same temp file, or one
      // renames it out from under the other.
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
      await fs.rename(temporary, destination);
    },

    async listDocKeys(prefix: string): Promise<string[]> {
      assertValidPrefix(prefix);
      let entries: string[];
      try {
        entries = await fs.readdir(resolve(prefix), { recursive: true });
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      // `.json` filters out directories, media blobs, and any `.tmp` left by a
      // crashed write, in one step.
      return entries
        .map((entry) => entry.split(path.sep).join("/"))
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => (prefix ? `${prefix.replace(/\/$/, "")}/${entry}` : entry))
        .sort();
    },

    async deleteObject(key: string): Promise<void> {
      assertValidKey(key);
      try {
        await fs.rm(resolve(key));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },

    async writeMedia(key: string, localPath: string): Promise<void> {
      assertValidKey(key);
      await copyInto(localPath, resolve(key));
    },

    async readMediaToFile(key: string, destPath: string): Promise<void> {
      assertValidKey(key);
      await copyInto(resolve(key), destPath);
    },

    async playbackUrl(key: string): Promise<string> {
      assertValidKey(key);
      return `${mediaRoute}/${key}`;
    },
  };
}

/**
 * Serves media out of the same root, with the HTTP Range support an <audio> element
 * needs in order to seek.
 *
 * This lives with the local adapter rather than on the Storage interface because the
 * S3 adapter has no use for it — its playbackUrl is presigned and the browser never
 * comes back to us for the bytes.
 */
export function createLocalMediaServer(rootDir: string) {
  const root = path.resolve(rootDir);

  return async function serveMedia(key: string, rangeHeader: string | null): Promise<Response> {
    try {
      assertValidKey(key);
    } catch {
      return new Response("Bad media key", { status: 400 });
    }

    const file = path.join(root, key);
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch (error) {
      if (isMissing(error)) return new Response("Not found", { status: 404 });
      throw error;
    }

    const headers: Record<string, string> = {
      "content-type": "audio/mp4",
      "accept-ranges": "bytes",
    };

    const range = parseRange(rangeHeader, size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }
    if (!range) {
      return new Response(toWebStream(createReadStream(file)), {
        status: 200,
        headers: { ...headers, "content-length": String(size) },
      });
    }

    return new Response(toWebStream(createReadStream(file, range)), {
      status: 206,
      headers: {
        ...headers,
        "content-length": String(range.end - range.start + 1),
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  };
}

/** Null for "send the whole thing"; the literal "unsatisfiable" for a range past the end. */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  // `bytes=-500` means the last 500 bytes, not "up to byte 500".
  const start = rawStart ? Number(rawStart) : Math.max(0, size - Number(rawEnd));
  const end = rawStart ? (rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1) : size - 1;

  if (!rawStart && !rawEnd) return null;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function toWebStream(stream: ReturnType<typeof createReadStream>): ReadableStream {
  return Readable.toWeb(stream) as ReadableStream;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
