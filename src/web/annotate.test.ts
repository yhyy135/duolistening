import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transcript } from "../shared/model.ts";
import {
  BLOCK_LINES,
  createAnnotator,
  nextWindow,
  wantsJapanese,
  type TranslationModel,
} from "./annotate.ts";

/** Answers every translation request with whatever `reply` makes of the prompt. */
function stubTextModel(
  reply: (prompt: string) => unknown,
): TranslationModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    completeJson: async <T>(prompt: string) => {
      prompts.push(prompt);
      return reply(prompt) as T;
    },
  };
}

/** Echoes each line back, numbered the way the prompt asked for. */
const translateEverything = (prompt: string) =>
  [...prompt.matchAll(/^(\d+): (.+)$/gm)].map((match) => ({
    i: Number(match[1]),
    t: `translated:${match[2]}`,
  }));

const lines = (count: number): Transcript =>
  Array.from({ length: count }, (_, index) => ({
    startSec: index,
    endSec: index + 1,
    text: `台詞${index}`,
  }));

const japanese = { nativeLanguage: "zh-CN", targetLanguage: "ja" } as const;

test("does nothing, and calls nothing, for an empty transcript", async () => {
  const textModel = stubTextModel(translateEverything);
  const result = await createAnnotator({ textModel }).annotate([], japanese);

  assert.deepEqual(result, []);
  assert.equal(textModel.prompts.length, 0);
});

test("fills in a translation for every line", async () => {
  const annotator = createAnnotator({ textModel: stubTextModel(translateEverything) });
  const result = await annotator.annotate(lines(3), japanese);

  assert.deepEqual(
    result.map((line) => line.translation),
    ["translated:台詞0", "translated:台詞1", "translated:台詞2"],
  );
});

test("sends the Lines it is handed as one request, however many there are", async () => {
  // A window is one request (ADR 0011). Cutting it into batches sent side by side put
  // two and three requests in flight at once, against providers that count them.
  const textModel = stubTextModel(translateEverything);
  const count = 3 * BLOCK_LINES;
  const result = await createAnnotator({ textModel }).annotate(lines(count), japanese);

  assert.equal(textModel.prompts.length, 1);
  assert.equal(result.at(-1)?.translation, `translated:台詞${count - 1}`);
});

test("matches replies by index, so a reordered reply still lands correctly", async () => {
  const textModel = stubTextModel((prompt) => translateEverything(prompt).reverse());
  const result = await createAnnotator({ textModel }).annotate(lines(3), japanese);

  assert.equal(result[0]?.translation, "translated:台詞0");
  assert.equal(result[2]?.translation, "translated:台詞2");
});

test("leaves a skipped line untranslated instead of shifting its neighbour's up", async () => {
  const textModel = stubTextModel((prompt) =>
    translateEverything(prompt).filter((entry) => entry.i !== 1),
  );
  const result = await createAnnotator({ textModel }).annotate(lines(3), japanese);

  assert.equal(result[0]?.translation, "translated:台詞0");
  assert.equal(result[1]?.translation, undefined);
  assert.equal(result[2]?.translation, "translated:台詞2");
});

test("survives a reply that is not the shape it asked for", async () => {
  const textModel = stubTextModel(() => ({ sorry: "no" }));
  const result = await createAnnotator({ textModel }).annotate(lines(2), japanese);

  assert.deepEqual(
    result.map((line) => line.translation),
    [undefined, undefined],
  );
});

test("translates, and tokenizes nothing — Tokens are the player's now (ADR 0015)", async () => {
  const textModel = stubTextModel(translateEverything);
  const words = [{ text: "台詞", startSec: 0, endSec: 0.5 }];
  const result = await createAnnotator({ textModel }).annotate(
    [{ startSec: 0, endSec: 1, text: "台詞0", words }],
    japanese,
  );

  assert.equal(result[0]?.translation, "translated:台詞0");
  assert.equal(result[0]?.tokens, undefined);
  // Word is ASR timing and Token is morphology; nothing here touches either.
  assert.deepEqual(result[0]?.words, words);
});

test("names no source language when the user never set one", async () => {
  const textModel = stubTextModel(translateEverything);
  const kana: Transcript = [{ startSec: 0, endSec: 1, text: "これは日本語です" }];
  await createAnnotator({ textModel }).annotate(kana, { nativeLanguage: "zh-CN" });

  // The model reads it off the lines, which is the whole point of leaving it empty.
  assert.match(textModel.prompts[0] as string, /^Translate each numbered line into /);
});

test("returns new lines rather than editing the ones it was handed", async () => {
  const input = lines(2);
  const annotator = createAnnotator({ textModel: stubTextModel(translateEverything) });

  await annotator.annotate(input, japanese);

  assert.deepEqual(input, lines(2));
});

