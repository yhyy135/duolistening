import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Line, Transcript } from "../shared/model.ts";
import type { AudioTool, RawSegment, Silence, SpeechToText, Transcriber } from "./ports.ts";

export interface TranscriberOptions {
  audio: AudioTool;
  speech: SpeechToText;
  /**
   * Longest chunk to send in one request. Transcription endpoints cap request size
   * (OpenAI's is 25MB, roughly half an hour of speech); this stays well under it
   * while keeping the number of chunks — and therefore the number of seams — small.
   */
  maxChunkSeconds?: number;
  /** How far back from a chunk boundary to hunt for a pause to cut on. */
  silenceSearchSeconds?: number;
}

/**
 * Audio in, Lines out (ADR 0003, ADR 0004).
 *
 * Splits only when it has to, cuts on silence when it can, offsets every chunk's
 * timestamps back onto one timeline, and hands back the same shape whether or not
 * the endpoint returned word-level timing.
 */
export function createTranscriber(options: TranscriberOptions): Transcriber {
  const { audio, speech } = options;
  const maxChunk = options.maxChunkSeconds ?? 20 * 60;
  const searchWindow = options.silenceSearchSeconds ?? 90;

  return {
    async transcribe(audioPath: string, opts): Promise<Transcript> {
      const duration = await audio.durationSec(audioPath);

      // The common case for a short video: no ffmpeg work, no temp files, one call.
      if (duration <= maxChunk) {
        const segments = await speech.transcribeChunk(audioPath, opts.language);
        opts.onProgress?.(1);
        return segments.map(toLine);
      }

      const cuts = planCuts(
        duration,
        await audio.detectSilences(audioPath),
        maxChunk,
        searchWindow,
      );
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-chunks-"));

      try {
        const lines: Line[] = [];
        for (const [index, cut] of cuts.entries()) {
          const chunkPath = path.join(workDir, `chunk-${index}.m4a`);
          await audio.extract(audioPath, cut.startSec, cut.endSec, chunkPath);

          const segments = await speech.transcribeChunk(chunkPath, opts.language);
          // Every chunk's clock starts at zero; shift it back onto the real timeline.
          lines.push(...segments.map((segment) => toLine(shift(segment, cut.startSec))));

          opts.onProgress?.((index + 1) / cuts.length);
        }
        return lines;
      } finally {
        await fs.rm(workDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Chooses where to cut: as few chunks as possible, each no longer than `maxChunk`,
 * and each boundary placed in the latest silence within the search window before the
 * limit. Falls back to cutting at the limit when someone talks straight through it.
 */
export function planCuts(
  durationSec: number,
  silences: Silence[],
  maxChunkSec: number,
  searchWindowSec: number,
): { startSec: number; endSec: number }[] {
  const cuts: { startSec: number; endSec: number }[] = [];
  let start = 0;

  while (durationSec - start > maxChunkSec) {
    const remaining = durationSec - start;
    // Cutting at the limit when only a little is left strands a few seconds in a
    // chunk of their own, and ASR models are apt to hallucinate text onto a clip
    // that short. Splitting the remainder down the middle costs no extra request.
    const limit = remaining <= maxChunkSec * 1.5 ? start + remaining / 2 : start + maxChunkSec;
    const candidate = silences
      .filter((silence) => {
        const middle = midpoint(silence);
        return middle > limit - searchWindowSec && middle <= limit;
      })
      .at(-1);

    // No pause to use: cut on the limit and accept one clipped sentence.
    const end = candidate ? midpoint(candidate) : limit;
    cuts.push({ startSec: start, endSec: end });
    start = end;
  }

  cuts.push({ startSec: start, endSec: durationSec });
  return cuts;
}

function midpoint(silence: Silence): number {
  return (silence.startSec + silence.endSec) / 2;
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
    // the player checks to decide between word- and line-level highlighting.
    ...(segment.words?.length && { words: segment.words }),
  };
}
