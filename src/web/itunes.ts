import type { LanguageCode } from "../shared/model.ts";

/**
 * Suggests podcasts to study, from Apple's public search endpoint.
 *
 * `https://itunes.apple.com/search` answers a browser cross-origin, with no key and no
 * proxy — verified by hand, 200 with CORS headers, and although it labels itself
 * `text/javascript` the body is JSON that `response.json()` parses. That it hands back
 * `feedUrl` on every result is the whole reason this module exists: a feed URL is
 * exactly what `podcast-feed.ts` takes, so a suggestion is one click from an import.
 *
 * The obvious endpoint is the wrong one. Apple's top-charts feed at
 * `rss.marketingtools.apple.com` sends no CORS headers at all and fails with an opaque
 * `TypeError: Failed to fetch` — unusable from a page, and nothing here can fix that
 * from the browser side. Search is the replacement, so "recommended" below means
 * "what a good query returns", not "what is popular".
 *
 * Two of Apple's parameters do not do what their names promise, and both are worked
 * around rather than trusted:
 *   - `genreId` is accepted and ignored. Passing 1469 still returns results from other
 *     genres, so genre is filtered here, on each result's own `genreIds`.
 *   - `country` matters more than it looks like it should. Chinese terms against the CN
 *     storefront return very little; the same terms against US return the richest
 *     "learn X" catalogue. So every language is asked twice — once at home, once in the
 *     learner's market.
 *
 * There is a budget: Apple documents roughly 20 calls a minute, and one call takes
 * about 600ms. That is what the day cache at the bottom of this file is for.
 */

const SEARCH_ENDPOINT = "https://itunes.apple.com/search";

/** Apple's Language Learning genre. The id is the same in every storefront; only its
 *  name is localised ("Language Learning", "Aprendizaje de idiomas"). */
export const LANGUAGE_LEARNING_GENRE = "1498";

/** Results per query. Two queries per language, so this is the ceiling before dedupe. */
const DEFAULT_LIMIT = 20;

/** One podcast a reader could import, reduced to the fields the shelf shows. */
export interface PodcastSuggestion {
  /** Apple's id for the podcast, and the key duplicates are collapsed on. */
  collectionId: number;
  title: string;
  author: string;
  /** The reason this type exists: what the importer takes. Never empty. */
  feedUrl: string;
  artworkUrl: string;
  /** Apple's genre ids as strings, including `1498` when this is a learning podcast. */
  genreIds: string[];
  /** Absent when Apple did not say. */
  episodeCount?: number;
}

export interface PodcastQuery {
  term: string;
  /** An iTunes storefront, two letters: "JP", "US". */
  country: string;
  limit?: number;
}

/**
 * The three things this module would otherwise reach for through a global. All
 * optional, all defaulted, and the defaults are read at call time rather than at
 * import time so `node --test` can load this file with no DOM around it.
 */
export interface ItunesDeps {
  fetch?: typeof globalThis.fetch;
  /** Injected so a test can cross midnight without waiting for one. */
  now?: () => Date;
  /** Injected so a test needs no browser. Defaults to `localStorage`. */
  storage?: Pick<Storage, "getItem" | "setItem">;
}

/**
 * One search. Nothing is filtered by genre here — a caller asking for a term deserves
 * what the term returned — but a result with no `feedUrl` is dropped, because there is
 * nothing to import without one and a row that cannot be clicked is worse than absent.
 */
export async function searchPodcasts(
  query: PodcastQuery,
  deps: ItunesDeps = {},
): Promise<PodcastSuggestion[]> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("term", query.term);
  url.searchParams.set("media", "podcast");
  url.searchParams.set("country", query.country);
  url.searchParams.set("limit", String(query.limit ?? DEFAULT_LIMIT));

  let response: Response;
  try {
    response = await doFetch(url.toString());
  } catch (cause) {
    // Named by what was being looked for, the way `podcast-feed.ts` names the feed:
    // a cross-origin failure arrives as a bare TypeError with nothing in it.
    throw new Error(`Could not reach the podcast search for "${query.term}"`, { cause });
  }
  if (!response.ok) {
    throw new Error(`Podcast search for "${query.term}" failed with ${response.status}`);
  }

  // A 200 whose body is not the shape documented is treated as no results rather than
  // as an error: this endpoint is undocumented enough to change under us, and a shelf
  // that renders without suggestions beats a shelf that does not render.
  const body = (await response.json().catch(() => null)) as { results?: unknown } | null;
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.flatMap(toSuggestion);
}

