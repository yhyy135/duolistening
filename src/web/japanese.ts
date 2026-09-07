import kuromoji from "kuromoji";
import type { PartOfSpeech, Token } from "../shared/model.ts";

/**
 * Splits Japanese text into Tokens carrying part-of-speech and kana reading
 * (ADR 0005). Synchronous and offline once built — building it reads a dictionary
 * of tens of megabytes, so build one and share it.
 */
export interface JapaneseTokenizer {
  tokenize(text: string): Token[];
}

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
 * and takes about a second — build one and pass it around rather than calling this
 * per Line.
 *
 * Where that dictionary lives is the caller's to say, because Node and a browser
 * disagree about what a location is and this module has to run in both: the test
 * hands it the copy inside `node_modules`, the app hands it a URL path. kuromoji
 * itself needs no help with the difference — its package.json swaps NodeDictionary-
 * Loader for an XHR one under a bundler's `browser` field, so only `dicPath` changes.
 *
 * What `dicPath` may not be is an absolute URL. The loader joins each filename on
 * with Node's `path.join`, which collapses `https://host/dict` into `https:/host/dict`
 * and fetches nothing. It has to be a same-origin path — `/kuromoji/dict` — which
 * means the twelve `.dat.gz` files (17MB on disk, gunzipped in the browser by
 * kuromoji's own zlibjs, ADR 0008) must be served from this origin. Getting them
 * there is a build concern and deliberately not this module's.
 */
export function createKuromojiTokenizer(dicPath: string): Promise<JapaneseTokenizer> {
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
 * eagerly would cost every reader a download of tens of megabytes and a second of
 * startup, including the ones studying a language that has no use for it.
 */
export function createJapaneseTokenizerOnce(dicPath: string): () => Promise<JapaneseTokenizer> {
  let pending: Promise<JapaneseTokenizer> | null = null;
  return () => (pending ??= createKuromojiTokenizer(dicPath));
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
