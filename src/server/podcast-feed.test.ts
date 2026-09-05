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
  const serving = (body: string, init?: ResponseInit) =>
    (async () => new Response(body, init)) as unknown as typeof globalThis.fetch;

  it("fetches and parses", async () => {
    const podcast = createPodcastFeed({
      fetch: serving(feed(item(`<title>hi</title><enclosure url="https://c/1.mp3"/>`))),
    });

    const { episodes } = await podcast.listEpisodes("https://example.com/feed.xml");
    assert.equal(episodes[0]?.audioUrl, "https://c/1.mp3");
  });

  it("says so when the feed does not respond", async () => {
    const podcast = createPodcastFeed({ fetch: serving("nope", { status: 500 }) });
    await assert.rejects(podcast.listEpisodes("https://example.com/feed.xml"), /500/);
  });
});
