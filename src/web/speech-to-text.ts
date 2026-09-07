import type { LanguageCode, ModelSlot } from "../shared/model.ts";
import type { RawSegment } from "./transcribe.ts";

/**
 * The Transcription Model slot, over the OpenAI-compatible `/audio/transcriptions`
 * shape (ADR 0002), asked to fetch the audio itself rather than being handed bytes.
 *
 * That is the whole difference from the server version this replaces, and it is
 * worth a lot: uploading was 75-80% of a chunk's wall time — 26MB took 23.4 seconds
 * end to end where the same endpoint returned 5.3 minutes of audio in 2.4 when it
 * fetched the URL — because the bottleneck was a home connection's upstream rather
 * than anything at the far end. Handing over a URL moves the transfer to two data
 * centres talking to each other, and means the browser never holds the audio at all.
 *
 * The URL always points at the proxy, never at the podcast host: the endpoint will
 * not follow a redirect (it answers `media_fetch_failed` on a 302), plenty of hosts
 * send no CORS headers, and one splices advertising by User-Agent — 43,421,257 bytes
 * to one client and 44,263,131 to another for the same episode, which makes a byte
 * offset meaningless across two of them.
 */

export interface SpeechToTextOptions {
  slot: ModelSlot;
  /** Injected so tests need no network and no key. */
  fetch?: typeof globalThis.fetch;
}

export interface Transcribed {
  /** What the endpoint says this audio's own duration is — the byte-rate denominator. */
  durationSec: number;
  segments: RawSegment[];
}

export interface VerboseJson {
  duration?: number;
  text?: string;
  segments?: { start?: number; end?: number; text?: string }[] | null;
  words?: { word?: string; start?: number; end?: number }[] | null;
}

export type TranscriptionErrorReason =
  | "auth" | "rate_limit" | "server" | "network" | "too_large" | "bad_request" | "bad_response";

export class TranscriptionError extends Error {
  readonly reason: TranscriptionErrorReason;
  constructor(reason: TranscriptionErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TranscriptionError";
    this.reason = reason;
  }
}

export function createSpeechToText(options: SpeechToTextOptions) {
  const { slot } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `${slot.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

  function post(url: string, language: LanguageCode | undefined, withWords: boolean) {
    const form = new FormData();
    form.set("url", url);
    form.set("model", slot.model);
    // Omitted when the reader has not said what they are studying — every
    // OpenAI-compatible endpoint detects the language itself in that case.
    if (language) form.set("language", language);
    form.set("response_format", "verbose_json");
    if (withWords) {
      // Both, and this is not belt-and-braces. Asking for `word` alone comes back with
      // `segments: null`, and segments are what place the seam between two chunks.
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
    }
    return doFetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${slot.apiKey}` },
      body: form,
    });
  }

  return {
    async transcribeUrl(url: string, language?: LanguageCode): Promise<Transcribed> {
      let response: Response;
      try {
        response = await post(url, language, true);
        // Not every OpenAI-compatible implementation knows the granularities field.
        // Losing word timing is a graceful downgrade (ADR 0004); failing is not.
        if (response.status === 400 && !(await looksTooLarge(response))) {
          response = await post(url, language, false);
        }
      } catch (cause) {
        throw new TranscriptionError("network", `Could not reach ${endpoint}`, { cause });
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new TranscriptionError(
          reasonFor(response.status, detail),
          `Transcription failed with ${response.status}: ${detail.slice(0, 500)}`,
        );
      }

      const body = (await response.json().catch(() => null)) as VerboseJson | null;
      if (!body) throw new TranscriptionError("bad_response", "Transcription returned no JSON");
      if (typeof body.duration !== "number" || !(body.duration > 0)) {
        // Without it there is no byte-rate, and therefore no way to place the next
        // chunk. Better to say so than to guess and seam in the wrong place.
        throw new TranscriptionError("bad_response", "Transcription reported no duration");
      }
      return { durationSec: body.duration, segments: toSegments(body) };
    },
  };
}

/**
 * A 400 that means "your file is over the limit" must not be retried as though it
 * were the granularities field: the second attempt fails identically and the reader
 * waits twice as long for the same answer. The endpoint says so in the body.
 */
async function looksTooLarge(response: Response): Promise<boolean> {
  const text = await response.clone().text().catch(() => "");
  return /too.?large|size.?limit|exceed/i.test(text);
}

/**
 * Turns a verbose_json body into segments carrying their own words.
 *
 * The API reports words in one flat list for the whole request rather than nested
 * per segment, so they are assigned by which segment's time span they fall in.
 */
export function toSegments(body: VerboseJson): RawSegment[] {
  const segments = (body.segments ?? []).flatMap((segment) => {
    const startSec = segment.start;
    const endSec = segment.end;
    if (typeof startSec !== "number" || typeof endSec !== "number") return [];
    return [{ startSec, endSec, text: segment.text ?? "" }];
  });

  // Some providers return only `text` with no segments at all. One Line covering
  // everything is useless for a lyrics view, so treat it as nothing rather than
  // pretending the whole episode is one line.
  if (segments.length === 0) return [];

  const words = (body.words ?? []).flatMap((word) =>
    typeof word.start === "number" && typeof word.end === "number" && word.word
      ? [{ text: word.word, startSec: word.start, endSec: word.end }]
      : [],
  );
  if (words.length === 0) return segments;

  return segments.map((segment) => {
    // Midpoint, so a word straddling a boundary lands in exactly one segment.
    const mine = words.filter((word) => {
      const middle = (word.startSec + word.endSec) / 2;
      return middle >= segment.startSec && middle < segment.endSec;
    });
    return mine.length > 0 ? { ...segment, words: mine } : segment;
  });
}

function reasonFor(status: number, detail: string): TranscriptionErrorReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status === 413 || /too.?large|size.?limit/i.test(detail)) return "too_large";
  return "bad_request";
}
