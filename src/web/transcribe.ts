import type { Line, Transcript } from "../shared/model.ts";

/**
 * Chunking and stitching, per ADR 0010.
 *
 * Under the endpoint's request limit an episode goes over whole and none of this
 * runs. Over it, the browser asks the proxy for byte ranges — audio is never decoded
 * and ffmpeg is not involved at any size — and the seam between two chunks is placed
 * by the ASR itself rather than by looking for silence.
 *
 * The planning below is pure so it can be tested without a network: it is where a
 * mistake is invisible, since a misplaced seam produces a Transcript that looks fine
 * and is wrong by a sentence.
 */

/** One piece of what the endpoint returned, before it is offset onto the timeline. */
export interface RawSegment {
  startSec: number;
  endSec: number;
  text: string;
  words?: { text: string; startSec: number; endSec: number }[];
}

export interface Chunk {
  /** Inclusive, as HTTP Range means it. */
  startByte: number;
  endByte: number;
  /** Where this chunk begins on the finished timeline. */
  startSec: number;
}

export interface ChunkResult {
  chunk: Chunk;
  /** What the endpoint said this chunk's own duration was. */
  durationSec: number;
  segments: RawSegment[];
}

/**
 * 25MB is what the endpoint accepts, and it is a byte limit rather than a duration
 * one: 26 minutes of 128kbps audio, 17 of 192kbps. Source bytes are already the most
 * compact form available — decoding to 16kHz mono WAV, which is what the endpoint
 * resamples to anyway, would double the rate to 32KB/s and halve what fits.
 */
export const REQUEST_LIMIT_BYTES = 25 * 1024 * 1024;

/**
 * A trailing chunk shorter than this is folded into its predecessor by splitting the
 * remainder down the middle instead. ADR 0003 found the reason and it still holds:
 * a few seconds stranded in a chunk of their own is a clip short enough for an ASR
 * to hallucinate text onto, and halving costs no extra request.
 */
const MIN_TRAILING_FRACTION = 1.5;

export function planFirst(totalBytes: number, limit = REQUEST_LIMIT_BYTES): Chunk {
  return { startByte: 0, endByte: Math.min(totalBytes, limit) - 1, startSec: 0 };
}

/** Whether the whole episode fits in one request, in which case none of the rest runs. */
export const fitsWhole = (totalBytes: number, limit = REQUEST_LIMIT_BYTES) =>
  totalBytes <= limit;

/**
 * Where the next chunk starts, read off the last one's own transcript.
 *
 * The seam lands at the end of the last *complete* segment, and completeness is not
 * guessed: the final segment of a chunk was cut mid-sentence by construction, so it
 * is always dropped and the one before it ends the chunk. A few seconds get
 * transcribed twice, which against 25MB is not worth a cleverer rule.
 *
 * Time becomes a byte offset through the rate this chunk just demonstrated — its own
 * byte count over the duration the endpoint reported — so nothing here parses a
 * frame header. For constant bitrate that rate is exact; for variable it is an
 * estimate that the next chunk's own reported duration corrects, so error is bounded
 * per chunk rather than accumulating down the file.
 */
export function planNext(
  done: ChunkResult,
  totalBytes: number,
  limit = REQUEST_LIMIT_BYTES,
): Chunk | null {
  // A chunk that already reached the end of the file is the last one, and its final
  // segment is the end of the episode rather than a sentence cut in half. Without
  // this the seam rule would drop that segment and plan a chunk to re-transcribe the
  // tail — paying twice for audio and stitching the same words in again.
  if (done.chunk.endByte >= totalBytes - 1) return null;

  const cutSec = seamSec(done);
  const bytes = done.chunk.endByte - done.chunk.startByte + 1;
  const perSecond = bytes / done.durationSec;
  const startByte = done.chunk.startByte + Math.round(cutSec * perSecond);

  // A seam at or past the end means the last chunk covered the rest of the file.
  if (!Number.isFinite(startByte) || startByte >= totalBytes) return null;

  const remaining = totalBytes - startByte;
  const length =
    remaining <= limit
      ? remaining
      : remaining <= limit * MIN_TRAILING_FRACTION
        ? Math.ceil(remaining / 2)
        : limit;

  return {
    startByte,
    endByte: startByte + length - 1,
    startSec: done.chunk.startSec + cutSec,
  };
}

