import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource, Transcript } from "../shared/model.ts";
import { retryImport, startImport, type ImportDeps, type ImportProgress } from "./import.ts";

const bare: Transcript = [
  { text: "one", startSec: 0, endSec: 5 },
  { text: "two", startSec: 5, endSec: 12.5 },
];
const translated: Transcript = bare.map((line) => ({ ...line, translation: "译" }));

const source = {
  kind: "podcast" as const,
  feedUrl: "https://f.example/rss",
  episodeUrl: "https://e.example/ep.mp3",
  title: "ep",
};

/**
 * A store that behaves like the real one: `save` merges rather than replaces, since
 * a Resource is written several times during one import and each write carries only
 * the part that changed.
 */
function fakeStore(seed: { transcript?: Transcript; audio?: Blob } = {}) {
  const state = {
    resource: undefined as Resource | undefined,
    transcript: seed.transcript,
    audio: seed.audio,
    saves: [] as string[],
  };
  return {
    state,
    save: async (entry: { resource: Resource; transcript?: Transcript; audio?: Blob }) => {
      state.resource = entry.resource;
      if (entry.transcript) state.transcript = entry.transcript;
      if (entry.audio) state.audio = entry.audio;
      state.saves.push(
        `${entry.resource.phase}${entry.transcript ? "+t" : ""}${entry.audio ? "+a" : ""}`,
      );
    },
    getTranscript: async () => state.transcript,
    getAudio: async () => state.audio,
  };
}

function deps(over: Partial<ImportDeps> = {}) {
  const called: string[] = [];
  const store = over.store ?? fakeStore();
  const base: ImportDeps = {
    store,
    totalBytes: async () => {
      called.push("totalBytes");
      return 43_421_257;
    },
    transcribe: async (_url, _total, onProgress) => {
      called.push("transcribe");
      onProgress(0.5);
      return bare;
    },
    annotate: async (transcript, hooks) => {
      called.push("annotate");
      await hooks.onBatch(transcript);
      hooks.onProgress(1);
      return translated;
    },
    fetchAudio: async () => {
      called.push("fetchAudio");
      return new Blob(["MP3"], { type: "audio/mpeg" });
    },
    nativeLanguage: "zh-CN",
    newId: () => "r1",
    now: () => "2026-09-08T00:00:00.000Z",
    ...over,
  };
  return { deps: base, called, store: store as ReturnType<typeof fakeStore> };
}

const collect = () => {
  const seen: ImportProgress[] = [];
  return { seen, onProgress: (state: ImportProgress) => seen.push(state) };
};

test("a fresh import runs every step and ends ready", async () => {
  const { deps: d, called, store } = deps();
  const { seen, onProgress } = collect();

  const resource = await startImport(d, { source, title: "ep" }, onProgress);

  assert.deepEqual(called, ["totalBytes", "transcribe", "fetchAudio", "annotate"]);
  assert.equal(resource.phase, "ready");
  assert.deepEqual(store.state.transcript, translated);
  assert.equal(store.state.audio?.type, "audio/mpeg");
  assert.deepEqual(
    seen.map((s) => s.phase),
    ["transcribing", "transcribing", "fetching", "annotating", "annotating", "ready"],
  );
});

test("the Resource is on the shelf before any work starts", async () => {
  const { deps: d, store } = deps({
    totalBytes: async () => {
      // By the time the first real call happens, the shelf already knows about it.
      assert.equal(store.state.resource?.id, "r1");
      assert.equal(store.state.resource?.phase, "transcribing");
      return 1000;
    },
  });
  await startImport(d, { source, title: "ep" }, () => {});
});

test("the bare Transcript is saved before annotating can fail", async () => {
  const { deps: d, store } = deps({
    annotate: async () => {
      throw new Error("rate limited");
    },
  });

  const resource = await startImport(d, { source, title: "ep" }, () => {});

  assert.equal(resource.phase, "failed");
  // The expensive artifact survived the cheap step's failure — which is what makes
  // the retry below skip transcription entirely.
  assert.deepEqual(store.state.transcript, bare);
});

