import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImportPhase, Resource, Settings, SourceRef } from "../shared/model.ts";
import type {
  Annotator,
  ImportJobs,
  Ingestor,
  JobId,
  JobState,
  Library,
  Transcriber,
} from "./ports.ts";

export interface ImportJobsOptions {
  library: Library;
  ingestor: Ingestor;
  /** Read fresh per job, so changing a key or language takes effect without a restart. */
  settings: () => Promise<Settings>;
  transcriber: (settings: Settings) => Transcriber;
  /** May be async: the Japanese analyzer's dictionary is loaded on first Japanese import. */
  annotator: (settings: Settings) => Annotator | Promise<Annotator>;
}

const SETTLED: ReadonlySet<ImportPhase> = new Set<ImportPhase>(["ready", "failed"]);

/**
 * Runs ingest → transcribe → annotate → store as one background job.
 *
 * The Resource reaches the Library before any work starts and is written again at
 * every phase, so an import is visible on the shelf while it runs and stays there,
 * marked failed, if it dies. The job id *is* the Resource id — one identifier, so
 * the UI can watch a job or open a Resource with the same value.
 */
export function createImportJobs(options: ImportJobsOptions): ImportJobs {
  const { library, ingestor } = options;

  // ponytail: jobs live in a Map for the life of the process and run one at a time.
  // Fine for one user watching one import; a restart mid-import loses the queue and
  // leaves that Resource marked failed. A durable queue only earns its keep once
  // restarts during imports are common enough to annoy someone.
  const jobs = new Map<JobId, JobState>();
  const waiters = new Map<JobId, Set<() => void>>();
  let queue: Promise<unknown> = Promise.resolve();

  function publish(id: JobId, changes: Partial<JobState>): JobState {
    const next = { ...(jobs.get(id) as JobState), ...changes };
    jobs.set(id, next);
    for (const wake of waiters.get(id) ?? []) wake();
    waiters.delete(id);
    return next;
  }

  function changed(id: JobId): Promise<void> {
    return new Promise((resolve) => {
      const set = waiters.get(id) ?? new Set();
      set.add(resolve);
      waiters.set(id, set);
    });
  }

  async function run(id: JobId, ref: SourceRef, resource: Resource): Promise<void> {
    const settings = await options.settings();
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-import-"));
    let current = resource;

    // Reaching a terminal phase is what stops a watcher, so nothing may still be
    // pending when it is published: the Library write and the cleanup both finish
    // first, and only then does the job settle.
    const outcome = await (async (): Promise<Partial<JobState>> => {
      try {
        publish(id, { phase: "fetching", progress: undefined });
        current = { ...current, phase: "fetching" };
        await library.save(current);

        const media = await ingestor.ingest(ref, workDir, (fraction) =>
          publish(id, { progress: fraction }),
        );

        current = {
          ...current,
          title: media.title,
          durationSec: media.durationSec,
          phase: "transcribing",
        };
        publish(id, { phase: "transcribing", progress: undefined });
        // Persist the audio as soon as it exists: it is the slowest thing to fetch
        // again, and everything after this point can fail without losing it.
        await library.save(current, { audioPath: media.audioPath });

        const transcript = await options.transcriber(settings).transcribe(media.audioPath, {
          language: settings.targetLanguage,
          onProgress: (fraction) => publish(id, { progress: fraction }),
        });

        current = { ...current, phase: "annotating" };
        publish(id, { phase: "annotating", progress: undefined });
        // Store the bare transcript before annotating. Transcription is the expensive
        // step; a failure in translation must not throw it away.
        await library.save(current, { transcript });

        const annotated = await (
          await options.annotator(settings)
        ).annotate(transcript, {
          nativeLanguage: settings.nativeLanguage,
          targetLanguage: settings.targetLanguage,
          onProgress: (fraction) => publish(id, { progress: fraction }),
        });

        current = { ...current, phase: "ready" };
        await library.save(current, { transcript: annotated });
        return { phase: "ready", progress: 1 };
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        // Left on the shelf rather than swept away: the user should see that it
        // failed, why, and be able to delete or retry it themselves.
        await library
          .save({ ...current, phase: "failed", failureReason })
          .catch(() => undefined);
        return { phase: "failed", failureReason };
      } finally {
        await fs.rm(workDir, { recursive: true, force: true });
      }
    })();

    publish(id, outcome);
  }

  return {
    async start(ref: SourceRef): Promise<JobState> {
      const settings = await options.settings();
      const id = randomUUID();
      const resource: Resource = {
        id,
        source: ref,
        // Replaced with the real title once ingest reports it.
        title: ref.kind === "podcast" ? ref.title : ref.url,
        durationSec: 0,
        targetLanguage: settings.targetLanguage,
        nativeLanguage: settings.nativeLanguage,
        importedAt: new Date().toISOString(),
        phase: "queued",
      };

      jobs.set(id, { id, resourceId: id, phase: "queued" });
      await library.save(resource);

      const work = () => run(id, ref, resource);
      queue = queue.then(work, work);
      return jobs.get(id) as JobState;
    },

    get(id: JobId): JobState | null {
      return jobs.get(id) ?? null;
    },

    async *watch(id: JobId): AsyncIterable<JobState> {
      let previous: JobState | undefined;
      for (;;) {
        // Subscribe before reading, or an update landing between the two would be
        // missed and the watcher would hang until the next one.
        const pending = changed(id);
        const current = jobs.get(id);
        if (!current) return;
        if (current !== previous) {
          previous = current;
          yield current;
        }
        if (SETTLED.has(current.phase)) return;
        await pending;
      }
    },
  };
}
