import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Token, Transcript } from "../shared/model.ts";
import { createAnnotator } from "./annotator.ts";
import type { JapaneseTokenizer, TextModel } from "./ports.ts";

/** Answers every translation request with whatever `reply` makes of the prompt. */
function stubTextModel(reply: (prompt: string) => unknown): TextModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async () => "unused",
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

const stubTokenizer = (): JapaneseTokenizer & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    tokenize: (text: string): Token[] => {
      calls.push(text);
      return [{ surface: text, reading: "よみ", partOfSpeech: "noun" }];
    },
  };
};

const lines = (count: number): Transcript =>
  Array.from({ length: count }, (_, index) => ({
    startSec: index,
    endSec: index + 1,
    text: `台詞${index}`,
  }));

const japanese = { nativeLanguage: "zh-CN", targetLanguage: "ja" } as const;

describe("annotator", () => {
  it("does nothing, and calls nothing, for an empty transcript", async () => {
    const textModel = stubTextModel(translateEverything);
    const result = await createAnnotator({ textModel }).annotate([], japanese);

    assert.deepEqual(result, []);
    assert.equal(textModel.prompts.length, 0);
  });

  it("fills in a translation for every line", async () => {
    const annotator = createAnnotator({ textModel: stubTextModel(translateEverything) });
    const result = await annotator.annotate(lines(3), japanese);

    assert.deepEqual(
      result.map((line) => line.translation),
      ["translated:台詞0", "translated:台詞1", "translated:台詞2"],
    );
  });

  it("splits long transcripts into batches", async () => {
    const textModel = stubTextModel(translateEverything);
    const annotator = createAnnotator({ textModel, batchSize: 10 });

    const result = await annotator.annotate(lines(25), japanese);

    assert.equal(textModel.prompts.length, 3);
    assert.equal(result.at(-1)?.translation, "translated:台詞24");
  });

  it("matches replies by index, so a reordered reply still lands correctly", async () => {
    const textModel = stubTextModel((prompt) => translateEverything(prompt).reverse());
    const result = await createAnnotator({ textModel }).annotate(lines(3), japanese);

    assert.equal(result[0]?.translation, "translated:台詞0");
    assert.equal(result[2]?.translation, "translated:台詞2");
  });

  it("leaves a skipped line untranslated instead of shifting its neighbour's up", async () => {
    const textModel = stubTextModel((prompt) =>
      translateEverything(prompt).filter((entry) => entry.i !== 1),
    );
    const result = await createAnnotator({ textModel }).annotate(lines(3), japanese);

    assert.equal(result[0]?.translation, "translated:台詞0");
    assert.equal(result[1]?.translation, undefined);
    assert.equal(result[2]?.translation, "translated:台詞2");
  });

  it("survives a reply that is not the shape it asked for", async () => {
    const textModel = stubTextModel(() => ({ sorry: "no" }));
    const result = await createAnnotator({ textModel }).annotate(lines(2), japanese);

    assert.deepEqual(
      result.map((line) => line.translation),
      [undefined, undefined],
    );
  });

  it("adds tokens for Japanese", async () => {
    const tokenizer = stubTokenizer();
    const annotator = createAnnotator({
      textModel: stubTextModel(translateEverything),
      tokenizer,
    });

    const result = await annotator.annotate(lines(2), japanese);

    assert.deepEqual(tokenizer.calls, ["台詞0", "台詞1"]);
    assert.equal(result[0]?.tokens?.[0]?.reading, "よみ");
  });

  it("leaves tokens off entirely for other target languages", async () => {
    const tokenizer = stubTokenizer();
    const annotator = createAnnotator({
      textModel: stubTextModel(translateEverything),
      tokenizer,
    });

    const result = await annotator.annotate(lines(2), {
      nativeLanguage: "zh-CN",
      targetLanguage: "en",
    });

    assert.deepEqual(tokenizer.calls, []);
    assert.equal(result[0]?.tokens, undefined);
  });

  it("returns new lines rather than editing the ones it was handed", async () => {
    const input = lines(2);
    const annotator = createAnnotator({ textModel: stubTextModel(translateEverything) });

    await annotator.annotate(input, japanese);

    assert.deepEqual(input, lines(2));
  });

  it("reports progress up to completion", async () => {
    const seen: number[] = [];
    const annotator = createAnnotator({
      textModel: stubTextModel(translateEverything),
      batchSize: 10,
    });

    await annotator.annotate(lines(25), { ...japanese, onProgress: (f) => seen.push(f) });

    assert.equal(seen.length, 3);
    assert.equal(seen.at(-1), 1);
  });
});
