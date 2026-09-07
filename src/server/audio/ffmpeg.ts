import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AudioTool, Silence } from "../ports.ts";

const run = promisify(execFile);

export interface FfmpegOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Anything quieter than this counts as silence. */
  noiseFloorDb?: number;
  /** Ignore pauses shorter than this — breaths are not sentence boundaries. */
  minSilenceSeconds?: number;
}

/** The AudioTool backed by ffmpeg and ffprobe on PATH. */
export function createFfmpegAudioTool(options: FfmpegOptions = {}): AudioTool {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const ffprobe = options.ffprobePath ?? "ffprobe";
  const noiseFloor = options.noiseFloorDb ?? -35;
  const minSilence = options.minSilenceSeconds ?? 0.4;

  return {
    async durationSec(path: string): Promise<number> {
      const { stdout } = await run(ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ]);
      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration)) throw new Error(`ffprobe gave no duration for ${path}`);
      return duration;
    },

    async detectSilences(path: string): Promise<Silence[]> {
      // silencedetect reports on stderr and produces no output file, hence -f null.
      // maxBuffer is raised because a long recording can report thousands of pauses.
      const { stderr } = await run(
        ffmpeg,
        [
          "-i",
          path,
          "-af",
          `silencedetect=noise=${noiseFloor}dB:d=${minSilence}`,
          "-f",
          "null",
          "-",
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      return parseSilences(stderr);
    },

    async extract(source: string, startSec: number, endSec: number, destPath: string) {
      await run(ffmpeg, [
        "-y",
        // Seek before -i so ffmpeg jumps rather than decoding from the start.
        "-ss",
        startSec.toFixed(3),
        "-i",
        source,
        "-t",
        (endSec - startSec).toFixed(3),
        "-vn",
        // Re-encode to AAC rather than stream-copying: the destination is always
        // named `.m4a` (the ASR endpoint needs a real extension), and `-c copy` into
        // an MP4 container fails outright for any source codec that container can't
        // hold — mp3 chief among them, which is most podcasts. Audio-only encodes
        // are fast enough that this never shows up next to network/ASR latency.
        "-c:a",
        "aac",
        destPath,
      ]);
    },
  };
}

/** Pulls the paired start/end lines out of silencedetect's stderr chatter. */
export function parseSilences(stderr: string): Silence[] {
  const silences: Silence[] = [];
  let openedAt: number | null = null;

  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start?.[1]) {
      openedAt = Number.parseFloat(start[1]);
      continue;
    }
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (end?.[1] && openedAt !== null) {
      silences.push({ startSec: openedAt, endSec: Number.parseFloat(end[1]) });
      openedAt = null;
    }
  }
  // A silence still open at EOF is dropped: it has no end, and a cut there would be
  // at the end of the file anyway.
  return silences;
}
