import {
  JAPANESE,
  LANGUAGE_NAMES,
  type LanguageCode,
  type Line,
  type Token,
  type Transcript,
} from "../shared/model.ts";

/**
 * Fills in each Line's translation, and its tokens when the target language is
 * Japanese (ADR 0005). Whether Japanese is special is this module's business, not
 * its caller's.
 *
 * Returns new Lines; never mutates the input.
 */

/**
 * The one thing the Annotator needs from the Text Model slot. Depending on the
 * single method it calls rather than on the whole client keeps the seam honest:
 * a test's stub is two lines, and nothing here has an opinion about auth, retries
 * or streaming.
 */
export interface TranslationModel {
  /** Retries once with a repair prompt when the model returns unparseable JSON. */
  completeJson<T>(prompt: string): Promise<T>;
}

export interface AnnotatorOptions {
  textModel: TranslationModel;
  /**
   * Built on demand, and only for Japanese Lines: the dictionary is tens of megabytes
   * — a download, in a browser — and with the studied language optional the caller
   * cannot know up front whether this import needs it. Awaited at most once per
   * annotate call.
   */
  tokenizer?: () => Promise<{ tokenize(text: string): Token[] }>;
  /** Lines per translation call. Default 40. */
  batchSize?: number;
  /** Batches in flight at once. Default 4 — enough to matter, low enough to stay under most providers' rate limits. */
  concurrency?: number;
}

export interface AnnotateOptions {
  nativeLanguage: LanguageCode;
  /** Omitted when it is unknown: the Text Model then reads the source language
   *  off the Lines themselves, and Japanese is recognised from the text. */
  targetLanguage?: LanguageCode;
  onProgress?: (fraction: number) => void;
  /** Fired after each batch with the full Transcript so far, so a caller can let
   *  playback start before every batch has translated — the Resource is already
   *  playable once transcription is done, and this is what lets translations fill
   *  in progressively instead of waiting for the whole thing. */
  onBatch?: (partial: Transcript) => void | Promise<void>;
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
export function createAnnotator(options: AnnotatorOptions) {
  const { textModel, tokenizer } = options;
  const batchSize = options.batchSize ?? 40;
  const concurrency = options.concurrency ?? 4;

  return {
    async annotate(lines: Transcript, opts: AnnotateOptions): Promise<Transcript> {
      if (lines.length === 0) return [];

      // The setting may say Japanese, or say nothing at all and leave the text to
      // answer — kana is the giveaway, and no other language on the list has any.
      const isJapanese =
        opts.targetLanguage === JAPANESE ||
        (opts.targetLanguage === undefined && lines.some((line) => KANA.test(line.text)));
      const tokenize = isJapanese && tokenizer ? await tokenizer() : undefined;
      // Tokenizing doesn't depend on translation, so it happens once up front rather
      // than on every partial snapshot below — the New-Lines rule still holds, since
      // this itself never touches the input Lines.
      const withTokens: Transcript = lines.map((line) => ({
        ...line,
        ...(tokenize && { tokens: tokenize.tokenize(line.text) }),
      }));

      const translations = new Map<number, string>();
      const merge = (): Transcript =>
        withTokens.map((line, index) => {
          const translation = translations.get(index);
          // A model that skipped an entry leaves that Line untranslated rather than
          // wearing its neighbour's translation.
          return translation === undefined ? line : { ...line, translation };
        });

      const batches = chunk(lines, batchSize);
      let completed = 0;

      // Batches translate independently, so they go out concurrently (capped, to stay
      // under a provider's rate limit) instead of one-at-a-time — sequential awaiting
      // made total time scale with batch count, which for a full episode is the slow path.
      async function runBatch(batch: (typeof batches)[number]): Promise<void> {
        const reply = await textModel.completeJson<TranslatedLine[]>(
          translationPrompt(batch, opts.targetLanguage, opts.nativeLanguage),
        );
        for (const entry of Array.isArray(reply) ? reply : []) {
          if (typeof entry?.i === "number" && typeof entry?.t === "string") {
            translations.set(entry.i, entry.t);
          }
        }
        completed++;
        // Written before the progress tick that will make a watcher look for it, so a
        // caller who refetches on that tick already sees this batch's translations.
        await opts.onBatch?.(merge());
        opts.onProgress?.(completed / batches.length);
      }

      const queue = [...batches];
      const workers = Array.from(
        { length: Math.min(concurrency, batches.length) },
        async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            await runBatch(next);
          }
        },
      );
      await Promise.all(workers);

      // New Lines throughout: callers hold onto the input, and silently mutating it
      // would make a retry of this step operate on already-annotated data.
      return merge();
    },
  };
}

/** Hiragana and katakana. No other language in LANGUAGES uses either. */
const KANA = /[\u3040-\u30ff]/;

function translationPrompt(
  batch: { line: Line; index: number }[],
  targetLanguage: string | undefined,
  nativeLanguage: string,
): string {
  // Naming the source language is a hint, not a requirement: when it is unset the
  // model reads it off the lines, which is the same thing it does when the setting
  // is there but wrong about this particular recording.
  const from = targetLanguage
    ? ` from ${LANGUAGE_NAMES[targetLanguage as keyof typeof LANGUAGE_NAMES] ?? targetLanguage}`
    : "";
  const to = LANGUAGE_NAMES[nativeLanguage as keyof typeof LANGUAGE_NAMES] ?? nativeLanguage;

  return [
    `Translate each numbered line${from} into ${to}.`,
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
