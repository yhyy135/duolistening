// The contract between the server half and the web half. Both import from here.
// This file is the reason the project is one language (ADR 0006) — keep it free
// of runtime dependencies so either side can import it without dragging anything in.

/** The fixed language list behind both settings dropdowns, in the order they list it. */
export const LANGUAGES = ["en", "zh-CN", "zh-TW", "ja", "ko", "de", "fr", "es"] as const;
export type LanguageCode = (typeof LANGUAGES)[number];

/** Japanese unlocks the Token features (furigana, part-of-speech colouring). */
export const JAPANESE = "ja" satisfies LanguageCode;

/**
 * English on purpose: this is the name handed to the Text Model in a translation
 * prompt, where a stable one matters more than a localised one. It is **not** for
 * labelling the interface — `languageName` in shared/i18n.ts writes a language's name
 * in whatever language the reader is reading, and this is only its last-resort
 * fallback.
 */
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
  /** The episode's own cover, when the feed gives it one. The show's otherwise. */
  artworkUrl?: string;
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
  /** Only present when the Line's text is Japanese. */
  tokens?: Token[];
}

/** Ordered, gap-tolerant, covers the Resource's full duration. */
export type Transcript = Line[];

/**
 * `untranscribed` is a finished import that has audio and no Transcript, which is
 * what an import does when no Transcription Model is configured. It is a resting
 * state rather than a failure — the episode plays — but not `ready` either, because
 * there is work left that a Resume can still do once a model is filled in.
 */
export type ImportPhase =
  "queued" | "fetching" | "transcribing" | "annotating" | "untranscribed" | "ready" | "failed";

export interface Resource {
  id: ResourceId;
  source: SourceRef;
  title: string;
  /** The show this episode belongs to — the feed's own title, when it had one. */
  showTitle?: string;
  /**
   * The cover, as the URL the feed gave for it. Loaded straight from whoever hosts it
   * and never stored, which is why a Library opened offline shows a monogram in its
   * place (`cover.tsx`). Absent on anything imported before covers were recorded.
   */
  artworkUrl?: string;
  durationSec: number;
  /**
   * The language pair this Resource was transcribed and translated in — recorded
   * here rather than read from Settings at display time, so changing your settings
   * later cannot misdescribe Transcripts that already exist. The studied language is
   * absent when the import was left to detect it, which is the default.
   */
  targetLanguage?: LanguageCode;
  nativeLanguage: LanguageCode;
  /** ISO 8601. */
  importedAt: string;
  phase: ImportPhase;
  /**
   * Whether the audio for this Resource is in the store. The phase cannot answer that
   * on its own: `failed` says an import stopped, not where — and one that downloaded
   * an episode and then could not transcribe it leaves behind something that plays
   * perfectly. Without this the shelf refuses to open it, over bytes it already has.
   *
   * Absent on a Resource imported before this existed, and on one restored from a
   * backup, since a backup carries Transcripts and not audio.
   */
  hasAudio?: boolean;
  failureReason?: string;
  /** Where playback stopped last time, so the Library can drop the user back in. */
  lastPositionSec?: number;
  /** ISO 8601. When that position was written — what "continue listening" picks by. */
  lastPlayedAt?: string;
}

/**
 * A show the reader starred to come back to, kept by its feed URL with everything its
 * tile on the home screen draws — so showing the Favorites asks nobody for anything. Not
 * a subscription: nothing is fetched or imported because a show is here.
 */
export interface Favorite {
  feedUrl: string;
  title: string;
  /** The feed's `itunes:author`, when it names one. */
  author?: string;
  /** The show's cover, as the feed gave it, and loaded from its host like every cover. */
  artworkUrl?: string;
  /** ISO 8601. The tiles are newest first, and nothing else reorders them. */
  addedAt: string;
}

export interface ModelSlot {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Whether a slot has enough in it to call. The key is deliberately not part of the
 * answer: a model served from the reader's own machine wants no key, and demanding
 * one here would refuse to talk to it.
 *
 * Asked before building a client rather than after one fails, because the two slots
 * are optional in different ways now — an import with no Transcription Model stores
 * the audio and stops (see `ImportPhase`), and a player with no Text Model shows the
 * Lines without translating them. Both are quiet, and neither should be a failed
 * request to a base URL that is the empty string.
 */
export function slotConfigured(slot: ModelSlot | undefined): boolean {
  return Boolean(slot?.baseUrl.trim() && slot.model.trim());
}

/**
 * Where the byte proxy lives (ADR 0009). Addressed like a model slot and for the
 * same reason: it is a separately deployed thing this half only knows by URL, so
 * nothing about it is compiled into the page and a reader can point at one they run
 * themselves.
 */
export interface ProxySettings {
  /** The deployed Worker, e.g. `https://proxy.example.workers.dev/`. */
  baseUrl: string;
  /**
   * The Worker's `PROXY_KEY`, which it wants as `?k=` on every request.
   *
   * It is a genuine shared secret *because* it lives here — typed in by each reader
   * and handed out of band — rather than being a constant compiled into a bundle
   * anyone who loads the page can read. It is also the proxy's only gate, so an
   * empty one means whoever finds the URL may use it.
   */
  key: string;
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
  /**
   * What the user is studying. Optional: unset means the Transcription Model is left
   * to detect the recording's own language and the translation prompt is not told
   * one either, which is what makes a mixed shelf work without editing this first.
   */
  targetLanguage?: LanguageCode;
  /**
   * The byte proxy every import fetches through — the one thing a browser cannot do
   * for itself (ADR 0009). Optional in the same sense a blank model slot is: nothing
   * can be imported until it is filled in, but a fresh install has not filled in
   * anything yet.
   */
  proxy?: ProxySettings;
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

/** How one model slot answered when it was tried. */
export interface SlotCheck {
  ok: boolean;
  /** Empty when ok; otherwise already-readable text explaining what went wrong. */
  detail: string;
}

/**
 * The reply to a connection test. Each slot is tried the way the import pipeline
 * will actually use it, so a pass here means that endpoint, key and model name work
 * together — not merely that the host resolves.
 */
export interface SettingsCheck {
  textModel: SlotCheck;
  transcriptionModel: SlotCheck;
}