/** The last complete segment's end, or the whole chunk when there is nothing to drop. */
function seamSec(done: ChunkResult): number {
  const complete = done.segments.slice(0, -1);
  return complete.at(-1)?.endSec ?? done.durationSec;
}

/**
 * The segments a chunk contributes: all of them for the final chunk, all but the
 * truncated last one otherwise — the same one `planNext` cut in front of, so the
 * chunk that follows re-transcribes it properly rather than leaving it clipped.
 */
export function keptSegments(done: ChunkResult, isFinal: boolean): RawSegment[] {
  if (isFinal || done.segments.length < 2) return done.segments;
  return done.segments.slice(0, -1);
}

/**
 * Every chunk's clock starts at zero; this puts them all back on one timeline and
 * turns them into Lines.
 */
export function stitch(results: ChunkResult[]): Transcript {
  const lines: Line[] = [];
  for (const [index, result] of results.entries()) {
    const isFinal = index === results.length - 1;
    for (const segment of keptSegments(result, isFinal)) {
      lines.push(toLine(shift(segment, result.chunk.startSec)));
    }
  }
  return lines;
}

function shift(segment: RawSegment, bySec: number): RawSegment {
  return {
    ...segment,
    startSec: segment.startSec + bySec,
    endSec: segment.endSec + bySec,
    ...(segment.words && {
      words: segment.words.map((word) => ({
        ...word,
        startSec: word.startSec + bySec,
        endSec: word.endSec + bySec,
      })),
    }),
  };
}

function toLine(segment: RawSegment): Line {
  return {
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text.trim(),
    // Omitted rather than empty when the endpoint gave no word timing, which is what
    // the player checks to decide between word- and line-level highlighting (ADR 0004).
    ...(segment.words?.length && { words: segment.words }),
  };
}

// ---------------------------------------------------------------- driving it

export interface TranscribeDeps {
  /**
   * Transcribes one URL the endpoint fetches for itself. Every byte goes through the
   * proxy — never the origin directly — because at least one real host splices
   * advertising by User-Agent, answering two clients thirty seconds apart for the
   * same episode. A byte offset means nothing across two versions of a file, so one
   * client with one fixed User-Agent has to fetch all of them.
   */
  transcribeUrl(url: string): Promise<{ durationSec: number; segments: RawSegment[] }>;
  /** The proxy URL serving `[startByte, endByte]` of this episode as a whole file. */
  sliceUrl(range?: { startByte: number; endByte: number }): string;
  totalBytes: number;
  limit?: number;
  onProgress?: (done: number) => void;
}

/**
 * Sequential by construction, since each chunk's start comes from the last one's
 * transcript — and measurement says that costs nothing. Uploading was 75-80% of a
 * chunk's wall time, and the proxy removes the upload leg entirely by letting the
 * endpoint fetch the slice itself; what is left is fast enough that concurrency
 * would be optimising the small half.
 */
export async function transcribe(deps: TranscribeDeps): Promise<Transcript> {
  const limit = deps.limit ?? REQUEST_LIMIT_BYTES;

  if (fitsWhole(deps.totalBytes, limit)) {
    const whole = await deps.transcribeUrl(deps.sliceUrl());
    deps.onProgress?.(1);
    return stitch([
      { chunk: { startByte: 0, endByte: deps.totalBytes - 1, startSec: 0 }, ...whole },
    ]);
  }

  const results: ChunkResult[] = [];
  let next: Chunk | null = planFirst(deps.totalBytes, limit);
  while (next) {
    const chunk: Chunk = next;
    const answer = await deps.transcribeUrl(deps.sliceUrl(chunk));
    results.push({ chunk, ...answer });
    next = planNext(results[results.length - 1] as ChunkResult, deps.totalBytes, limit);
    // Bytes covered so far is the only honest progress here: the chunk count is not
    // known up front, because each seam is only discovered once the last one lands.
    deps.onProgress?.(Math.min(1, (chunk.endByte + 1) / deps.totalBytes));
  }
  return stitch(results);
}
