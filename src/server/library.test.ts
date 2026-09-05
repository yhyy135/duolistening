import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { storageKeys, type Resource, type Transcript } from "../shared/model.ts";
import { createLibrary } from "./library.ts";
import type { Library, Storage } from "./ports.ts";
import { createLocalStorage } from "./storage/local.ts";

const resource = (id: string, overrides: Partial<Resource> = {}): Resource => ({
  id,
  source: { kind: "youtube", url: `https://youtu.be/${id}` },
  title: `episode ${id}`,
  durationSec: 1555,
  targetLanguage: "ja",
  nativeLanguage: "zh-CN",
  importedAt: "2026-09-06T00:00:00.000Z",
  phase: "ready",
  ...overrides,
});

const transcript: Transcript = [{ startSec: 0, endSec: 2, text: "自己紹介をします" }];

describe("library", () => {
  let storage: Storage;
  let library: Library;
  let audioFile: string;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-lib-"));
    storage = createLocalStorage({ rootDir: path.join(root, "data") });
    library = createLibrary(storage);
    audioFile = path.join(root, "audio.m4a");
    await fs.writeFile(audioFile, "pretend this is audio");
  });

  it("starts empty", async () => {
    assert.deepEqual(await library.list(), []);
    assert.equal(await library.get("nope"), null);
  });

  it("keeps what was saved, with its transcript and audio", async () => {
    await library.save(resource("abc"), { transcript, audioPath: audioFile });

    assert.deepEqual(await library.list(), [resource("abc")]);
    assert.deepEqual(await library.get("abc"), { resource: resource("abc"), transcript });
  });

  it("reports an import that has no transcript yet as empty, not missing", async () => {
    await library.save(resource("abc", { phase: "transcribing" }));

    const found = await library.get("abc");
    assert.equal(found?.resource.phase, "transcribing");
    assert.deepEqual(found?.transcript, []);
  });

  it("upserts rather than duplicating, so an import can report progress", async () => {
    await library.save(resource("abc", { phase: "fetching" }));
    await library.save(resource("abc", { phase: "ready" }), { transcript });

    const shelf = await library.list();
    assert.equal(shelf.length, 1);
    assert.equal(shelf[0]?.phase, "ready");
  });

  it("removes the entry and every file behind it", async () => {
    await library.save(resource("abc"), { transcript, audioPath: audioFile });
    await library.remove("abc");

    assert.deepEqual(await library.list(), []);
    assert.equal(await library.get("abc"), null);
    assert.equal(await storage.readDoc(storageKeys.transcript("abc")), null);
    await assert.rejects(
      () => storage.readMediaToFile(storageKeys.audio("abc"), path.join(os.tmpdir(), "x.m4a")),
      "audio should be gone too, or the bucket keeps billing for it",
    );
  });

  it("treats removing something absent as done", async () => {
    await library.remove("never-existed");
  });

  it("remembers where playback stopped", async () => {
    await library.save(resource("abc"));
    await library.savePosition("abc", 81.5);

    assert.equal((await library.get("abc"))?.resource.lastPositionSec, 81.5);
  });

  it("ignores a position saved against something already deleted", async () => {
    await library.savePosition("never-existed", 10);
    assert.deepEqual(await library.list(), []);
  });

  it("rejects a nonsense position", async () => {
    await library.save(resource("abc"));
    await assert.rejects(() => library.savePosition("abc", -1));
    await assert.rejects(() => library.savePosition("abc", Number.NaN));
  });

  // The reason the shelf is written through a serialised chain: these are all
  // read-modify-write against one document, and interleaving them loses entries.
  it("loses nothing when writes overlap", async () => {
    const ids = ["a", "b", "c", "d", "e"];

    await Promise.all(ids.map((id) => library.save(resource(id))));
    assert.deepEqual((await library.list()).map((entry) => entry.id).sort(), ids);

    await Promise.all(ids.map((id, index) => library.savePosition(id, index * 10)));
    const positions = Object.fromEntries(
      (await library.list()).map((entry) => [entry.id, entry.lastPositionSec]),
    );
    assert.deepEqual(positions, { a: 0, b: 10, c: 20, d: 30, e: 40 });
  });
});
