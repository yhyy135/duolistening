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
 * Requires `lines` ordered by startSec, and each Line's `words` likewise;
 * the binary search silently misbehaves on unordered input.
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

/**
 * Which Word sounds each Token — `result[t]` is an index into `line.words`, so a
 * renderer showing Tokens can still highlight word by word.
 *
 * Word and Token are measured from different places (audio timing vs. morphology)
 * and their boundaries genuinely disagree, so they are reconciled here the only way
 * they can be: both are matched back onto `line.text` by character offset, and each
 * Token takes the last Word that starts at or before it. One Word covering three
 * Tokens lights all three at once, which is what was actually heard.
 *
 * Null when there is nothing to reconcile — no Tokens, or no Word timings (ADR 0004),
 * which is the caller's cue to fall back to highlighting the whole Line.
 *
 * Deliberately derived at render time rather than stored: a Token carries no
 * timestamp (ADR 0005), and giving it one would tie morphology to whichever ASR
 * happened to transcribe the audio.
 */
export function tokenWords(line: Line): number[] | null {
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
  return tokenSpans.map(([start]) => {
    while (word + 1 < wordSpans.length && (wordSpans[word + 1] as Span)[0] <= start) word++;
    return word;
  });
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
