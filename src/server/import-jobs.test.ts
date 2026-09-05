import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { ImportPhase, Settings, SourceRef, Transcript } from "../shared/model.ts";
import { createImportJobs } from "./import-jobs.ts";
import { createLibrary } from "./library.ts";
import type { Annotator, ImportJobs, Ingestor, Library, Transcriber } from "./ports.ts";
import { createLocalStorage } from "./storage/local.ts";

const settings: Settings = {
  textModel: { baseUrl: "https://example.com/v1", apiKey: "k", model: "m" },
  transcriptionModel: { baseUrl: "https://example.com/v1", apiKey: "k", model: "whisper" },
  nativeLanguage: "zh-CN",
  targetLanguage: "ja",
};

const youtube: SourceRef = { kind: "youtube", url: "https://youtu.be/abc" };

const transcribed: Transcript = [{ startSec: 0, endSec: 2, text: "自己紹介をします" }];

function stubIngestor(overrides: Partial<Ingestor> = {}): Ingestor {
  return {
    ingest: async (_ref, workDir) => {
      const audioPath = path.join(workDir, "audio.m4a");
      await fs.writeFile(audioPath, "pretend audio");
      return { title: "episode405", durationSec: 1555, audioPath };
    },
    ...overrides,
  };
}

const stubTranscriber = (overrides: Partial<Transcriber> = {}): Transcriber => ({
  transcribe: async () => transcribed,
  ...overrides,
});

const stubAnnotator = (overrides: Partial<Annotator> = {}): Annotator => ({
  annotate: async (lines) => lines.map((line) => ({ ...line, translation: "自我介绍" })),
  ...overrides,
});

/** Waits for the job to reach ready or failed, so tests never poll blindly. */
async function settle(jobs: ImportJobs, id: string): Promise<ImportPhase> {
  let phase: ImportPhase = "queued";
  for await (const state of jobs.watch(id)) phase = state.phase;
  return phase;
}

describe("import jobs", () => {
  let library: Library;
  let build: (parts?: {
    ingestor?: Ingestor;
    transcriber?: Transcriber;
    annotator?: Annotator;
  }) => ImportJobs;

  beforeEach(async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-jobs-"));
    library = createLibrary(createLocalStorage({ rootDir }));
    build = (parts = {}) =>
      createImportJobs({
        library,
        ingestor: parts.ingestor ?? stubIngestor(),
        settings: async () => settings,
        transcriber: () => parts.transcriber ?? stubTranscriber(),
        annotator: () => parts.annotator ?? stubAnnotator(),
      });
  });

  it("puts the Resource on the shelf before any work starts", async () => {
    const jobs = build();
    const job = await jobs.start(youtube);

    assert.equal(job.phase, "queued");
    const shelf = await library.list();
    assert.equal(shelf.length, 1);
    assert.equal(shelf[0]?.id, job.resourceId);
    assert.equal(
      shelf[0]?.title,
      "https://youtu.be/abc",
      "the URL stands in until ingest names it",
    );
  });

  it("uses one identifier for the job and the Resource", async () => {
    const job = await build().start(youtube);
    assert.equal(job.id, job.resourceId);
  });

  it("runs through to a ready Resource with everything attached", async () => {
    const jobs = build();
    const job = await jobs.start(youtube);

    assert.equal(await settle(jobs, job.id), "ready");

    const stored = await library.get(job.resourceId);
    assert.equal(stored?.resource.phase, "ready");
    assert.equal(stored?.resource.title, "episode405");
    assert.equal(stored?.resource.durationSec, 1555);
    assert.equal(stored?.transcript[0]?.translation, "自我介绍");
    assert.equal(stored?.resource.targetLanguage, "ja");
  });

  it("reports each phase in order to a watcher", async () => {
    const jobs = build();
    const job = await jobs.start(youtube);

    const phases: ImportPhase[] = [];
    for await (const state of jobs.watch(job.id)) phases.push(state.phase);

    assert.deepEqual(phases, ["queued", "fetching", "transcribing", "annotating", "ready"]);
  });

  it("keeps a failed import on the shelf, with its reason", async () => {
    const jobs = build({
      ingestor: stubIngestor({
        ingest: async () => {
          throw new Error("video unavailable");
        },
      }),
    });
    const job = await jobs.start(youtube);

    assert.equal(await settle(jobs, job.id), "failed");
    assert.equal(jobs.get(job.id)?.failureReason, "video unavailable");

    const stored = await library.get(job.resourceId);
    assert.equal(stored?.resource.phase, "failed");
    assert.equal(stored?.resource.failureReason, "video unavailable");
  });

  it("keeps the transcript when only annotation fails", async () => {
    const jobs = build({
      annotator: stubAnnotator({
        annotate: async () => {
          throw new Error("model is down");
        },
      }),
    });
    const job = await jobs.start(youtube);

    assert.equal(await settle(jobs, job.id), "failed");
    const stored = await library.get(job.resourceId);
    assert.deepEqual(
      stored?.transcript,
      transcribed,
      "transcription is the expensive step; a translation failure must not discard it",
    );
  });

  it("runs one import at a time", async () => {
    const inFlight: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const jobs = build({
      ingestor: stubIngestor({
        ingest: async (ref, workDir) => {
          inFlight.push("enter");
          if (inFlight.length === 1) await firstStarted;
          inFlight.push("exit");
          const audioPath = path.join(workDir, "audio.m4a");
          await fs.writeFile(audioPath, "pretend audio");
          return { title: "t", durationSec: 1, audioPath };
        },
      }),
    });

    const first = await jobs.start(youtube);
    const second = await jobs.start({ kind: "youtube", url: "https://youtu.be/def" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(inFlight, ["enter"], "the second import must wait its turn");
    releaseFirst();
    await settle(jobs, first.id);
    await settle(jobs, second.id);
    assert.deepEqual(inFlight, ["enter", "exit", "enter", "exit"]);
  });

  it("cleans up its working directory", async () => {
    let workDir = "";
    const jobs = build({
      ingestor: stubIngestor({
        ingest: async (_ref, dir) => {
          workDir = dir;
          const audioPath = path.join(dir, "audio.m4a");
          await fs.writeFile(audioPath, "pretend audio");
          return { title: "t", durationSec: 1, audioPath };
        },
      }),
    });

    const job = await jobs.start(youtube);
    await settle(jobs, job.id);

    await assert.rejects(() => fs.stat(workDir));
  });

  it("knows nothing about an id it never issued", () => {
    assert.equal(build().get("not-a-job"), null);
  });
});
