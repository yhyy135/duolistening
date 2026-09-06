// The contract between the server half and the web half. Both import from here.
// This file is the reason the project is one language (ADR 0006) — keep it free
// of runtime dependencies so either side can import it without dragging anything in.

/** The fixed language list behind both settings dropdowns. */
export const LANGUAGES = ["ja", "en", "zh-CN", "zh-TW", "ko", "es", "fr", "de"] as const;
export type LanguageCode = (typeof LANGUAGES)[number];

/** Japanese unlocks the Token features (furigana, part-of-speech colouring). */
export const JAPANESE = "ja" satisfies LanguageCode;

/** Shown in the settings dropdowns, and named to the Text Model in prompts. */
export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  ja: "Japanese",
  en: "English",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
};

export type ResourceId = string;

/** Where a Resource came from, and enough to fetch it again. */
export type SourceRef =
  | { kind: "youtube"; url: string }
  | { kind: "podcast"; feedUrl: string; episodeUrl: string; title: string };

/** One episode of a podcast feed, as offered in the picker before import. */
export interface Episode {
  title: string;
  /** The enclosure URL — what gets fetched if the user picks this one. */
  audioUrl: string;
  durationSec?: number;
  /** ISO 8601. */
  publishedAt?: string;
}

/**
 * One entry in a Line's word-level timing data, used for karaoke-style
 * highlighting. Absent wholesale when the Transcription Model returns no
 * word timestamps — playback then falls back to Line-level highlight (ADR 0004).
 */
export interface Word {
  text: string;
  startSec: number;
  endSec: number;
}

/**
 * Normalised part-of-speech buckets. The Japanese analyzer's own labels
 * (名詞 / 動詞 / 助詞 / …) are mapped onto these inside the Annotator, so the web
 * half never sees analyzer vocabulary and the colour map stays a closed set.
 */
export type PartOfSpeech =
  | "noun"
  | "verb"
  | "adjective"
  | "adverb"
  | "particle"
  | "auxiliary"
  | "conjunction"
  | "prefix"
  | "interjection"
  | "symbol"
  | "other";

/**
 * One morpheme of a Line, from the Japanese morphological analyzer (ADR 0005).
 * Carries no timestamp: Token boundaries need not line up with Word boundaries,
 * and for Japanese they frequently don't.
 */
export interface Token {
  surface: string;
  /** Kana reading, for furigana. Absent when the surface has no kanji. */
  reading?: string;
  partOfSpeech: PartOfSpeech;
}

export interface Line {
  startSec: number;
  endSec: number;
  /** Target-language text, as transcribed. */
  text: string;
  /** Native-language text. Absent until annotation has run. */
  translation?: string;
  words?: Word[];
  /** Only present when the Resource's targetLanguage is Japanese. */
  tokens?: Token[];
}

/** Ordered, gap-tolerant, covers the Resource's full duration. */
export type Transcript = Line[];

export type ImportPhase =
  "queued" | "fetching" | "transcribing" | "annotating" | "ready" | "failed";

export interface Resource {
  id: ResourceId;
  source: SourceRef;
  title: string;
  durationSec: number;
  /**
   * The language pair this Resource was transcribed and translated in — recorded
   * here rather than read from Settings at display time, so changing your settings
   * later cannot misdescribe Transcripts that already exist.
   */
  targetLanguage: LanguageCode;
  nativeLanguage: LanguageCode;
  /** ISO 8601. */
  importedAt: string;
  phase: ImportPhase;
  failureReason?: string;
  /** Where playback stopped last time, so the Library can drop the user back in. */
  lastPositionSec?: number;
}

export interface ModelSlot {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Holds API keys in the clear. Never hand a Settings object to the browser as-is —
 * the read path masks both apiKey fields; the write path treats a masked value as
 * "leave unchanged".
 */
export interface Settings {
  textModel: ModelSlot;
  transcriptionModel: ModelSlot;
  nativeLanguage: LanguageCode;
  targetLanguage: LanguageCode;
}

/** Every key the Storage seam is asked for, in one place (ADR 0007). */
export const storageKeys = {
  settings: "settings.json",
  /**
   * The Library shelf: one document holding every Resource in full. Deliberately
   * not split into per-Resource metadata files — one read renders the whole shelf,
   * and there is only ever one writer.
   */
  index: "resources/index.json",
  transcript: (id: ResourceId) => `resources/${id}/transcript.json`,
  audio: (id: ResourceId) => `resources/${id}/audio.m4a`,
  /** Everything belonging to one Resource — what a delete must cascade over. */
  resourcePrefix: (id: ResourceId) => `resources/${id}/`,
} as const;

export type JobId = string;

/**
 * What an import job looks like from the outside: the POST /api/imports reply and
 * every SSE frame it then streams. Lives here rather than in the server's ports
 * because the web half reads it too.
 */
export interface JobState {
  id: JobId;
  resourceId: ResourceId;
  phase: ImportPhase;
  /** 0..1 within the current phase. */
  progress?: number;
  failureReason?: string;
}
