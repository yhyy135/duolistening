import type { Line } from "./model.ts";

export interface Position {
  /** Index into lines, or -1 before the first Line has started. */
  lineIndex: number;
  /** Index into that Line's words, or null when it has none, or none started yet. */
  wordIndex: number | null;
}

/**
 * Which Line and Word playback is sitting on at time `t` — the heart of the
 * lyrics view, kept pure so it can be tested without audio or a DOM.
 *
 * Sticky by design: during a gap (between Lines, or between Words inside a Line)
 * the answer stays on the last thing that started, so the highlight doesn't blink
 * out during pauses. Before the first Line starts, lineIndex is -1.
 *
 * Requires `lines` ordered by startSec, and each Line's `words` likewise —
 * `toSegments` is what guarantees the second one. Unordered input does not make the
 * answer jump about, which is the failure that would show: whichever index the search
 * returns can only grow as `t` does, because the first node where two searches diverge
 * sends the later `t` right, and everything right of a node outranks everything left
 * of it. What it does instead is quietly hide a Word that a larger predecessor covers.
 */
export function locate(lines: readonly Line[], t: number): Position {
  const lineIndex = lastStartedAt(lines, t);
  if (lineIndex < 0) return { lineIndex: -1, wordIndex: null };

  const words = lines[lineIndex]?.words;
  if (!words?.length) return { lineIndex, wordIndex: null };

  const wordIndex = lastStartedAt(words, t);
  return { lineIndex, wordIndex: wordIndex < 0 ? null : wordIndex };
}

/** Index of the last span that has started by `t`, or -1 if none has. */
function lastStartedAt(spans: readonly { startSec: number }[], t: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((spans[mid] as { startSec: number }).startSec <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Half-open `[first, limit)` range of Word indices — which Words sound one Token. */
export type WordRange = readonly [number, number];

/**
 * Which Words sound each Token — `result[t]` is a range of indices into `line.words`,
 * so a renderer showing Tokens can still highlight word by word.
 *
 * Word and Token are measured from different places (audio timing vs. morphology)
 * and their boundaries genuinely disagree, so they are reconciled here the only way
 * they can be: both are matched back onto `line.text` by character offset. A Token
 * starts on the last Word that starts at or before it, and runs until a *later* Token
 * claims a Word of its own. One Word covering three Tokens lights all three at once,
 * which is what was actually heard.
 *
 * A range rather than a single Word because the disagreement goes both ways, and the
 * other way is the common one for Japanese: an ASR reporting one Word per kana turns
 * a five-character Token into five Words, and a Token that lit only on the first of
 * them flashed for a fifth of its own sound and then went out while it was still being
 * spoken. Tokens sharing a first Word share a range and still light together.
 *
 * Null when there is nothing to reconcile — no Tokens, or no Word timings (ADR 0004),
 * which is the caller's cue to fall back to highlighting the whole Line.
 *
 * Deliberately derived at render time rather than stored: a Token carries no
 * timestamp (ADR 0005), and giving it one would tie morphology to whichever ASR
 * happened to transcribe the audio.
 */
export function tokenWords(line: Line): WordRange[] | null {
  const { tokens, words } = line;
  if (!tokens?.length || !words?.length) return null;

  const wordSpans = alignTo(
    line.text,
    words.map((word) => word.text),
  );
  const tokenSpans = alignTo(
    line.text,
    tokens.map((token) => token.surface),
  );

  let word = 0;
  const firsts = tokenSpans.map(([start]) => {
    while (word + 1 < wordSpans.length && (wordSpans[word + 1] as Span)[0] <= start) word++;
    return word;
  });

  // Backwards, so each Token learns where the next one that moved on actually begins.
  // A Token whose surface the text does not contain collapses onto its neighbour's
  // Word (see `alignTo`); it must not end up with an empty range and never light.
  const ranges: WordRange[] = new Array(firsts.length);
  let limit = words.length;
  for (let index = firsts.length - 1; index >= 0; index--) {
    const first = firsts[index] as number;
    const next = firsts[index + 1];
    if (next !== undefined && next > first) limit = next;
    ranges[index] = [first, limit];
  }
  return ranges;
}

/**
 * Where one piece of the current Line sits in the karaoke sweep, as a CSS class:
 * "pending" before its Words, "now" through all of them, "said" after.
 *
 * Empty when there is nothing to sweep with — no range, or a Line whose first Word has
 * not started. The Line is then highlighted whole (ADR 0004), and dimming its pieces
 * would only make that look broken.
 */
export function sweepState(range: WordRange | undefined, wordIndex: number | null): string {
  if (!range || wordIndex === null) return "";
  return wordIndex < range[0] ? "pending" : wordIndex < range[1] ? "now" : "said";
}

/**
 * The Line's own text cut into one slice per Word, so a renderer can style Words
 * individually without rebuilding the sentence out of them.
 *
 * Each slice carries whatever sits between it and the Word before it, and the last
 * one carries the tail, so the slices concatenate back to `line.text` exactly. That
 * is the point: an ASR reports "finished", not " finished", and joining its Words
 * directly would render `Ifinishedthebook` — while inventing a space instead would
 * render `me .` wherever it split punctuation off.
 *
 * Null when the Line has no Word timings — the caller then renders `line.text` whole.
 */
export function wordSlices(line: Line): string[] | null {
  const words = line.words;
  if (!words?.length) return null;

  const spans = alignTo(
    line.text,
    words.map((word) => word.text),
  );
  return spans.map(([, end], index) => {
    const from = index === 0 ? 0 : (spans[index - 1] as Span)[1];
    const to = index === spans.length - 1 ? line.text.length : end;
    return line.text.slice(from, to);
  });
}

/** Half-open `[start, end)` character range within a Line's text. */
type Span = [number, number];

/**
 * Where each piece sits in `text`, scanning forward so a piece that repeats lands on
 * successive occurrences rather than all on the first.
 *
 * A piece that isn't in the text at all — punctuation the ASR invented, a word it
 * heard differently — collapses to an empty span at the cursor rather than throwing
 * the rest of the Line out of alignment.
 */
function alignTo(text: string, pieces: string[]): Span[] {
  let cursor = 0;
  return pieces.map((piece) => {
    const trimmed = piece.trim();
    const at = trimmed ? text.indexOf(trimmed, cursor) : -1;
    if (at < 0) return [cursor, cursor];
    cursor = at + trimmed.length;
    return [at, cursor];
  });
}
