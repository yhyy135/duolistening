import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { ImportPhase, Settings, SourceRef, Transcript } from "../shared/model.ts";
import { createImportJobs } from "./import-jobs.ts";
import { createLibrary } from "./library.ts";
import type {
  Annotator,
  ImportJobs,
  Ingestor,
  Library,
  Storage,
  Transcriber,
} from "./ports.ts";
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

/** Wraps a stub so a test can assert a resume never reached it. */
function counting<T extends object>(inner: T, calls: string[], name: string): T {
  return new Proxy(inner, {
    get: (target, key, receiver) => {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(name);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

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
  /** Counted so a resume can be shown not to re-upload audio it already had. */
  let mediaWrites: number;
  let build: (parts?: {
    ingestor?: Ingestor;
    transcriber?: Transcriber;
    annotator?: Annotator;
  }) => ImportJobs;

  beforeEach(async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-jobs-"));
    mediaWrites = 0;
    const disk = createLocalStorage({ rootDir });
    const counted: Storage = {
      ...disk,
      writeMedia: (key, localPath) => {
        mediaWrites++;
        return disk.writeMedia(key, localPath);
      },
    };
    library = createLibrary(counted);
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

  describe("retry", () => {
    /** Fails at one step, so the retry has something to resume from. */
    const failing = { message: "the provider had a moment" };

    it("resumes from a stored Transcript when only annotation failed", async () => {
      const steps: string[] = [];
      const ingestor = counting(stubIngestor(), steps, "ingest");
      const transcriber = counting(stubTranscriber(), steps, "transcribe");

      const first = build({
        ingestor,
        transcriber,
        annotator: stubAnnotator({
          annotate: async () => {
            throw new Error(failing.message);
          },
        }),
      });
      const job = await first.start(youtube);
      assert.equal(await settle(first, job.id), "failed");
      assert.deepEqual(steps, ["ingest", "transcribe"]);

      // A fresh instance, because a restart is the other way to arrive here.
      const second = build({ ingestor, transcriber });
      const resumed = await second.retry(job.resourceId);
      assert.ok(resumed);
      assert.equal(await settle(second, resumed.id), "ready");

      assert.deepEqual(
        steps,
        ["ingest", "transcribe"],
        "neither the download nor the transcription bill is paid twice",
      );
      const stored = await library.get(job.resourceId);
      assert.equal(stored?.resource.phase, "ready");
      assert.equal(stored?.transcript[0]?.translation, "自我介绍");
    });

    it("resumes from stored audio when transcription failed", async () => {
      const steps: string[] = [];
      const ingestor = counting(stubIngestor(), steps, "ingest");

      const first = build({
        ingestor,
        transcriber: stubTranscriber({
          transcribe: async () => {
            throw new Error(failing.message);
          },
        }),
      });
      const job = await first.start(youtube);
      assert.equal(await settle(first, job.id), "failed");
      assert.equal(mediaWrites, 1, "the audio was stored before transcription was attempted");

      const second = build({ ingestor });
      const resumed = await second.retry(job.resourceId);
      assert.ok(resumed);
      assert.equal(await settle(second, resumed.id), "ready");

      assert.deepEqual(steps, ["ingest"], "the audio was restored, not downloaded again");
      assert.equal(mediaWrites, 1, "and it was not written back over itself");
      assert.equal((await library.get(job.resourceId))?.resource.phase, "ready");
    });

    it("fetches again when the import died before any audio was stored", async () => {
      const steps: string[] = [];
      let attempt = 0;
      const ingestor = counting(
        stubIngestor({
          ingest: async (ref, workDir) => {
            if (++attempt === 1) throw new Error("video unavailable");
            const audioPath = path.join(workDir, "audio.m4a");
            await fs.writeFile(audioPath, "pretend audio");
            return { title: "episode405", durationSec: 1555, audioPath };
          },
        }),
        steps,
        "ingest",
      );

      const jobs = build({ ingestor });
      const job = await jobs.start(youtube);
      assert.equal(await settle(jobs, job.id), "failed");

      const resumed = await jobs.retry(job.resourceId);
      assert.ok(resumed);
      assert.equal(await settle(jobs, resumed.id), "ready");
      assert.deepEqual(steps, ["ingest", "ingest"], "nothing survived, so it starts over");
      assert.equal((await library.get(job.resourceId))?.resource.title, "episode405");
    });

    it("clears the previous failure reason as it starts", async () => {
      const jobs = build({
        annotator: stubAnnotator({
          annotate: async () => {
            throw new Error(failing.message);
          },
        }),
      });
      const job = await jobs.start(youtube);
      await settle(jobs, job.id);
      assert.equal(
        (await library.get(job.resourceId))?.resource.failureReason,
        failing.message,
      );

      // One instance, or `settle` would watch a job map that never heard of this id
      // and return before the retry had written anything.
      const second = build();
      const resumed = await second.retry(job.resourceId);
      assert.ok(resumed);
      assert.equal(await settle(second, resumed.id), "ready");

      const stored = await library.get(job.resourceId);
      assert.equal(
        stored?.resource.failureReason,
        undefined,
        "last time's reason must not sit next to this time's progress",
      );
    });

    it("refuses a Resource that already imported", async () => {
      const jobs = build();
      const job = await jobs.start(youtube);
      assert.equal(await settle(jobs, job.id), "ready");

      assert.equal(
        await jobs.retry(job.resourceId),
        null,
        "re-importing would discard a Transcript that cost money — that is a delete",
      );
    });

    it("refuses an id that is not in the Library", async () => {
      assert.equal(await build().retry("never-existed"), null);
    });

    it("hands back the running job rather than starting a second one", async () => {
      const steps: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const jobs = build({
        ingestor: counting(
          stubIngestor({
            ingest: async (_ref, workDir) => {
              await held;
              const audioPath = path.join(workDir, "audio.m4a");
              await fs.writeFile(audioPath, "pretend audio");
              return { title: "episode405", durationSec: 1555, audioPath };
            },
          }),
          steps,
          "ingest",
        ),
      });

      const job = await jobs.start(youtube);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const again = await jobs.retry(job.resourceId);
      assert.equal(again?.id, job.id, "the live job, not a new one");

      release();
      assert.equal(await settle(jobs, job.id), "ready");
      assert.deepEqual(
        steps,
        ["ingest"],
        "two jobs on one Resource would fight over the shelf",
      );
    });
  });
});
