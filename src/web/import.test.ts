import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource, Transcript } from "../shared/model.ts";
import { retryImport, startImport, type ImportDeps, type ImportProgress } from "./import.ts";

const bare: Transcript = [
  { text: "one", startSec: 0, endSec: 5 },
  { text: "two", startSec: 5, endSec: 12.5 },
];

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
    transcribe: async (_url, audio, onProgress) => {
      // Recorded with its size, because the bytes handed over must be the bytes the
      // store kept — that identity is the whole reason audio is fetched before this.
      called.push(`transcribe(${audio.size})`);
      onProgress(0.5);
      return bare;
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

  // Audio first: the Transcript is made from the bytes that were kept, rather than
  // from whatever the provider happened to fetch for itself. And it ends there —
  // translation happens while listening now (ADR 0011), so an import is done once
  // there are Lines to play against.
  assert.deepEqual(called, ["fetchAudio", "transcribe(3)"]);
  assert.equal(resource.phase, "ready");
  assert.deepEqual(store.state.transcript, bare);
  assert.equal(store.state.audio?.type, "audio/mpeg");
  assert.deepEqual(
    seen.map((s) => s.phase),
    ["fetching", "transcribing", "transcribing", "ready"],
  );
});

test("an untranslated Transcript is what ready means", async () => {
  const { deps: d, store } = deps();
  await startImport(d, { source, title: "ep" }, () => {});

  // Nothing here calls a Text Model at all: the import's only bill is transcription.
  assert.equal(
    store.state.transcript?.some((line) => line.translation),
    false,
  );
});

test("the Resource is on the shelf before any work starts", async () => {
  const { deps: d, store } = deps({
    fetchAudio: async () => {
      // By the time the first real call happens, the shelf already knows about it.
      assert.equal(store.state.resource?.id, "r1");
      assert.equal(store.state.resource?.phase, "fetching");
      return new Blob(["MP3"], { type: "audio/mpeg" });
    },
  });
  await startImport(d, { source, title: "ep" }, () => {});
});

test("a retry never transcribes a Transcript that already exists", async () => {
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

  assert.deepEqual(called, [], "paid the transcription bill twice");
  assert.equal(resource.phase, "ready");
  assert.equal(resource.failureReason, undefined, "last time's reason cleared");
});

test("a retry with a Transcript but no audio fetches only the audio", async () => {
  const store = fakeStore({ transcript: bare });
  const { deps: d, called } = deps({ store });
  const failed: Resource = {
    id: "r1",
    source,
    title: "ep",
    durationSec: 12.5,
    nativeLanguage: "zh-CN",
    importedAt: "2026-09-08T00:00:00.000Z",
    phase: "failed",
  };

  await retryImport(d, failed, () => {});

  // No transcribe: the Transcript already existed, and paying for it twice to
  // recover a missing download is exactly what a resume must not do.
  assert.deepEqual(called, ["fetchAudio"]);
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
    id: "r1",
    source,
    title: "ep",
    durationSec: 12.5,
    nativeLanguage: "zh-CN",
    importedAt: "2026-09-08T00:00:00.000Z",
    phase: "ready",
  };

  await assert.rejects(
    retryImport(d, ready, () => {}),
    /Delete it to import it again/,
  );
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

test("with no Transcription Model the audio is kept and the import rests untranscribed", async () => {
  // The slot is empty, so pipeline.ts hands over no `transcribe` at all. Downloading
  // needs the proxy; making Lines needs somebody's API key, and they are separate
  // decisions — an episode imported this way plays, it just has nothing to read.
  const { deps: d, called, store } = deps({ transcribe: undefined });
  const { seen, onProgress } = collect();

  const resource = await startImport(d, { source, title: "ep" }, onProgress);

  assert.deepEqual(called, ["fetchAudio"]);
  assert.equal(resource.phase, "untranscribed");
  assert.equal(resource.failureReason, undefined, "not a failure: the episode plays");
  assert.equal(store.state.audio?.type, "audio/mpeg");
  assert.equal(store.state.transcript, undefined);
  assert.deepEqual(
    seen.map((state) => state.phase),
    ["fetching", "untranscribed", "untranscribed"],
  );
});

test("resuming an untranscribed import transcribes without downloading again", async () => {
  // The point of resting in a phase rather than finishing as `ready`: the expensive
  // half is already bought, and filling in a model later must not buy it twice.
  const store = fakeStore({ audio: new Blob(["MP3"], { type: "audio/mpeg" }) });
  const { deps: d, called } = deps({ store });
  const resting: Resource = {
    id: "r1",
    source,
    title: "ep",
    durationSec: 0,
    nativeLanguage: "zh-CN",
    importedAt: "2026-09-08T00:00:00.000Z",
    phase: "untranscribed",
  };

  const resource = await retryImport(d, resting, () => undefined);

  assert.deepEqual(called, ["transcribe(3)"], "the download is not paid for twice");
  assert.equal(resource.phase, "ready");
  assert.deepEqual(store.state.transcript, bare);
});

test("a transcription that fails still leaves an episode that plays", async () => {
  // The download succeeded and the bytes are in the store; only the model call failed.
  // `failed` alone cannot say that, which is what `hasAudio` is for — without it the
  // shelf refuses to open an episode it already holds.
  const { deps: d, store } = deps({
    transcribe: async () => {
      throw new Error("Could not reach the transcription endpoint");
    },
  });

  const resource = await startImport(d, { source, title: "ep" }, () => undefined);

  assert.equal(resource.phase, "failed");
  assert.equal(resource.hasAudio, true);
  assert.match(resource.failureReason ?? "", /transcription endpoint/);
  assert.equal(store.state.audio?.type, "audio/mpeg");
});
