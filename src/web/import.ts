import type {
  ImportPhase,
  LanguageCode,
  Resource,
  ResourceId,
  SourceRef,
  Transcript,
} from "../shared/model.ts";

/**
 * ingest → transcribe, in the tab rather than on a server (ADR 0008).
 *
 * Translation used to be the third step here, and an episode was not playable until
 * every Line of it had been through the Text Model. It now happens while someone is
 * listening, around wherever they are (ADR 0011) — so this ends at a Transcript, and
 * an import is done when there are Lines to play against.
 *
 * What did not change is that a retry resumes and never restarts. A stored Transcript
 * means there is nothing left to do; stored audio means skip the download. Restarting
 * instead would pay the transcription bill again to recover from a failed download,
 * making the cheapest failure the most expensive one.
 */

export interface ImportDeps {
  /**
   * Transcribes the audio this browser has already stored. The Blob knows its own
   * size, so nothing probes the origin for one — and the size it reports is the size
   * of the recording that will actually be kept, which a separate probe could not
   * promise.
   *
   * `episodeUrl` is still here because an episode over the endpoint's request limit
   * is still chunked by asking the proxy for byte ranges. That path keeps the
   * mismatch this ordering was changed to fix; slicing the Blob locally would settle
   * it too, and is deliberately left for later.
   */
  /**
   * Absent when no Transcription Model is configured, and that is a supported way to
   * import rather than an oversight. Downloading an episode needs the proxy; turning
   * it into Lines needs somebody's API key, and the two are separate decisions. With
   * this missing the import keeps the audio and stops at `untranscribed`, which a
   * later Resume picks up — by then the download is already paid for.
   */
  transcribe?(
    episodeUrl: string,
    audio: Blob,
    onProgress: (fraction: number) => void,
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
  /** The feed's title and cover, kept on the Resource for the shelf and the player. */
  showTitle?: string;
  artworkUrl?: string;
}

/**
 * Which Resources this page is importing right now.
 *
 * The shelf used to answer that from a Set inside its own component, which the
 * player's Retry transcription never joined — so an episode being transcribed from
 * the player was offered a Resume beside it on the shelf, and taking it billed the
 * same episode a second time. Measured before this existed: two POSTs to
 * `/audio/transcriptions` for one episode, provably in flight at once. The store is
 * no help there either, because both runs read it before either has anything to
 * write.
 *
 * It lives here because `run` is where every entry point already converges, and one
 * registry is the fix for a bug that was two registries disagreeing.
 *
 * Per page, like everything else in this architecture (ADR 0008): a second tab is a
 * second copy of all of this and shares only IndexedDB. Covering that means a lease
 * written to the store and refreshed while an import runs, which is a write every few
 * seconds against a tab nobody has opened.
 */
const running = new Set<ResourceId>();

/** Whether this page is importing that Resource — what makes an offer to resume real. */
export const isImporting = (id: ResourceId): boolean => running.has(id);

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
    ...(input.showTitle && { showTitle: input.showTitle }),
    ...(input.artworkUrl && { artworkUrl: input.artworkUrl }),
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
  // Not "already finished" — already *going*, which the phase cannot say: a Resource
  // reads `transcribing` whether something is driving it or whether a reload walked
  // away from it, and only this knows which.
  if (running.has(start.id)) {
    throw new Error("That episode is already being imported. Wait for it to finish.");
  }
  running.add(start.id);

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

    // Audio first, and the ordering is the point rather than a detail. It used to come
    // second, back when transcription let the endpoint fetch the audio for itself —
    // until one real episode arrived as 412.5 seconds here and 449.8 at the provider,
    // each carrying different advertising, *both* fetched through the proxy. A Worker
    // runs at whichever edge a request entered, so the origin sees a different region
    // per caller, and this host varies its ad load by region. Pinning a User-Agent
    // cannot reach that. The Transcript now describes the recording that was kept,
    // because it is made from it.
    let audio = await deps.store.getAudio(current.id);
    if (!audio) {
      await advance("fetching");
      audio = await deps.fetchAudio(episodeUrl);
      // Stored before transcribing: it is the slowest thing to fetch again, and
      // everything after this point can fail without losing it.
      await deps.store.save({ resource: current, audio });
    }
    // Recorded on the Resource, not inferred from the phase later: everything below
    // here can fail, and the shelf still has to know this episode plays. Set on the
    // resume path too, so a Resource from before this field heals when it is retried.
    current = { ...current, hasAudio: true };

    if (!transcript) {
      const makeTranscript = deps.transcribe;
      if (!makeTranscript) {
        // The audio is stored and the episode plays; there is simply no model to make
        // Lines with. Stopping here rather than throwing is what keeps "listen now,
        // transcribe later" off the shelf as a failed import — and this phase is what
        // a Resume aims at once a model is filled in.
        await advance("untranscribed");
        onProgress({ phase: "untranscribed", progress: 1 });
        return current;
      }

      await advance("transcribing");
      transcript = await makeTranscript(episodeUrl, audio, (progress) =>
        onProgress({ phase: "transcribing", progress }),
      );
      // Saved bare, before the shelf is told the import finished. Transcription is
      // the expensive step, and this is what lets a later retry skip straight past it.
      current = { ...current, durationSec: endOf(transcript) || current.durationSec };
      await deps.store.save({ resource: current, transcript });
    }

    current = { ...current, phase: "ready" };
    await deps.store.save({ resource: current, transcript });
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
  } finally {
    running.delete(start.id);
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
