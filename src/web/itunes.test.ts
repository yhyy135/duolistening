import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LANGUAGES } from "../shared/model.ts";
import {
  LANGUAGE_LEARNING_GENRE,
  MARKETS,
  recommendedFor,
  searchPodcasts,
  type PodcastSuggestion,
} from "./itunes.ts";

/** One raw result, in the shape Apple's search actually sends. */
const result = (over: Record<string, unknown> = {}) => ({
  collectionId: 1,
  collectionName: "Let's Talk in Japanese!",
  artistName: "Tomo",
  feedUrl: "https://feeds.example/ltij.xml",
  artworkUrl600: "https://art.example/600.jpg",
  genreIds: ["1498", "1301"],
  trackCount: 405,
  ...over,
});

/** An answer per search term, so two queries can be given different fates. */
type Answer = unknown[] | (() => Response);

function apple(answers: Record<string, Answer>) {
  const urls: URL[] = [];
  const impl: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    const answer = answers[url.searchParams.get("term") ?? ""] ?? [];
    if (typeof answer === "function") return answer();
    // Apple labels this `text/javascript`; the body is JSON either way.
    return new Response(JSON.stringify({ resultCount: answer.length, results: answer }), {
      headers: { "content-type": "text/javascript" },
    });
  };
  return { impl, urls, terms: () => urls.map((url) => url.searchParams.get("term")) };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

const clock = (iso: string) => () => new Date(iso);

