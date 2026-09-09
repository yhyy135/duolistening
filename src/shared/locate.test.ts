import { test } from "node:test";
import assert from "node:assert/strict";
import { locate, sweepState, tokenWords, wordSlices, type WordRange } from "./locate.ts";
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

// 昨日買った本をもう読み終わりました。 — split the way kuromoji splits it, against
// the coarser chunks an ASR typically reports. The two disagree on purpose.
const TEXT = "昨日買った本をもう読み終わりました。";
const SURFACES = [
  "昨日",
  "買っ",
  "た",
  "本",
  "を",
  "もう",
  "読み",
  "終わり",
  "まし",
  "た",
  "。",
];
const HEARD = ["昨日", "買った", "本を", "もう", "読み終わり", "ました"];

const japanese = (surfaces: string[], heard: string[], text = TEXT): Line => ({
  startSec: 0,
  endSec: 5,
  text,
  tokens: surfaces.map((surface) => ({ surface, partOfSpeech: "other" as const })),
  words: heard.map((word, index) => ({ text: word, startSec: index, endSec: index + 1 })),
});

/** Just the Word each Token starts on — most of these tests only care about that. */
const firsts = (ranges: WordRange[] | null) => ranges?.map(([first]) => first);

test("a Word covering several Tokens lights all of them together", () => {
  // 読み終わり is one Word and two Tokens; ました is one Word and two Tokens.
  assert.deepEqual(
    firsts(tokenWords(japanese(SURFACES, HEARD))),
    [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 5],
  );
});

test("Word and Token boundaries that do agree map one to one", () => {
  assert.deepEqual(
    tokenWords(japanese(SURFACES, SURFACES)),
    SURFACES.map((_, index) => [index, index + 1]),
  );
});

test("a Token spanning several Words takes the first of them", () => {
  // 十分 is one Token the ASR heard as two.
  const line = japanese(["駅", "まで", "十分"], ["駅", "まで", "十", "分"], "駅まで十分");
  assert.deepEqual(firsts(tokenWords(line)), [0, 1, 2]);
});

test("a surface that repeats aligns to successive occurrences, not all to the first", () => {
  // The second た must land on the second Word, or everything after it shifts.
  const mapping = firsts(tokenWords(japanese(SURFACES, HEARD))) as number[];
  assert.equal(mapping[2], 1); // た inside 買った
  assert.equal(mapping[9], 5); // た inside ました
});

test("the sweep never runs backwards", () => {
  const mapping = firsts(tokenWords(japanese(SURFACES, HEARD))) as number[];
  for (let i = 1; i < mapping.length; i++) {
    assert.ok(
      (mapping[i] as number) >= (mapping[i - 1] as number),
      `token ${i} went backwards`,
    );
  }
});

test("a Word the text does not contain leaves the rest of the Line aligned", () => {
  // ASR punctuation the transcript text never had.
  const line = japanese(SURFACES, [
    "昨日",
    "、",
    "買った",
    "本を",
    "もう",
    "読み終わり",
    "ました",
  ]);
  assert.deepEqual(firsts(tokenWords(line)), [0, 2, 2, 3, 3, 4, 5, 5, 6, 6, 6]);
});

test("nothing to reconcile means the caller falls back to Line-level highlight", () => {
  assert.equal(tokenWords(line(0, 2)), null); // neither
  assert.equal(tokenWords(japanese(SURFACES, [])), null); // Tokens but no Word timings
  assert.equal(tokenWords(japanese([], HEARD)), null); // Words but no Tokens
});

// ------------------------------------------------ a Token spans all of its Words

// What a Japanese ASR actually returns: one Word per character, against Tokens that
// are whole words. Measured on a real Transcript — 917 of 1154 Words a single kana.
const PER_CHARACTER = japanese(
  ["ゴンギツネ", "を", "読む"],
  [..."ゴンギツネを読む"],
  "ゴンギツネを読む",
);

test("a Token stays current for every Word it covers, not just its first", () => {
  // ゴンギツネ is Words 0-4, を is Word 5, 読む is Words 6-7. Lighting the Token only
  // on Word 0 made it flash for a fifth of its own sound and go out mid-word.
  const ranges = tokenWords(PER_CHARACTER) as WordRange[];
  assert.deepEqual(ranges, [
    [0, 5],
    [5, 6],
    [6, 8],
  ]);

  const states = (wordIndex: number) => ranges.map((range) => sweepState(range, wordIndex));
  for (const wordIndex of [0, 1, 2, 3, 4]) {
    assert.deepEqual(
      states(wordIndex),
      ["now", "pending", "pending"],
      `word ${wordIndex} should still be sounding ゴンギツネ`,
    );
  }
  assert.deepEqual(states(5), ["said", "now", "pending"]);
  assert.deepEqual(states(6), ["said", "said", "now"]);
});

test("the last Token in a Line stays current to the end of it", () => {
  // Nothing follows it to hand the sweep on to, so its range runs to the last Word.
  const ranges = tokenWords(PER_CHARACTER) as WordRange[];
  assert.deepEqual(ranges.at(-1), [6, 8]);
  assert.equal(sweepState(ranges.at(-1), 7), "now");
});

test("Tokens sharing a Word light together rather than one of them never lighting", () => {
  // A surface the text does not contain collapses onto its neighbour's Word, so both
  // Tokens start there. An empty range would leave the first one permanently "said".
  const line = japanese(["読み", "ます", "。"], ["読みます"], "読みます");
  const ranges = tokenWords(line) as WordRange[];
  assert.deepEqual(ranges, [
    [0, 1],
    [0, 1],
    [0, 1],
  ]);
  assert.deepEqual(
    ranges.map((range) => sweepState(range, 0)),
    ["now", "now", "now"],
  );
});

test("no range and no Word leave the piece unswept, so the whole Line lights", () => {
  // Tokens but no Word timings: `tokenWords` is null and every piece asks with
  // undefined. Word timings but nothing started yet: `wordIndex` is null.
  assert.equal(sweepState(undefined, 3), "");
  assert.equal(sweepState([0, 5], null), "");
});

test("Word slices put back the spaces the ASR left out", () => {
  const line: Line = {
    startSec: 0,
    endSec: 2,
    // What Whisper reports: bare words, no separators, punctuation split off.
    text: "I finished the book, thanks.",
    words: ["I", "finished", "the", "book", ",", "thanks", "."].map((text, i) => ({
      text,
      startSec: i,
      endSec: i + 1,
    })),
  };
  const slices = wordSlices(line) as string[];
  assert.deepEqual(slices, ["I", " finished", " the", " book", ",", " thanks", "."]);
  // The invariant that matters: what is rendered is exactly the Line's text.
  assert.equal(slices.join(""), line.text);
});

test("Word slices keep a leading space the ASR did report", () => {
  const line: Line = {
    startSec: 0,
    endSec: 2,
    text: "one two",
    words: [" one", " two"].map((text, i) => ({ text, startSec: i, endSec: i + 1 })),
  };
  assert.equal((wordSlices(line) as string[]).join(""), line.text);
});

test("the last Word slice carries the tail of the Line", () => {
  const line: Line = {
    startSec: 0,
    endSec: 2,
    text: "hello there!!",
    words: [
      { text: "hello", startSec: 0, endSec: 1 },
      { text: "there", startSec: 1, endSec: 2 },
    ],
  };
  assert.deepEqual(wordSlices(line), ["hello", " there!!"]);
});

test("no Word timings means no slices, and the Line renders whole", () => {
  assert.equal(wordSlices(line(0, 2)), null);
});