test("the Japanese question is answered by every Line, not by a window of them", () => {
  // The player annotates a window at a time (ADR 0011). Asking a window that happens
  // to hold no kana would turn Tokens off for those Lines and on for their
  // neighbours, so the caller settles it once over the whole Transcript.
  const mixed: Transcript = [
    { startSec: 0, endSec: 1, text: "OK" },
    { startSec: 1, endSec: 2, text: "そうですね" },
  ];
  assert.equal(wantsJapanese(mixed), true);
  assert.equal(wantsJapanese(mixed.slice(0, 1)), false, "the window would say no");
  // A stated language is never second-guessed by the text.
  assert.equal(wantsJapanese(mixed, "es"), false);
  assert.equal(wantsJapanese([], "ja"), true);
});

// ---------------------------------------------------------------- nextWindow

/** A Transcript with `translated` of its Lines already done, from the start. */
const partly = (count: number, translated: number): Transcript =>
  lines(count).map((line, index) =>
    index < translated ? { ...line, translation: "译" } : line,
  );

const none = new Set<number>();

test("one window reaches a block behind the listener and a block ahead, in one request", () => {
  const window = nextWindow(partly(400, 0), 3 * BLOCK_LINES + 5, none);

  // Blocks 2, 3 and 4: what was just said, what is on screen, and what is about to be —
  // one span, so one request, where it used to be two in flight and a third behind them.
  assert.deepEqual(window, { from: 2 * BLOCK_LINES, to: 5 * BLOCK_LINES, blocks: [2, 3, 4] });
});

test("listening on through a window asks for one new block at each crossing", () => {
  const asked = new Set([2, 3, 4]);
  assert.equal(nextWindow(partly(400, 0), 3 * BLOCK_LINES + 5, asked), null);

  // Into block 4, which brings block 5 into the window — and only block 5 goes out.
  assert.deepEqual(nextWindow(partly(400, 0), 4 * BLOCK_LINES, asked), {
    from: 5 * BLOCK_LINES,
    to: 6 * BLOCK_LINES,
    blocks: [5],
  });
});

test("a translated block between two missing ones splits the window, and ahead goes first", () => {
  // Never one request spanning all three: that would pay again for the block in the middle.
  const patchy = lines(400).map((line, index) =>
    index >= 3 * BLOCK_LINES && index < 4 * BLOCK_LINES ? { ...line, translation: "译" } : line,
  );
  assert.deepEqual(nextWindow(patchy, 3 * BLOCK_LINES + 5, none)?.blocks, [4]);
  assert.deepEqual(nextWindow(patchy, 3 * BLOCK_LINES + 5, new Set([4]))?.blocks, [2]);
});

test("a block already translated is never asked for again", () => {
  // Reopening an episode whose first two blocks came back last time. Nothing is
  // asked for at the top, because those two *are* the window there — the store is
  // read before the model is, which is what makes the second visit free.
  const reopened = partly(200, 2 * BLOCK_LINES);
  assert.equal(nextWindow(reopened, 0, none), null);
  // Listening on into the second block moves the window, and only then does the
  // third go out.
  assert.deepEqual(nextWindow(reopened, BLOCK_LINES + 5, none), {
    from: 2 * BLOCK_LINES,
    to: 3 * BLOCK_LINES,
    blocks: [2],
  });
  assert.equal(nextWindow(partly(200, 200), 0, none), null, "nothing left to do");
});

test("before playback has started, the window is the top of the Transcript", () => {
  // -1 is what `locate` answers before the first Line, which is where the screen
  // opens — and it is a real position, not a missing one.
  assert.deepEqual(nextWindow(partly(200, 0), -1, none)?.blocks, [0, 1]);
});

test("a short Transcript is one window, and an empty one is no work at all", () => {
  assert.deepEqual(nextWindow(partly(5, 0), 0, none), { from: 0, to: 5, blocks: [0] });
  assert.equal(nextWindow([], 0, none), null);
});

test("a listener past the last Line is not sent looking off the end", () => {
  const window = nextWindow(partly(2 * BLOCK_LINES + 5, 0), 999, none);
  assert.deepEqual(window, { from: BLOCK_LINES, to: 2 * BLOCK_LINES + 5, blocks: [1, 2] });
});

test("a Line the model skipped does not put its block back in the queue", () => {
  // Asked, answered, and one entry missing from the reply. Retrying on every render
  // would be an infinite request loop against a model that will skip it again.
  const gappy = partly(BLOCK_LINES, BLOCK_LINES).map((line, index) =>
    index === 7 ? { ...line, translation: undefined } : line,
  );
  assert.equal(nextWindow(gappy, 0, new Set([0])), null);
  assert.deepEqual(nextWindow(gappy, 0, none)?.blocks, [0], "a fresh visit tries once");
});
