// One suite, both adapters. What matters about Storage is that the two behave
// identically at the seam — a test that only ever ran against the local adapter
// would let the S3 one drift until the first person who deployed it found out.
//
// The S3 half only runs when DUOLISTENING_TEST_S3_BUCKET is set (plus the usual
// AWS credential env vars, and AWS_ENDPOINT_URL for MinIO and friends).

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import type { Storage } from "../ports.ts";
import { createLocalStorage } from "./local.ts";
import { createS3Storage } from "./s3.ts";

interface Harness {
  storage: Storage;
  cleanup: () => Promise<void>;
}

function describeStorageContract(name: string, open: () => Promise<Harness>): void {
  describe(name, () => {
    const withStorage = async (body: (storage: Storage) => Promise<void>) => {
      const harness = await open();
      try {
        await body(harness.storage);
      } finally {
        await harness.cleanup();
      }
    };

    it("reads a missing document as null rather than throwing", async () => {
      await withStorage(async (storage) => {
        assert.equal(await storage.readDoc("resources/index.json"), null);
      });
    });

    it("round-trips a document", async () => {
      await withStorage(async (storage) => {
        await storage.writeDoc("resources/index.json", { titles: ["episode405"] });
        assert.deepEqual(await storage.readDoc("resources/index.json"), {
          titles: ["episode405"],
        });
      });
    });

    it("overwrites a document in place", async () => {
      await withStorage(async (storage) => {
        await storage.writeDoc("settings.json", { targetLanguage: "ja" });
        await storage.writeDoc("settings.json", { targetLanguage: "ko" });
        assert.deepEqual(await storage.readDoc("settings.json"), { targetLanguage: "ko" });
      });
    });

    it("survives concurrent writes to one key", async () => {
      // Callers are not required to serialise. Whichever write lands last wins, but
      // none of them may fail, and the document must not end up torn.
      await withStorage(async (storage) => {
        const writes = [1, 2, 3, 4, 5].map((n) =>
          storage.writeDoc("resources/index.json", { attempt: n }),
        );
        await Promise.all(writes);

        const stored = await storage.readDoc<{ attempt: number }>("resources/index.json");
        assert.ok(stored && [1, 2, 3, 4, 5].includes(stored.attempt));
      });
    });

    it("lists documents under a prefix, and nothing else", async () => {
      await withStorage(async (storage) => {
        await storage.writeDoc("settings.json", {});
        await storage.writeDoc("resources/index.json", {});
        await storage.writeDoc("resources/abc/meta.json", {});
        await storage.writeDoc("resources/abc/transcript.json", {});

        assert.deepEqual(await storage.listDocKeys("resources/"), [
          "resources/abc/meta.json",
          "resources/abc/transcript.json",
          "resources/index.json",
        ]);
        assert.deepEqual(await storage.listDocKeys("resources/abc/"), [
          "resources/abc/meta.json",
          "resources/abc/transcript.json",
        ]);
      });
    });

    it("lists nothing for a prefix that has never been written", async () => {
      await withStorage(async (storage) => {
        assert.deepEqual(await storage.listDocKeys("resources/"), []);
      });
    });

    it("does not list media as documents", async () => {
      await withStorage(async (storage) => {
        const source = await writeTempFile("audio bytes");
        await storage.writeMedia("resources/abc/audio.m4a", source);
        assert.deepEqual(await storage.listDocKeys("resources/"), []);
      });
    });

    it("deletes, and treats deleting an absent object as done", async () => {
      await withStorage(async (storage) => {
        await storage.writeDoc("resources/abc/meta.json", { title: "gone soon" });
        await storage.deleteObject("resources/abc/meta.json");
        assert.equal(await storage.readDoc("resources/abc/meta.json"), null);
        await storage.deleteObject("resources/abc/meta.json");
      });
    });

    it("round-trips media byte for byte", async () => {
      await withStorage(async (storage) => {
        const payload = Buffer.from([0, 1, 2, 253, 254, 255]);
        const source = await writeTempFile(payload);
        const destination = path.join(await tempDir(), "out.m4a");

        await storage.writeMedia("resources/abc/audio.m4a", source);
        await storage.readMediaToFile("resources/abc/audio.m4a", destination);

        assert.deepEqual(await fs.readFile(destination), payload);
      });
    });

    it("hands out a playback URL naming the object", async () => {
      await withStorage(async (storage) => {
        const url = await storage.playbackUrl("resources/abc/audio.m4a");
        assert.match(url, /audio\.m4a/);
      });
    });

    it("refuses keys that would escape the storage root", async () => {
      await withStorage(async (storage) => {
        await assert.rejects(() => storage.readDoc("../../etc/passwd"));
        await assert.rejects(() => storage.writeDoc("resources/../../escaped.json", {}));
        await assert.rejects(() => storage.deleteObject("resources/abc/../../x.json"));
        await assert.rejects(() => storage.playbackUrl("/absolute.json"));
      });
    });
  });
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "duolistening-"));
}

async function writeTempFile(contents: string | Buffer): Promise<string> {
  const file = path.join(await tempDir(), "input.bin");
  await fs.writeFile(file, contents);
  return file;
}

describeStorageContract("local storage", async () => {
  const rootDir = await tempDir();
  return {
    storage: createLocalStorage({ rootDir }),
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
});

const bucket = process.env["DUOLISTENING_TEST_S3_BUCKET"];
if (bucket) {
  describeStorageContract("s3 storage", async () => {
    const client = new S3Client({});
    const keyPrefix = `duolistening-test/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const storage = createS3Storage({ client, bucket, keyPrefix });
    return {
      storage,
      cleanup: async () => {
        for (const key of await storage.listDocKeys("")) await storage.deleteObject(key);
        await storage.deleteObject("resources/abc/audio.m4a");
        client.destroy();
      },
    };
  });
}