test("a retry after a translation failure never transcribes again", async () => {
  const store = fakeStore({ transcript: bare, audio: new Blob(["MP3"]) });
  const { deps: d, called } = deps({ store });
  const failed: Resource = {
    id: "r1",
    source,
    title: "ep",
    durationSec: 12.5,
    nativeLanguage: "zh-CN",
    importedAt: "2026-09-08T00:00:00.000Z",
    phase: "failed",
    failureReason: "rate limited",
  };

  const resource = await retryImport(d, failed, () => {});

  assert.deepEqual(called, ["annotate"], "paid the transcription bill twice");
  assert.equal(resource.phase, "ready");
  assert.equal(resource.failureReason, undefined, "last time's reason cleared");
});

test("a retry with a Transcript but no audio fetches only the audio", async () => {
  const store = fakeStore({ transcript: bare });
  const { deps: d, called } = deps({ store });
  const failed: Resource = {
    id: "r1", source, title: "ep", durationSec: 12.5, nativeLanguage: "zh-CN",
    importedAt: "2026-09-08T00:00:00.000Z", phase: "failed",
  };

  await retryImport(d, failed, () => {});

  assert.deepEqual(called, ["fetchAudio", "annotate"]);
});

test("stored audio is never downloaded again", async () => {
  const store = fakeStore({ audio: new Blob(["MP3"]) });
  const { deps: d, called } = deps({ store });

  await startImport(d, { source, title: "ep" }, () => {});

  assert.equal(called.includes("fetchAudio"), false, "re-downloaded bytes already held");
});

test("a finished Resource is not re-importable", async () => {
  const { deps: d, called } = deps();
  const ready: Resource = {
    id: "r1", source, title: "ep", durationSec: 12.5, nativeLanguage: "zh-CN",
    importedAt: "2026-09-08T00:00:00.000Z", phase: "ready",
  };

  await assert.rejects(retryImport(d, ready, () => {}), /Delete it to import it again/);
  assert.deepEqual(called, [], "touched nothing");
});

test("a failure stays on the shelf, with its reason", async () => {
  const { deps: d, store } = deps({
    transcribe: async () => {
      throw new Error("media file too large");
    },
  });

  const resource = await startImport(d, { source, title: "ep" }, () => {});

  assert.equal(resource.phase, "failed");
  assert.equal(resource.failureReason, "media file too large");
  assert.equal(store.state.resource?.phase, "failed", "still listed, not swept away");
});

test("translations are saved batch by batch, not only at the end", async () => {
  const partial = bare.map((line, index) => (index === 0 ? { ...line, translation: "半" } : line));
  const store = fakeStore();
  /** What the store actually held at the moment a batch landed. */
  let seenMidway: Transcript | undefined;

  const { deps: d } = deps({
    store,
    annotate: async (_t, hooks) => {
      await hooks.onBatch(partial);
      seenMidway = store.state.transcript;
      return translated;
    },
  });

  await startImport(d, { source, title: "ep" }, () => {});

  // Someone listening sees the half-translated Transcript rather than waiting for
  // the whole thing — which is what onBatch is for.
  assert.deepEqual(seenMidway, partial);
  assert.deepEqual(store.state.transcript, translated);
});

test("the duration comes from the Transcript, not the feed's guess", async () => {
  const { deps: d } = deps();
  const resource = await startImport(d, { source, title: "ep", durationSec: 999 }, () => {});
  assert.equal(resource.durationSec, 12.5);
});

test("a YouTube Resource says so rather than failing obscurely", async () => {
  const { deps: d } = deps();
  const resource = await startImport(
    d,
    { source: { kind: "youtube", url: "https://youtu.be/x" }, title: "old" },
    () => {},
  );
  assert.equal(resource.phase, "failed");
  assert.match(resource.failureReason ?? "", /no longer supported/);
});
