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
 * It annotates exactly the Lines it is handed. Since ADR 0011 that is a window around
 * wherever someone is listening rather than a whole episode, and `nextWindow` below is
 * what decides which window — so this file owns both halves of the question, what to
 * translate and how.
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

      const tokenize =
        wantsJapanese(lines, opts.targetLanguage) && tokenizer ? await tokenizer() : undefined;
      // Tokenizing doesn't depend on translation, so it happens up front rather than
      // in the merge below — the New-Lines rule still holds, since this itself never
      // touches the input Lines.
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

/**
 * Whether these Lines want Japanese Tokens: the setting says so, or — when the studied
 * language was left unset, which is the default — the text itself does.
 *
 * Exported because the caller now hands over a window of a Transcript rather than the
 * whole of it (ADR 0011), and a window with no kana in it is not evidence of anything.
 * The decision is made once, over every Line, and passed back down.
 */
export function wantsJapanese(lines: Transcript, targetLanguage?: LanguageCode): boolean {
  if (targetLanguage) return targetLanguage === JAPANESE;
  return lines.some((line) => KANA.test(line.text));
}

/**
 * Lines per translation request. Also the default batch size, so the common case —
 * two neighbouring blocks that have never been translated — is two batches in flight
 * and one round trip.
 */
export const BLOCK_LINES = 40;

/** A slice of a Transcript to translate, and the blocks it covers. */
export interface TranslationWindow {
  /** Line indices into the Transcript; `to` is exclusive. */
  from: number;
  to: number;
  /** Every block this span covers, for the caller's "already asked" set. */
  blocks: number[];
}

/**
 * The next span of Lines worth translating while someone is listening at `lineIndex`,
 * or null when the window around them is covered (ADR 0011).
 *
 * The Transcript is cut into fixed blocks so that "have we asked for this yet" is one
 * number rather than a set of ranges to merge: seeking back and forth over the same
 * minute must not produce a new, slightly different request each time. Three blocks
 * are kept translated — the one being listened to, one ahead and one behind — and the
 * one being listened to goes first, because that is the one on screen.
 *
 * `asked` is the caller's memory of what it has already sent, which is not the same
 * question as what came back: a request that failed, or a model that skipped a Line,
 * must not put this straight back in the queue.
 */
export function nextWindow(
  lines: Transcript,
  lineIndex: number,
  asked: ReadonlySet<number>,
  blockSize: number = BLOCK_LINES,
): TranslationWindow | null {
  const blocks = Math.ceil(lines.length / blockSize);
  if (blocks === 0) return null;
  // Before the first Line is a real position: it is what the screen shows before
  // playback has started, and the reader is looking at the top of the Transcript.
  const here = Math.min(
    Math.max(0, Math.floor(Math.max(0, lineIndex) / blockSize)),
    blocks - 1,
  );

  const missing = (block: number) =>
    !asked.has(block) &&
    lines
      .slice(block * blockSize, (block + 1) * blockSize)
      .some((line) => line.translation === undefined);

  const first = [here, here + 1, here - 1].find(
    (block) => block >= 0 && block < blocks && missing(block),
  );
  if (first === undefined) return null;

  // Extended while the next block is missing too and still inside the window, so a
  // Transcript with nothing translated goes out as one request rather than three.
  let last = first;
  while (last + 1 <= here + 1 && missing(last + 1)) last++;

  return {
    from: first * blockSize,
    to: Math.min((last + 1) * blockSize, lines.length),
    blocks: Array.from({ length: last - first + 1 }, (_, offset) => first + offset),
  };
}

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
