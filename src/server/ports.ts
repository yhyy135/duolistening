// The seams of the server half. Each interface is deliberately small; what makes
// them worth having is the amount of work hidden behind them.
//
// Per the design rule "one adapter is a hypothetical seam, two is a real one":
// Storage genuinely has two production adapters (local filesystem, S3) and Ingestor
// has two (YouTube, podcast). The rest exist as single implementations plus a test
// fake — enough to keep them honest, not an invitation to build a plugin system.

import type {
  Episode,
  JobId,
  JobState,
  LanguageCode,
  Resource,
  ResourceId,
  SourceRef,
  Token,
  Transcript,
} from "../shared/model.ts";

/** Reports 0..1 through a long-running phase, when that phase can tell. */
export type ProgressFn = (fraction: number) => void;

/**
 * Everything that outlives the process, behind one seam (ADR 0007): settings,
 * Resource metadata, Transcripts and audio. Adapters: local filesystem, S3.
 *
 * Keys are the paths in `storageKeys`. Documents are JSON; media are opaque blobs
 * that never pass through this process's memory in one piece.
 */
export interface Storage {
  /** Null when the key does not exist — a missing document is not an error. */
  readDoc<T>(key: string): Promise<T | null>;
  writeDoc<T>(key: string, value: T): Promise<void>;
  listDocKeys(prefix: string): Promise<string[]>;
  /** Idempotent: deleting an absent key succeeds. */
  deleteObject(key: string): Promise<void>;

  writeMedia(key: string, localPath: string): Promise<void>;
  readMediaToFile(key: string, destPath: string): Promise<void>;

  /**
   * A URL the browser's <audio> can stream and seek within. The local adapter
   * returns a route on this server that honours HTTP Range; the S3 adapter returns
   * a presigned URL so the bytes never touch us. May expire — fetch it when needed
   * rather than persisting it.
   */
  playbackUrl(key: string): Promise<string>;
}

export interface IngestedMedia {
  title: string;
  durationSec: number;
  /** Audio file inside the caller's workDir, normalised to one codec. */
  audioPath: string;
}

/**
 * Turns a SourceRef into a local audio file. Adapters: YouTube (yt-dlp) and
 * podcast (HTTP fetch of the enclosure). Hides tool flags, redirects, timeouts and
 * container/codec normalisation.
 *
 * Slow — minutes for a long episode. Throws with a machine-readable reason
 * (unavailable, geo-blocked, network) so the phase can be reported to the user.
 */
export interface Ingestor {
  ingest(ref: SourceRef, workDir: string, onProgress?: ProgressFn): Promise<IngestedMedia>;
}

/**
 * Browsing a podcast feed, kept out of Ingestor on purpose: listing episodes has
 * no YouTube counterpart, and forcing both through one interface would bend it.
 */
export interface PodcastFeed {
  listEpisodes(feedUrl: string): Promise<{ feedTitle: string; episodes: Episode[] }>;
}

export interface Silence {
  startSec: number;
  endSec: number;
}

/**
 * The audio operations the Transcriber needs, behind a seam so its chunking logic
 * can be tested without ffmpeg installed. Production adapter shells out to
 * ffmpeg/ffprobe; tests supply canned answers.
 */
export interface AudioTool {
  durationSec(path: string): Promise<number>;
  /** Quiet stretches, so a cut can land between sentences rather than inside one. */
  detectSilences(path: string): Promise<Silence[]>;
  /** Writes `[startSec, endSec)` of `source` to `destPath` as its own playable file. */
  extract(source: string, startSec: number, endSec: number, destPath: string): Promise<void>;
}

/** One piece of what an ASR endpoint returned, before it is offset onto the timeline. */
export interface RawSegment {
  startSec: number;
  endSec: number;
  text: string;
  words?: { text: string; startSec: number; endSec: number }[];
}

/**
 * A single call to the Transcription Model slot. Separate from Transcriber so that
 * chunking and stitching can be tested without a network or an API key.
 */
export interface SpeechToText {
  transcribeChunk(audioPath: string, language: LanguageCode): Promise<RawSegment[]>;
}

