import type {
  ImportPhase,
  LanguageCode,
  Resource,
  ResourceId,
  SourceRef,
  Transcript,
} from "../shared/model.ts";

/**
 * ingest → transcribe → annotate, in the tab rather than on a server (ADR 0008).
 *
 * The shape changed with the architecture. Audio used to be downloaded first because
 * transcription read it off a disk; now the endpoint fetches its own slices through
 * the proxy (ADR 0010) and the browser never holds the audio to transcribe it at all.
 * So the download moved to where it is actually needed — playback — and the expensive
 * artifact, the Transcript, is reached and saved sooner.
 *
 * What did not change is that a retry resumes and never restarts. A stored Transcript
 * means annotate only; stored audio means skip the download. Restarting instead would
 * pay the transcription bill again to recover from a rate-limited translation, making
 * the cheapest failure the most expensive one.
 */

export interface ImportDeps {
  /** Total bytes of the episode, measured through the proxy — see `proxy.ts`. */
  totalBytes(episodeUrl: string): Promise<number>;
  /** Chunked transcription; every byte travels proxy-to-endpoint. */
  transcribe(
    episodeUrl: string,
    totalBytes: number,
    onProgress: (fraction: number) => void,
  ): Promise<Transcript>;
  /** Translation, and Japanese Tokens when the text turns out to want them. */
  annotate(
    transcript: Transcript,
    hooks: { onProgress: (f: number) => void; onBatch: (partial: Transcript) => Promise<void> },
  ): Promise<Transcript>;
  /** The audio itself, for playback — already labelled with its true content type. */
  fetchAudio(episodeUrl: string): Promise<Blob>;

  store: {
    save(entry: { resource: Resource; transcript?: Transcript; audio?: Blob }): Promise<void>;
    getTranscript(id: ResourceId): Promise<Transcript | undefined>;
    getAudio(id: ResourceId): Promise<Blob | undefined>;
  };

  nativeLanguage: LanguageCode;
  targetLanguage?: LanguageCode;
  newId(): ResourceId;
  now(): string;
}

export interface ImportProgress {
  phase: ImportPhase;
  /** Absent while a phase has nothing to report — a probe, or a batch not yet landed. */
  progress?: number;
}

export interface StartInput {
  source: SourceRef;
  title: string;
  /** Known from the feed before anything is fetched; corrected once transcribed. */
  durationSec?: number;
}

/** Starts a new import. The Resource appears on the shelf before any work begins. */
export async function startImport(
  deps: ImportDeps,
  input: StartInput,
  onProgress: (state: ImportProgress) => void,
): Promise<Resource> {
  const resource: Resource = {
    id: deps.newId(),
    source: input.source,
    title: input.title,
    durationSec: input.durationSec ?? 0,
    nativeLanguage: deps.nativeLanguage,
    ...(deps.targetLanguage && { targetLanguage: deps.targetLanguage }),
    importedAt: deps.now(),
    phase: "queued",
  };
  await deps.store.save({ resource });
  return run(deps, resource, onProgress);
}

/**
 * Picks a failed or abandoned import back up. Whatever survived decides where it
 * starts, which is the entire point: a Transcript that already exists is never made
 * twice.
 */
export async function retryImport(
  deps: ImportDeps,
  resource: Resource,
  onProgress: (state: ImportProgress) => void,
): Promise<Resource> {
  if (resource.phase === "ready") {
    // Re-importing would discard a Transcript that cost money. Deleting and importing
    // again is the way to redo one, and it is deliberately a separate decision.
    throw new Error("That episode is already finished. Delete it to import it again.");
  }
  return run(deps, resource, onProgress);
}

async function run(
  deps: ImportDeps,
  start: Resource,
  onProgress: (state: ImportProgress) => void,
): Promise<Resource> {
  // A retry clears last time's reason as it starts, so the shelf never shows a stale
  // failure beside this run's progress.
  let current: Resource = { ...start, failureReason: undefined };

  const advance = async (phase: ImportPhase, extra?: Partial<Resource>) => {
    current = { ...current, ...extra, phase };
    await deps.store.save({ resource: current });
    onProgress({ phase });
  };

  try {
    const episodeUrl = audioUrlOf(current.source);
    let transcript = await deps.store.getTranscript(current.id);

    if (!transcript) {
      await advance("transcribing");
      const total = await deps.totalBytes(episodeUrl);
      transcript = await deps.transcribe(episodeUrl, total, (progress) =>
        onProgress({ phase: "transcribing", progress }),
      );
      // Saved bare, before anything else can fail. Transcription is the expensive
      // step, and this is also what lets a later retry skip straight past it.
      current = { ...current, durationSec: endOf(transcript) || current.durationSec };
      await deps.store.save({ resource: current, transcript });
    }

    // Before annotating rather than after: someone can start listening as soon as
    // there is audio and a Transcript, and the translations fill in underneath them.
    if (!(await deps.store.getAudio(current.id))) {
      await advance("fetching");
      // Captured now rather than streamed at playback, and not only for offline use.
      // One real host splices advertising per fetch — the same episode came back
      // thirty seconds longer to a different client — so audio fetched next week
      // would sit a whole ad break away from the timestamps made from it today.
      const audio = await deps.fetchAudio(episodeUrl);
      await deps.store.save({ resource: current, audio });
    }

    await advance("annotating");
    const annotated = await deps.annotate(transcript, {
      onProgress: (progress) => onProgress({ phase: "annotating", progress }),
      // Each batch as it lands, not just the finished article: the Resource is
      // already playable, so translations appear while it is being listened to.
      onBatch: (partial) => deps.store.save({ resource: current, transcript: partial }),
    });

    current = { ...current, phase: "ready" };
    await deps.store.save({ resource: current, transcript: annotated });
    onProgress({ phase: "ready", progress: 1 });
    return current;
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    // Left on the shelf rather than swept away: the reader should see that it failed,
    // why, and be able to retry or delete it themselves.
    current = { ...current, phase: "failed", failureReason };
    await deps.store.save({ resource: current }).catch(() => undefined);
    onProgress({ phase: "failed" });
    return current;
  }
}

/** Where the audio actually lives, whatever kind of source this is. */
function audioUrlOf(source: SourceRef): string {
  if (source.kind === "podcast") return source.episodeUrl;
  // ADR 0009 dropped YouTube with yt-dlp; a Resource of that kind can only be one
  // imported before the change, and it has no URL anything here can fetch.
  throw new Error("YouTube imports are no longer supported.");
}

/** The last timestamp, which is a better duration than a feed's own guess. */
function endOf(transcript: Transcript): number {
  return transcript.at(-1)?.endSec ?? 0;
}
