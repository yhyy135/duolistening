import { JAPANESE, LANGUAGE_NAMES, type Line, type Transcript } from "../shared/model.ts";
import type { Annotator, JapaneseTokenizer, TextModel } from "./ports.ts";

export interface AnnotatorOptions {
  textModel: TextModel;
  /** Required to get Tokens when the target language is Japanese; ignored otherwise. */
  tokenizer?: JapaneseTokenizer;
  /** Lines per translation call. Default 25. */
  batchSize?: number;
}

/** What the Text Model is asked to return per line. Short keys keep the reply small. */
interface TranslatedLine {
  i: number;
  t: string;
}

/**
 * Translation plus, for Japanese, morphological Tokens (ADR 0005).
 *
 * Translation goes out in batches rather than one call per Line — an episode is
 * several hundred Lines, and one call each would be slow and expensive. Batches are
 * matched back by index, not by position, because a model that drops or reorders an
 * entry must not shift every later translation onto the wrong Line.
 */
export function createAnnotator(options: AnnotatorOptions): Annotator {
  const { textModel, tokenizer } = options;
  const batchSize = options.batchSize ?? 25;

  return {
    async annotate(lines: Transcript, opts): Promise<Transcript> {
      if (lines.length === 0) return [];

      const wantsTokens = opts.targetLanguage === JAPANESE && tokenizer !== undefined;
      const translations = new Map<number, string>();
      const batches = chunk(lines, batchSize);

      for (const [batchIndex, batch] of batches.entries()) {
        const reply = await textModel.completeJson<TranslatedLine[]>(
          translationPrompt(batch, opts.targetLanguage, opts.nativeLanguage),
        );
        for (const entry of Array.isArray(reply) ? reply : []) {
          if (typeof entry?.i === "number" && typeof entry?.t === "string") {
            translations.set(entry.i, entry.t);
          }
        }
        opts.onProgress?.((batchIndex + 1) / batches.length);
      }

      // New Lines throughout: callers hold onto the input, and silently mutating it
      // would make a retry of this step operate on already-annotated data.
      return lines.map((line, index): Line => {
        const translation = translations.get(index);
        return {
          ...line,
          // A model that skipped an entry leaves that Line untranslated rather than
          // wearing its neighbour's translation.
          ...(translation !== undefined && { translation }),
          ...(wantsTokens && { tokens: tokenizer.tokenize(line.text) }),
        };
      });
    },
  };
}

function translationPrompt(
  batch: { line: Line; index: number }[],
  targetLanguage: string,
  nativeLanguage: string,
): string {
  const from = LANGUAGE_NAMES[targetLanguage as keyof typeof LANGUAGE_NAMES] ?? targetLanguage;
  const to = LANGUAGE_NAMES[nativeLanguage as keyof typeof LANGUAGE_NAMES] ?? nativeLanguage;

  return [
    `Translate each numbered line from ${from} into ${to}.`,
    "These lines are consecutive speech from one recording; use the surrounding lines for context,",
    "but translate each line on its own and never merge, split, or reorder them.",
    `Reply with only a JSON array: [{"i": <the line's number>, "t": "<the translation>"}],`,
    "one entry for every line you were given.",
    "",
    ...batch.map(({ line, index }) => `${index}: ${line.text}`),
  ].join("\n");
}

function chunk(lines: Transcript, size: number): { line: Line; index: number }[][] {
  const batches: { line: Line; index: number }[][] = [];
  for (let start = 0; start < lines.length; start += size) {
    batches.push(
      lines.slice(start, start + size).map((line, offset) => ({ line, index: start + offset })),
    );
  }
  return batches;
}