/**
 * The deepest module here: an audio file becomes ordered Lines covering it.
 *
 * Behind this one method sit silence-aware chunking against the endpoint's size
 * ceiling (ADR 0003), per-chunk transcription calls, offsetting each chunk's
 * timestamps back onto one timeline, stitching, retries, and normalising away
 * whether the endpoint returned word-level timestamps at all (ADR 0004) — callers
 * always get the same shape.
 *
 * Expensive: bills the user per call and runs for minutes.
 */
export interface Transcriber {
  transcribe(
    audioPath: string,
    opts: { language: LanguageCode; onProgress?: ProgressFn },
  ): Promise<Transcript>;
}

/**
 * Splits Japanese text into Tokens carrying part-of-speech and kana reading
 * (ADR 0005). Synchronous and offline once built — building it reads a dictionary
 * of tens of megabytes, so build one at startup and share it.
 */
export interface JapaneseTokenizer {
  tokenize(text: string): Token[];
}

/**
 * Fills in each Line's translation, and its tokens when the target language is
 * Japanese (ADR 0005). Whether Japanese is special is this module's business, not
 * its caller's.
 *
 * Returns new Lines; never mutates the input.
 */
export interface Annotator {
  annotate(
    lines: Transcript,
    opts: {
      nativeLanguage: LanguageCode;
      targetLanguage: LanguageCode;
      onProgress?: ProgressFn;
    },
  ): Promise<Transcript>;
}

/**
 * The configured Text Model slot. Shared by the Annotator (translation) and the
 * ask-AI popup — which is what earns it its own seam: delete it and auth, retry,
 * error normalisation and JSON repair get written twice.
 */
export interface TextModel {
  complete(prompt: string): Promise<string>;
  /** Retries once with a repair prompt when the model returns unparseable JSON. */
  completeJson<T>(prompt: string): Promise<T>;
}

/**
 * The Library: everything imported, kept until deleted by hand.
 *
 * `remove` cascades — index entry, metadata, Transcript and audio — because a
 * half-delete leaves blobs nobody can reach but the bucket still charges for.
 *
 * ponytail: writes to the index document are serialised by an in-process mutex,
 * which holds for one process serving one user and breaks under multi-instance
 * deployment. Move the index into a real store if that day comes.
 */
export interface Library {
  list(): Promise<Resource[]>;
  /** Null when the id is not in the Library. A Resource still importing has no
   *  Transcript yet, and comes back with an empty one rather than null. */
  get(id: ResourceId): Promise<{ resource: Resource; transcript: Transcript } | null>;
  /**
   * Upsert. An import calls this repeatedly as it progresses — first with the
   * Resource alone, later with the audio, finally with the Transcript and a ready
   * phase — so a half-finished import is visible in the Library instead of hiding
   * until it succeeds.
   */
  save(
    resource: Resource,
    parts?: { transcript?: Transcript; audioPath?: string },
  ): Promise<void>;
  remove(id: ResourceId): Promise<void>;
  /** No-op for an unknown id: a delete racing a position save must not throw. */
  savePosition(id: ResourceId, seconds: number): Promise<void>;
}

// Part of the wire contract, so it lives in shared/model.ts; re-exported here
// because every server-side caller reaches for the seams through this file.
export type { JobId, JobState } from "../shared/model.ts";

/**
 * Runs ingest → transcribe → annotate → store as one background job, so the HTTP
 * layer never holds a request open for the minutes this takes.
 *
 * Jobs run one at a time in memory; a restart loses in-flight jobs, and the
 * half-finished Resource is left in a failed phase rather than pretending to be
 * ready. ponytail: an in-memory queue is the ceiling here — a durable queue only
 * matters once restarts mid-import are common enough to annoy someone.
 */
export interface ImportJobs {
  start(ref: SourceRef): Promise<JobState>;
  get(id: JobId): JobState | null;
  /** Yields on every state change until the job settles. Drives the SSE endpoint. */
  watch(id: JobId): AsyncIterable<JobState>;
}
