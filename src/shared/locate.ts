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
