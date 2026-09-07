// Runs against the real dictionary — the mapping from kuromoji's output to ours is
// exactly the kind of thing that is quietly wrong with a stub. Loading costs about
// a second, once for the whole file.
//
// Where that dictionary is, is the parameter: under Node it is the copy npm already
// installed, resolved here rather than in the module so the module itself imports
// nothing from `node:`. In a browser the same argument is a same-origin path the
// files are served from — see the note on `createKuromojiTokenizer`.

import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as path from "node:path";
import type { Token } from "../shared/model.ts";
import { createKuromojiTokenizer, type JapaneseTokenizer } from "./japanese.ts";

const require = createRequire(import.meta.url);
const dicPath = path.join(path.dirname(require.resolve("kuromoji/package.json")), "dict");

describe("japanese tokenizer", () => {
  let tokenizer: JapaneseTokenizer;
  let tokens: Token[];

  before(async () => {
    tokenizer = await createKuromojiTokenizer(dicPath);
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

  it("carries no timestamp, because a Token is not a Word (ADR 0005)", () => {
    // The two disagree on boundaries — 自己紹介 is one ASR Word and two Tokens —
    // so a Token never gains timing and the arrays are never merged.
    for (const token of tokens) {
      assert.deepEqual(
        Object.keys(token).filter((key) => key.endsWith("Sec")),
        [],
      );
    }
  });
});
