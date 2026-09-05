// Runs against the real dictionary — the mapping from kuromoji's output to ours is
// exactly the kind of thing that is quietly wrong with a stub. Loading costs about
// a second, once for the whole file.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Token } from "../shared/model.ts";
import { createKuromojiTokenizer } from "./japanese.ts";
import type { JapaneseTokenizer } from "./ports.ts";

describe("japanese tokenizer", () => {
  let tokenizer: JapaneseTokenizer;
  let tokens: Token[];

  before(async () => {
    tokenizer = await createKuromojiTokenizer();
    // The line from the reference screenshot.
    tokens = tokenizer.tokenize("今日は自己紹介をします");
  });

  it("splits a sentence into morphemes", () => {
    assert.deepEqual(
      tokens.map((token) => token.surface),
      ["今日", "は", "自己", "紹介", "を", "し", "ます"],
    );
  });

  it("gives readings in hiragana, because that is what furigana is written in", () => {
    assert.equal(tokens[0]?.reading, "きょう");
    assert.equal(tokens[3]?.reading, "しょうかい");
  });

  it("writes long vowels the way furigana does, not the way they sound", () => {
    // kuromoji's `pronunciation` for 紹介 is ショーカイ; furigana wants しょうかい.
    assert.equal(tokens[3]?.reading, "しょうかい");
    assert.ok(!tokens[3]?.reading?.includes("ー"));
  });

  it("omits readings for kana, which need no furigana", () => {
    assert.equal(tokens[1]?.reading, undefined); // は
    assert.equal(tokens[4]?.reading, undefined); // を
    assert.equal(tokens[6]?.reading, undefined); // ます
  });

  it("maps parts of speech onto our own buckets", () => {
    assert.deepEqual(
      tokens.map((token) => token.partOfSpeech),
      ["noun", "particle", "noun", "noun", "particle", "verb", "auxiliary"],
    );
  });

  it("labels anything it doesn't recognise rather than dropping it", () => {
    for (const token of tokenizer.tokenize("えーと、これはXYZだ")) {
      assert.ok(token.surface.length > 0);
      assert.ok(token.partOfSpeech);
    }
  });
});
