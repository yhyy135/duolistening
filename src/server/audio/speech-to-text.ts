import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LanguageCode, ModelSlot } from "../../shared/model.ts";
import type { RawSegment, SpeechToText } from "../ports.ts";
import { ModelError } from "../text-model.ts";

export interface SpeechToTextOptions {
  slot: ModelSlot;
  fetch?: typeof globalThis.fetch;
}

interface VerboseJson {
  text?: string;
  segments?: { start?: number; end?: number; text?: string }[];
  words?: { word?: string; start?: number; end?: number }[];
}

/**
 * The Transcription Model slot, over the OpenAI-compatible `/audio/transcriptions`
 * shape (ADR 0002).
 *
 * Asks for word-level timestamps but does not require them: providers that reject
 * `timestamp_granularities` are retried without it, and the caller simply gets
 * segments with no word timing, which is exactly the fallback ADR 0004 describes.
 */
export function createSpeechToText(options: SpeechToTextOptions): SpeechToText {
  const { slot } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `${slot.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

  async function post(audioPath: string, language: LanguageCode, withWords: boolean) {
    const form = new FormData();
    form.set("file", new Blob([await fs.readFile(audioPath)]), path.basename(audioPath));
    form.set("model", slot.model);
    form.set("language", language);
    form.set("response_format", "verbose_json");
    if (withWords) {
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
    }

    try {
      return await doFetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${slot.apiKey}` },
        body: form,
      });
    } catch (cause) {
      throw new ModelError("network", `Could not reach ${endpoint}`, { cause });
    }
  }

  return {
    async transcribeChunk(audioPath: string, language: LanguageCode): Promise<RawSegment[]> {
      let response = await post(audioPath, language, true);

      // Not every OpenAI-compatible implementation knows the granularities field.
      // Losing word timing is a graceful downgrade; failing the import is not.
      if (response.status === 400) {
        response = await post(audioPath, language, false);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new ModelError(
          reasonFor(response.status),
          `Transcription failed with ${response.status}: ${detail.slice(0, 500)}`,
        );
      }

      const body = (await response.json().catch(() => null)) as VerboseJson | null;
      if (!body) throw new ModelError("bad_response", "Transcription returned no JSON");
      return toSegments(body);
    },
  };
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
    const mine = words.filter(
      // Midpoint, so a word straddling a boundary lands in exactly one segment.
      (word) => {
        const middle = (word.startSec + word.endSec) / 2;
        return middle >= segment.startSec && middle < segment.endSec;
      },
    );
    return mine.length > 0 ? { ...segment, words: mine } : segment;
  });
}

function reasonFor(status: number) {
  if (status === 401 || status === 403) return "auth" as const;
  if (status === 429) return "rate_limit" as const;
  if (status >= 500) return "server" as const;
  return "bad_request" as const;
}
