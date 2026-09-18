import {
  JAPANESE,
  LANGUAGE_NAMES,
  type LanguageCode,
  type Transcript,
} from "../shared/model.ts";

/**
 * Fills in each Line's translation, and nothing else.
 *
 * It annotates exactly the Lines it is handed. Since ADR 0011 that is a window around
 * wherever someone is listening rather than a whole episode, and `nextWindow` below is
 * what decides which window — so this file owns both halves of the question, what to
 * translate and how.
 *
 * Japanese Tokens used to be computed here too, and are not any more (ADR 0015): they
 * come from kuromoji, which is local, and had no business waiting behind a network
 * call or being unreachable for a reader with no Text Model key. What is left of that
 * decision here is `wantsJapanese`, which the player asks before loading a dictionary.
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
 * Translation of the Lines it is handed, in one request. Replies are matched back by
 * index, not by position, because a model that drops or reorders an entry must not shift
 * every later translation onto the wrong Line.
 *
 * One request, never several side by side. The player hands over one window at a time,
 * sized to come back in a single reply (see `BLOCK_LINES`). This used to cut a window
 * into batches of forty and send four of them at once, which put two and three requests
 * in flight for one window — and a provider's rate limit counts requests, not windows.
 */
export function createAnnotator({ textModel }: AnnotatorOptions) {
  return {
    async annotate(lines: Transcript, opts: AnnotateOptions): Promise<Transcript> {
      if (lines.length === 0) return [];

      const reply = await textModel.completeJson<TranslatedLine[]>(
        translationPrompt(lines, opts.targetLanguage, opts.nativeLanguage),
      );
      const translations = new Map<number, string>();
      for (const entry of Array.isArray(reply) ? reply : []) {
        if (typeof entry?.i === "number" && typeof entry?.t === "string") {
          translations.set(entry.i, entry.t);
        }
      }

      // New Lines throughout: callers hold onto the input, and silently mutating it
      // would make a retry of this step operate on already-annotated data.
      return lines.map((line, index) => {
        const translation = translations.get(index);
        // A model that skipped an entry leaves that Line untranslated rather than
        // wearing its neighbour's translation.
        return translation === undefined ? line : { ...line, translation };
      });
    },
  };
}

/** Hiragana and katakana. No other language in LANGUAGES uses either. */
const KANA = /[\u3040-\u30ff]/;

/**
 * Whether these Lines want Japanese Tokens: the setting says so, or — when the studied
 * language was left unset, which is the default — the text itself does.
 *
 * The only part of the Japanese question left in this file, and the player is now the
 * one asking it (ADR 0015) — before deciding whether a dictionary of tens of megabytes
 * is worth downloading, and separately from anything the Text Model is asked.
 *
 * Answered over a whole Transcript, never over a window (ADR 0011): a window with no
 * kana in it is not evidence of anything, and Tokens appearing on some blocks and not
 * their neighbours is the bug that follows.
 */
export function wantsJapanese(lines: Transcript, targetLanguage?: LanguageCode): boolean {
  if (targetLanguage) return targetLanguage === JAPANESE;
  return lines.some((line) => KANA.test(line.text));
}

/**
 * Lines per block of the grid `nextWindow` works on. A window is at most three blocks —
 * the one being listened to and one either side — and goes out as a single request, so
 * a window is at most thirty Lines, well inside the 4,096-token reply some providers stop
 * at unless told otherwise. It was twenty, and sixty Lines to a window; ten halves every
 * request, and the price is that listening sends one every ten Lines, not every twenty.
 */
export const BLOCK_LINES = 10;

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
 * are kept translated — the one being listened to, one ahead and one behind — and all
 * of them that are still missing go out as one span. Opening an episode is therefore one
 * request, and listening on is one more each time a new block comes into range.
 *
 * The span is contiguous and never pays twice: a block already translated between two
 * missing ones splits them, and the one ahead goes first.
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
  const here = Math.min(Math.floor(Math.max(0, lineIndex) / blockSize), blocks - 1);

  const missing = (block: number) =>
    block >= Math.max(0, here - 1) &&
    block <= Math.min(blocks - 1, here + 1) &&
    !asked.has(block) &&
    lines
      .slice(block * blockSize, (block + 1) * blockSize)
      .some((line) => line.translation === undefined);

  const start = [here, here + 1, here - 1].find(missing);
  if (start === undefined) return null;
  let first = start;
  let last = start;
  while (missing(first - 1)) first--;
  while (missing(last + 1)) last++;

  return {
    from: first * blockSize,
    to: Math.min((last + 1) * blockSize, lines.length),
    blocks: Array.from({ length: last - first + 1 }, (_, offset) => first + offset),
  };
}

function translationPrompt(
  lines: Transcript,
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
    ...lines.map((line, index) => `${index}: ${line.text}`),
  ].join("\n");
}