describe("one search", () => {
  it("asks for podcasts in the storefront it was given", async () => {
    const fetch = apple({ "日本語 会話": [result()] });
    await searchPodcasts(
      { term: "日本語 会話", country: "JP", limit: 5 },
      { fetch: fetch.impl },
    );

    const url = fetch.urls[0];
    assert.equal(`${url?.origin}${url?.pathname}`, "https://itunes.apple.com/search");
    assert.equal(url?.searchParams.get("term"), "日本語 会話");
    assert.equal(url?.searchParams.get("media"), "podcast");
    assert.equal(url?.searchParams.get("country"), "JP");
    assert.equal(url?.searchParams.get("limit"), "5");
  });

  it("reads the fields the shelf shows", async () => {
    const fetch = apple({ x: [result()] });
    const [suggestion] = await searchPodcasts(
      { term: "x", country: "JP" },
      { fetch: fetch.impl },
    );

    assert.deepEqual(suggestion, {
      collectionId: 1,
      title: "Let's Talk in Japanese!",
      author: "Tomo",
      feedUrl: "https://feeds.example/ltij.xml",
      artworkUrl: "https://art.example/600.jpg",
      genreIds: ["1498", "1301"],
      episodeCount: 405,
    });
  });

  it("drops a result with no feed to import", async () => {
    // Apple returns these: a show it knows about but holds no feed URL for. There is
    // nothing to hand the importer, so a row for it could only disappoint.
    const fetch = apple({
      x: [result({ collectionId: 1, feedUrl: undefined }), result({ collectionId: 2 })],
    });
    const found = await searchPodcasts({ term: "x", country: "JP" }, { fetch: fetch.impl });

    assert.deepEqual(
      found.map((suggestion) => suggestion.collectionId),
      [2],
    );
  });

  it("copes with the pieces a partial result leaves out", async () => {
    const fetch = apple({
      x: [{ collectionId: 7, feedUrl: "https://feeds.example/7.xml", artworkUrl60: "s.jpg" }],
    });
    const [suggestion] = await searchPodcasts(
      { term: "x", country: "US" },
      { fetch: fetch.impl },
    );

    assert.equal(suggestion?.title, "Untitled podcast");
    assert.equal(suggestion?.author, "");
    assert.deepEqual(suggestion?.genreIds, []);
    assert.equal(suggestion?.episodeCount, undefined);
    assert.equal(suggestion?.artworkUrl, "s.jpg", "falls back through the artwork sizes");
  });

  it("treats a reply that is not the documented shape as no results", async () => {
    // This endpoint is undocumented enough to change under us, and a shelf that
    // renders empty beats a shelf that throws.
    const bodies = ["<html>we moved</html>", "{}", `{"results":null}`, `{"results":[null,3]}`];
    for (const body of bodies) {
      const fetch = apple({ x: () => new Response(body) });
      assert.deepEqual(
        await searchPodcasts({ term: "x", country: "US" }, { fetch: fetch.impl }),
        [],
        body,
      );
    }
  });

  it("says what it was looking for when the search fails", async () => {
    const rejected = apple({
      "learn japanese": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await assert.rejects(
      searchPodcasts({ term: "learn japanese", country: "US" }, { fetch: rejected.impl }),
      // A cross-origin failure arrives as a bare TypeError with nothing in it.
      /could not reach.*learn japanese/i,
    );

    const refused = apple({ x: () => new Response("slow down", { status: 429 }) });
    await assert.rejects(
      searchPodcasts({ term: "x", country: "US" }, { fetch: refused.impl }),
      /429/,
    );
  });
});

describe("recommending for a language", () => {
  it("has a market for every language the app offers", () => {
    for (const language of LANGUAGES) {
      const market = MARKETS[language];
      assert.match(market.country, /^[A-Z]{2}$/, language);
      assert.ok(market.term && market.learnerTerm, language);
    }
  });

  it("asks the language's own storefront and the learner's market", async () => {
    const fetch = apple({});
    await recommendedFor("ja", { fetch: fetch.impl, storage: memoryStorage() });

    assert.deepEqual(
      fetch.urls.map((url) => [url.searchParams.get("term"), url.searchParams.get("country")]),
      [
        ["日本語 会話", "JP"],
        ["learn japanese", "US"],
      ],
    );
  });

  it("shows each podcast once, however many queries found it", async () => {
    const fetch = apple({
      "日本語 会話": [result({ collectionId: 1 }), result({ collectionId: 2 })],
      "learn japanese": [result({ collectionId: 2 }), result({ collectionId: 3 })],
    });

    const found = await recommendedFor("ja", { fetch: fetch.impl, storage: memoryStorage() });

    assert.deepEqual(
      found.map((suggestion) => suggestion.collectionId),
      [1, 2, 3],
    );
  });

  it("puts language-learning podcasts first", async () => {
    // `genreId` on the request is accepted and ignored by Apple, so the genre has to
    // be read off each result — which is why a query can come back mixed like this.
    const fetch = apple({
      "日本語 会話": [
        result({ collectionId: 1, genreIds: ["1301"] }),
        result({ collectionId: 2, genreIds: ["1310", LANGUAGE_LEARNING_GENRE] }),
      ],
      "learn japanese": [
        result({ collectionId: 3, genreIds: [] }),
        result({ collectionId: 4, genreIds: [LANGUAGE_LEARNING_GENRE] }),
      ],
    });

    const found = await recommendedFor("ja", { fetch: fetch.impl, storage: memoryStorage() });

    assert.deepEqual(
      found.map((suggestion) => suggestion.collectionId),
      [2, 4, 1, 3],
      "learning podcasts first, and Apple's relevance order kept within each group",
    );
  });

  it("still shows what the other query found when one fails", async () => {
    const fetch = apple({
      "日本語 会話": () => new Response("nope", { status: 503 }),
      "learn japanese": [result({ collectionId: 9 })],
    });

    const found = await recommendedFor("ja", { fetch: fetch.impl, storage: memoryStorage() });

    assert.deepEqual(
      found.map((suggestion) => suggestion.collectionId),
      [9],
    );
  });
});

describe("the day cache", () => {
  const noon = "2026-09-08T12:00:00Z";
  const tomorrow = "2026-09-09T12:00:00Z";

  it("asks Apple once a day, per language", async () => {
    const fetch = apple({ "日本語 会話": [result({ collectionId: 1 })] });
    const deps = { fetch: fetch.impl, storage: memoryStorage(), now: clock(noon) };

    const first = await recommendedFor("ja", deps);
    const second = await recommendedFor("ja", deps);

    assert.deepEqual(second, first);
    assert.deepEqual(
      fetch.terms(),
      ["日本語 会話", "learn japanese"],
      "the second call is free",
    );

    // Another language is another entry: one cached shelf must not answer for all.
    await recommendedFor("ko", deps);
    assert.deepEqual(fetch.terms().slice(2), ["한국어 회화", "learn korean"]);
  });

  it("asks again the next day", async () => {
    const fetch = apple({ "日本語 会話": [result({ collectionId: 1 })] });
    const storage = memoryStorage();

    await recommendedFor("ja", { fetch: fetch.impl, storage, now: clock(noon) });
    await recommendedFor("ja", { fetch: fetch.impl, storage, now: clock(tomorrow) });

    assert.equal(fetch.urls.length, 4);
  });

  it("does not cache an empty answer", async () => {
    // Both queries failing is a bad minute, not a fact about the day — caching it
    // would leave the shelf blank until midnight.
    const fetch = apple({
      "日本語 会話": () => new Response("", { status: 500 }),
      "learn japanese": () => new Response("", { status: 500 }),
    });
    const deps = { fetch: fetch.impl, storage: memoryStorage(), now: clock(noon) };

    assert.deepEqual(await recommendedFor("ja", deps), []);
    await recommendedFor("ja", deps);

    assert.equal(fetch.urls.length, 4, "it tried again rather than remembering the failure");
  });

  it("works where storage is refused", async () => {
    // Private modes throw on both halves of this. Losing the cache costs one request.
    const hostile = {
      getItem: (): string | null => {
        throw new Error("The operation is insecure.");
      },
      setItem: () => {
        throw new Error("The operation is insecure.");
      },
    };
    const fetch = apple({ "日本語 会話": [result({ collectionId: 1 })] });

    const found = await recommendedFor("ja", { fetch: fetch.impl, storage: hostile });

    assert.deepEqual(
      found.map((suggestion) => suggestion.collectionId),
      [1],
    );
  });

  it("ignores a cache entry that is not ours to read", async () => {
    const fetch = apple({ "日本語 会話": [result({ collectionId: 1 })] });
    const storage = memoryStorage({ "duolistening.itunes.ja": "half a jso" });

    const found: PodcastSuggestion[] = await recommendedFor("ja", {
      fetch: fetch.impl,
      storage,
      now: clock(noon),
    });

    assert.equal(found.length, 1);
    assert.match(storage.items.get("duolistening.itunes.ja") ?? "", /collectionId/);
  });
});
