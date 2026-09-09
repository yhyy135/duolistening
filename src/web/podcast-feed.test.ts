import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPodcastFeed, parseDuration, parseFeed } from "./podcast-feed.ts";

const feed = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title><![CDATA[Let's Talk in Japanese!]]></title>
    ${items}
  </channel>
</rss>`;

const item = (inner: string) => `<item>${inner}</item>`;

describe("itunes:duration", () => {
  it("reads all three spellings publishers use", () => {
    assert.equal(parseDuration("1555"), 1555, "plain seconds");
    assert.equal(parseDuration("25:55"), 1555, "minutes and seconds");
    assert.equal(parseDuration("01:25:55"), 5155, "hours, minutes and seconds");
  });

  it("gives up rather than guessing on nonsense", () => {
    assert.equal(parseDuration("about half an hour"), undefined);
    assert.equal(parseDuration(""), undefined);
    assert.equal(parseDuration(undefined), undefined);
  });
});

describe("parsing a feed", () => {
  it("reads the channel and its episodes", () => {
    const parsed = parseFeed(
      feed(
        item(`
          <title><![CDATA[episode405「自己紹介」]]></title>
          <pubDate>Tue, 02 Sep 2026 09:00:00 +0900</pubDate>
          <itunes:duration>25:55</itunes:duration>
          <enclosure url="https://cdn.example.com/405.mp3" type="audio/mpeg" length="1"/>
        `),
      ),
    );

    assert.equal(parsed.feedTitle, "Let's Talk in Japanese!");
    assert.deepEqual(parsed.episodes, [
      {
        title: "episode405「自己紹介」",
        audioUrl: "https://cdn.example.com/405.mp3",
        durationSec: 1555,
        publishedAt: "2026-09-02T00:00:00.000Z",
      },
    ]);
  });

  it("handles a feed with exactly one episode", () => {
    // A single <item> parses to an object rather than an array — the classic way
    // XML-to-JSON breaks on the smallest feed.
    const parsed = parseFeed(
      feed(item(`<title>only one</title><enclosure url="https://cdn.example.com/1.mp3"/>`)),
    );

    assert.equal(parsed.episodes.length, 1);
    assert.equal(parsed.episodes[0]?.title, "only one");
  });

  it("hands the enclosure URL on exactly as written", () => {
    // The shape a real feed uses: a tracking prefix in front of the CDN, and a query
    // string. It answers a 302, and the host behind it splices advertising by client
    // — so the bytes differ between two fetches of this one URL. Resolving or tidying
    // it here would bake in an answer only whoever fetches the audio can ask for.
    const url =
      "https://pdst.fm/e/chtbl.com/track/ABC12/cdn.example.com/405.mp3?awCollectionId=9&hash=zz";
    const parsed = parseFeed(feed(item(`<title>t</title><enclosure url="${url}"/>`)));

    assert.equal(parsed.episodes[0]?.audioUrl, url);
  });

  it("skips entries with nothing to play", () => {
    const parsed = parseFeed(
      feed(
        item(`<title>a written announcement</title>`) +
          item(`<title>real one</title><enclosure url="https://cdn.example.com/2.mp3"/>`),
      ),
    );

    assert.deepEqual(
      parsed.episodes.map((episode) => episode.title),
      ["real one"],
    );
  });

  it("copes with the pieces publishers leave out", () => {
    const parsed = parseFeed(feed(item(`<enclosure url="https://cdn.example.com/3.mp3"/>`)));

    assert.equal(parsed.episodes[0]?.title, "Untitled episode");
    assert.equal(parsed.episodes[0]?.durationSec, undefined);
    assert.equal(parsed.episodes[0]?.publishedAt, undefined);
  });

  it("refuses something that is not a feed at all", () => {
    assert.throws(() => parseFeed("<html><body>404</body></html>"), /not an rss feed/i);
  });

  it("keeps an empty feed empty rather than failing", () => {
    assert.deepEqual(parseFeed(feed("")).episodes, []);
  });
});

describe("fetching a feed", () => {
  const proxyUrl = (target: string) =>
    `https://proxy.example/?k=shared-secret&url=${encodeURIComponent(target)}`;

  /** Records what was asked for, and answers everything the same way. */
  function spy(body: string, init?: ResponseInit) {
    const urls: string[] = [];
    const impl: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      return new Response(body, init);
    };
    return { impl, urls };
  }

  it("asks the proxy, never the feed host", async () => {
    const fetch = spy(feed(item(`<title>hi</title><enclosure url="https://c/1.mp3"/>`)));
    const podcast = createPodcastFeed({ proxyUrl, fetch: fetch.impl });

    const { episodes } = await podcast.listEpisodes("https://example.com/feed.xml");

    // Some feeds send CORS headers, some send none, and one answers a redirect: going
    // direct works until it silently does not.
    assert.equal(
      fetch.urls[0],
      "https://proxy.example/?k=shared-secret&url=https%3A%2F%2Fexample.com%2Ffeed.xml",
    );
    assert.equal(episodes[0]?.audioUrl, "https://c/1.mp3");
  });

  it("says so when the feed does not respond", async () => {
    const podcast = createPodcastFeed({ proxyUrl, fetch: spy("nope", { status: 500 }).impl });
    await assert.rejects(podcast.listEpisodes("https://example.com/feed.xml"), /500/);
  });

  it("carries the proxy's own explanation, not just its status", async () => {
    // The real one this was written for: japanesepod101.com sits behind a CloudFront
    // WAF that refuses the Worker's address range, so the proxy reaches it and is
    // turned away. "502" alone reads as "this app is broken"; the body is what says
    // it was the origin refusing, which no setting on this side can fix.
    const podcast = createPodcastFeed({
      proxyUrl,
      fetch: spy("upstream answered 403", { status: 502 }).impl,
    });
    await assert.rejects(
      podcast.listEpisodes("https://example.com/feed.xml"),
      /502.*upstream answered 403/,
    );
  });

  it("never lets the proxy key into the message it puts on screen", async () => {
    // Point `proxy.baseUrl` at something that is not this Worker — a typo, a plain web
    // server — and its error page may quote the request line back, key and all. This
    // message is shown on screen and pasted into bug reports.
    const podcast = createPodcastFeed({
      proxyUrl,
      fetch: spy("Cannot GET /?k=shared-secret&url=https://example.com/feed.xml", {
        status: 404,
      }).impl,
    });
    await assert.rejects(podcast.listEpisodes("https://example.com/feed.xml"), (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /shared-secret/);
      assert.match(error.message, /k=\*\*\*/);
      return true;
    });
  });

  it("names the feed in a failure, not the proxy URL carrying the key", async () => {
    const fetch: typeof globalThis.fetch = () => Promise.reject(new Error("dns"));
    const podcast = createPodcastFeed({ proxyUrl, fetch });

    await assert.rejects(
      podcast.listEpisodes("https://example.com/feed.xml"),
      (error: Error) => {
        assert.match(error.message, /https:\/\/example\.com\/feed\.xml/);
        assert.doesNotMatch(error.message, /shared-secret/, "the key is a shared secret");
        return true;
      },
    );
  });
});
