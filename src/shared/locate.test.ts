import { test } from "node:test";
import assert from "node:assert/strict";
import { locate } from "./locate.ts";
import type { Line } from "./model.ts";

const line = (startSec: number, endSec: number, words?: [number, number][]): Line => ({
  startSec,
  endSec,
  text: "",
  ...(words && { words: words.map(([s, e]) => ({ text: "", startSec: s, endSec: e })) }),
});

const lines: Line[] = [
  line(0, 2, [
    [0, 0.5],
    [1, 2],
  ]), // two words with a gap between them
  line(5, 7), // no word timings at all
  line(10, 12),
  line(20, 22, [[20.5, 21]]), // first word starts after the Line does
];

test("nothing is active before the first Line starts", () => {
  assert.deepEqual(locate(lines, -0.5), { lineIndex: -1, wordIndex: null });
  assert.deepEqual(locate([], 5), { lineIndex: -1, wordIndex: null });
});

test("a Line's start time counts as inside it", () => {
  assert.equal(locate(lines, 0).lineIndex, 0);
  assert.equal(locate(lines, 5).lineIndex, 1);
});

test("a gap between Lines sticks to the one that just played", () => {
  assert.equal(locate(lines, 3).lineIndex, 0);
  assert.equal(locate(lines, 99).lineIndex, 3);
});

test("a Line without word timings reports no word", () => {
  assert.deepEqual(locate(lines, 6), { lineIndex: 1, wordIndex: null });
});

test("words track playback inside a Line", () => {
  assert.deepEqual(locate(lines, 0.2), { lineIndex: 0, wordIndex: 0 });
  assert.deepEqual(locate(lines, 1.5), { lineIndex: 0, wordIndex: 1 });
});

test("a gap between words sticks to the one that just played", () => {
  assert.deepEqual(locate(lines, 0.7), { lineIndex: 0, wordIndex: 0 });
});

test("no word is active before the Line's first word starts", () => {
  assert.deepEqual(locate(lines, 20.2), { lineIndex: 3, wordIndex: null });
});
