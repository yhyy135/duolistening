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
  "auth" | "rate_limit" | "server" | "network" | "too_large" | "bad_request" | "bad_response";

export class TranscriptionError extends Error {
  readonly reason: TranscriptionErrorReason;
  constructor(
    reason: TranscriptionErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TranscriptionError";
    this.reason = reason;
  }
}

/**
 * What an uploaded episode has to be called, from the type the store corrected it to.
 *
 * These endpoints decide the audio format from the filename's extension and from
 * nothing else. Measured against Groq: the same WAV bytes are refused outright as
 * `episode` — 400, `unsupported_audio_format`, "file must be one of the following
 * types" — accepted as `episode.wav`, and *also* accepted and correctly transcribed
 * as `episode.mp3`. So the extension is a gate that the decoder behind it does not
 * consult; passing it is mandatory and being right about it is not.
 *
 * Being right about it anyway. `.mp3` would clear the gate for everything, and it is
 * the same lie that `audioType` exists to stop telling — the next provider may be the
 * one that dispatches on it rather than sniffing.
 */
const EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/webm": "webm",
  "video/mp4": "mp4",
};

export function uploadName(type: string): string {
  const bare = type.split(";")[0]?.trim().toLowerCase() ?? "";
  // `audioType` answers "" when neither the magic bytes nor the server identified
  // the file. A podcast enclosure that nothing recognised is an mp3 in practice, and
  // the alternative is refusing to try.
  return `episode.${EXTENSIONS[bare] ?? "mp3"}`;
}

export function createSpeechToText(options: SpeechToTextOptions) {
  const { slot } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `${slot.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

  /** Either a URL the endpoint fetches, or the bytes themselves. */
  type Source = { url: string } | { blob: Blob };

  function post(source: Source, language: LanguageCode | undefined, withWords: boolean) {
    const form = new FormData();
    if ("url" in source) form.set("url", source.url);
    else form.set("file", source.blob, uploadName(source.blob.type));
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

  async function send(source: Source, language?: LanguageCode): Promise<Transcribed> {
    let response: Response;
    try {
      response = await post(source, language, true);
      // Not every OpenAI-compatible implementation knows the granularities field.
      // Losing word timing is a graceful downgrade (ADR 0004); failing is not.
      if (response.status === 400 && !(await looksTooLarge(response))) {
        response = await post(source, language, false);
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
  }

  return {
    /**
     * The bytes this browser already holds, uploaded.
     *
     * This is the path that guarantees the Transcript describes the audio that was
     * kept, and it exists because the URL path does not. Both fetches went through
     * the proxy and still disagreed: one real episode came back as 412.5 seconds to
     * a browser and 449.8 to the transcription provider, with different advertising
     * in each. The proxy pins a User-Agent, but a Worker runs at whichever edge the
     * request entered, so the origin sees a different region for each caller — and
     * this host varies its ad load by region. Transcribing the bytes we keep is the
     * only thing that makes the timeline and the audio the same recording.
     */
    transcribeBlob(blob: Blob, language?: LanguageCode): Promise<Transcribed> {
      return send({ blob }, language);
    },

    /**
     * The endpoint fetches for itself. Still used for chunked episodes, where the
     * caller asks the proxy for byte ranges — and still carries the mismatch risk
     * described above, which is why it is no longer the whole-file path.
     */
    transcribeUrl(url: string, language?: LanguageCode): Promise<Transcribed> {
      return send({ url }, language);
    },
  };
}

/**
 * A 400 that means "your file is over the limit" must not be retried as though it
 * were the granularities field: the second attempt fails identically and the reader
 * waits twice as long for the same answer. The endpoint says so in the body.
 */
async function looksTooLarge(response: Response): Promise<boolean> {
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  return /too.?large|size.?limit|exceed/i.test(text);
}

/**
 * Turns a verbose_json body into segments carrying their own words.
 *
 * The API reports words in one flat list for the whole request rather than nested
 * per segment, so they are assigned by which segment's time span they fall in.
 *
 * That flat list is not reliably in time order. Providers concatenate it segment by
 * segment, and segments overlap: one real Japanese episode came back with 191 Words
 * starting earlier than the Word before them, every one of them a straddler the
 * midpoint rule below had pulled back into the previous segment. `locate` asks for
 * ordered Words and silently hides the ones it does not get, so they are sorted here,
 * at the one place a Word becomes part of a Line.
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

  const words = (body.words ?? [])
    .flatMap((word) =>
      typeof word.start === "number" && typeof word.end === "number" && word.word
        ? [{ text: word.word, startSec: word.start, endSec: word.end }]
        : [],
    )
    .sort((left, right) => left.startSec - right.startSec);
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