function toSuggestion(raw: unknown): PodcastSuggestion[] {
  const result = raw as Record<string, unknown> | null;
  const feedUrl = string(result?.feedUrl);
  const collectionId = Number(result?.collectionId);
  // No feed, nothing to import. No id, nothing to dedupe on — every real result has
  // both, so either one missing means this entry is not a podcast we can offer.
  if (!feedUrl || !Number.isFinite(collectionId)) return [];

  const episodeCount = Number(result?.trackCount);
  return [
    {
      collectionId,
      title: string(result?.collectionName) || string(result?.trackName) || "Untitled podcast",
      author: string(result?.artistName),
      feedUrl,
      // Largest first: this is artwork on a shelf, and the 60px one is a favicon.
      artworkUrl:
        string(result?.artworkUrl600) ||
        string(result?.artworkUrl100) ||
        string(result?.artworkUrl60),
      genreIds: Array.isArray(result?.genreIds) ? result.genreIds.map(String) : [],
      ...(Number.isFinite(episodeCount) && { episodeCount }),
    },
  ];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Where a language's podcasts are, and what to ask for.
 *
 * `country` is the storefront the language's own catalogue lives in, and `term` is
 * written in that language because that is what its publishers title their shows in.
 * `learnerTerm` is the same language asked for the way a learner searches — in English,
 * against the US storefront, which is where the "learn X" shelf actually is.
 *
 * Two queries per language, deliberately. Every term is a request against a budget of
 * about twenty a minute, and a third one buys mostly what the first two already found.
 */
export interface Market {
  country: string;
  term: string;
  learnerTerm: string;
}

/** Where "learn X" is published, whatever X is. */
const LEARNER_MARKET = "US";

export const MARKETS: Record<LanguageCode, Market> = {
  ja: { country: "JP", term: "日本語 会話", learnerTerm: "learn japanese" },
  en: { country: "US", term: "english conversation", learnerTerm: "learn english" },
  "zh-CN": { country: "CN", term: "中文 学习", learnerTerm: "learn chinese" },
  // Traditional characters against the Taiwanese storefront; the simplified term finds
  // a different catalogue, which is the point of having both entries.
  "zh-TW": { country: "TW", term: "中文 學習", learnerTerm: "learn mandarin" },
  ko: { country: "KR", term: "한국어 회화", learnerTerm: "learn korean" },
  es: { country: "ES", term: "aprender español", learnerTerm: "learn spanish" },
  fr: { country: "FR", term: "apprendre le français", learnerTerm: "learn french" },
  de: { country: "DE", term: "deutsch lernen", learnerTerm: "learn german" },
};

/**
 * What to offer someone studying this language: both queries, merged, learning
 * podcasts first, and at most one round trip per day (see the cache below).
 *
 * A query that fails takes only its own results with it. The two ask different
 * storefronts and one of them being down, rate-limited or unreachable is not a reason
 * to show nothing — which is also why nothing here rethrows.
 */
export async function recommendedFor(
  language: LanguageCode,
  deps: ItunesDeps = {},
): Promise<PodcastSuggestion[]> {
  const cached = readCache(language, deps);
  if (cached) return cached;

  const market = MARKETS[language];
  const answers = await Promise.all(
    [
      { term: market.term, country: market.country },
      { term: market.learnerTerm, country: LEARNER_MARKET },
    ].map((query) => searchPodcasts(query, deps).catch(() => [])),
  );

  const byId = new Map<number, PodcastSuggestion>();
  // First query wins a tie: it is the one aimed at the language's own storefront.
  for (const suggestion of answers.flat()) {
    if (!byId.has(suggestion.collectionId)) byId.set(suggestion.collectionId, suggestion);
  }

  // Stable, so within each group the order stays Apple's relevance order.
  const suggestions = [...byId.values()].sort(
    (a, b) => Number(!isLearning(a)) - Number(!isLearning(b)),
  );

  // An empty answer is not cached. Both queries failing is a bad minute, not a fact
  // about the day, and locking it in would leave the shelf blank until midnight.
  if (suggestions.length > 0) writeCache(language, suggestions, deps);
  return suggestions;
}

function isLearning(suggestion: PodcastSuggestion): boolean {
  return suggestion.genreIds.includes(LANGUAGE_LEARNING_GENRE);
}

/**
 * The day cache: the page asks Apple at most once per language per natural day.
 *
 * It is in `localStorage` rather than IndexedDB, which is where everything else this
 * app keeps lives. Adding a store would mean a `DB_VERSION` bump and a migration for
 * data that is small, disposable and re-fetchable — and losing it costs one HTTP
 * request. `localStorage` is also allowed to be missing entirely: it throws in some
 * privacy modes and does not exist under `node --test`, so every read and write below
 * is wrapped and a failure degrades to "no cache", never to a broken screen.
 *
 * One key per language, with the day inside the value rather than in the key. Keying
 * by date would leave yesterday's entry behind forever, and nothing ever sweeps it.
 */
const CACHE_PREFIX = "duolistening.itunes.";

function cacheKey(language: LanguageCode): string {
  return CACHE_PREFIX + language;
}

/**
 * The reader's calendar day, not UTC's. `toISOString` would refresh the shelf at 09:00
 * in Tokyo and at 16:00 in Los Angeles; "once a day" should mean the day they are in.
 * The format only has to compare equal to itself, so it is not padded.
 */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function readCache(language: LanguageCode, deps: ItunesDeps): PodcastSuggestion[] | undefined {
  const today = localDay((deps.now ?? (() => new Date()))());
  try {
    const storage = deps.storage ?? globalThis.localStorage;
    const stored = JSON.parse(storage.getItem(cacheKey(language)) ?? "null") as {
      day?: unknown;
      suggestions?: unknown;
    } | null;
    if (stored?.day === today && Array.isArray(stored.suggestions)) {
      return stored.suggestions as PodcastSuggestion[];
    }
  } catch {
    // No storage, unreadable storage, or something that is not our JSON. All three
    // mean the same thing here: ask Apple.
  }
  return undefined;
}

function writeCache(
  language: LanguageCode,
  suggestions: PodcastSuggestion[],
  deps: ItunesDeps,
): void {
  const day = localDay((deps.now ?? (() => new Date()))());
  try {
    const storage = deps.storage ?? globalThis.localStorage;
    storage.setItem(cacheKey(language), JSON.stringify({ day, suggestions }));
  } catch {
    // A full or refusing quota costs one request tomorrow. Not worth failing over.
  }
}
