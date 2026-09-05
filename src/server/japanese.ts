import { createRequire } from "node:module";
import * as path from "node:path";
import kuromoji from "kuromoji";
import type { PartOfSpeech, Token } from "../shared/model.ts";
import type { JapaneseTokenizer } from "./ports.ts";

/** kuromoji's own labels, mapped once here so nothing downstream speaks them. */
const PART_OF_SPEECH: Record<string, PartOfSpeech> = {
  名詞: "noun",
  動詞: "verb",
  形容詞: "adjective",
  副詞: "adverb",
  助詞: "particle",
  助動詞: "auxiliary",
  接続詞: "conjunction",
  接頭詞: "prefix",
  感動詞: "interjection",
  フィラー: "interjection", // えーと, あの — hesitation, close enough to an interjection
  記号: "symbol",
  連体詞: "other", // adnominals (この, 大きな) have no bucket of their own; don't pretend
};

const HAS_KANJI = /[㐀-䶿一-鿿]/;

/**
 * Builds the Japanese tokenizer (ADR 0005). Reads tens of megabytes of dictionary
 * and takes about a second — build one at startup and pass it around rather than
 * calling this per request.
 */
export function createKuromojiTokenizer(): Promise<JapaneseTokenizer> {
  const require = createRequire(import.meta.url);
  const dicPath = path.join(path.dirname(require.resolve("kuromoji/package.json")), "dict");

  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((error, tokenizer) => {
      if (error) return reject(error);
      resolve({
        tokenize: (text: string): Token[] => tokenizer.tokenize(text).map(toToken),
      });
    });
  });
}

/**
 * Wraps the builder so the dictionary is read at most once, on first use. Loading it
 * eagerly would cost every deployment a second of startup and tens of megabytes,
 * including the ones studying a language that has no use for it.
 */
export function createJapaneseTokenizerOnce(): () => Promise<JapaneseTokenizer> {
  let pending: Promise<JapaneseTokenizer> | null = null;
  return () => (pending ??= createKuromojiTokenizer());
}

function toToken(word: kuromoji.IpadicFeatures): Token {
  const surface = word.surface_form;
  // `reading`, not `pronunciation`: pronunciation writes long vowels as ー
  // (ショーカイ), which is how it sounds but not how the furigana is written.
  const reading = word.reading ? katakanaToHiragana(word.reading) : undefined;
  return {
    surface,
    // Furigana over kana would just repeat the word back at the reader.
    ...(reading && HAS_KANJI.test(surface) && { reading }),
    partOfSpeech: PART_OF_SPEECH[word.pos] ?? "other",
  };
}

function katakanaToHiragana(katakana: string): string {
  return katakana.replace(/[ァ-ヶ]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 0x60),
  );
}
