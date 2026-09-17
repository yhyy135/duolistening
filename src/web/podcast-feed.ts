import { XMLParser } from "fast-xml-parser";
import type { Episode } from "../shared/model.ts";
import { proxyDetail } from "./proxy.ts";

/**
 * Reads an RSS feed and lists its episodes.
 *
 * The fetch goes through the proxy rather than straight at the feed host, and both
 * halves of that matter: some feeds send CORS headers and some send none at all, so
 * a browser cannot tell which until it has already failed, and one host answers the
 * request with a redirect somebody has to follow. Neither is something the page can
 * fix for itself — it is why the proxy survives the server (ADR 0009).
 *
 * Building the proxy's URL is not this module's job: it takes `proxyUrl` and does not
 * know the base URL or the key, which are the reader's own settings.
 */

export interface PodcastFeedOptions {
  /** Wraps a target URL in the proxy's. Injected because the key belongs to Settings. */
  proxyUrl: (target: string) => string;
  /** Injected so tests need no network. */
  fetch?: typeof globalThis.fetch;
}

/** Browsing a podcast feed: one call, and the list a reader picks an episode from. */
export interface PodcastFeed {
  /**
   * `signal` is how the picker's Cancel gets its money back: a feed is fetched whole
   * before anything can be shown, several megabytes of it for a show with a long
   * archive, and a reader who changed their mind should not go on paying a proxy for
   * a list nobody is going to read.
   */
  listEpisodes(feedUrl: string, signal?: AbortSignal): Promise<FeedListing>;
}

/** A feed as the picker shows it. `artworkUrl` is the show's cover, when it has one. */
export interface FeedListing {
  feedTitle: string;
  /** The feed's `itunes:author`, which a Favorite's tile prints under its title. */
  author?: string;
  artworkUrl?: string;
  episodes: Episode[];
}

export function createPodcastFeed(options: PodcastFeedOptions): PodcastFeed {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async listEpisodes(feedUrl: string, signal?: AbortSignal) {
      let response: Response;
      try {
        // No `redirect` option: the proxy is what follows a feed host's redirect now,
        // and it answers this call with a plain 200 either way.
        response = await doFetch(options.proxyUrl(feedUrl), { signal });
      } catch (cause) {
        // Named by the feed URL the reader typed, not the proxy URL wrapping it — that
        // one carries the proxy key in its query string, and this message is shown on
        // screen and pasted into bug reports.
        throw new Error(`Could not reach ${feedUrl}`, { cause });
      }
      if (!response.ok) {
        // The proxy says whose fault it is in the body, and a bare status throws that
        // away: a feed host refusing us (502 upstream answered 403), a proxy narrowed
        // by ALLOWED_HOSTS, and a mistyped key all reach this line as a number, and
        // only one of the three is something the reader can do anything about.
        const detail = await proxyDetail(response);
        throw new Error(
          `Feed request failed with ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      return parseFeed(await response.text());
    },
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // Titles are routinely CDATA-wrapped and full of entities; let the parser own that.
  processEntities: true,
  trimValues: true,
});

interface RssItem {
  title?: unknown;
  pubDate?: unknown;
  enclosure?: unknown;
  "itunes:duration"?: unknown;
  "itunes:image"?: unknown;
}

export function parseFeed(xml: string): FeedListing {
  const document = parser.parse(xml) as { rss?: { channel?: unknown } };
  const channel = document.rss?.channel as
    | {
        title?: unknown;
        item?: RssItem | RssItem[];
        "itunes:author"?: unknown;
        "itunes:image"?: unknown;
        image?: unknown;
      }
    | undefined;
  if (!channel) throw new Error("Not an RSS feed");

  // A feed with exactly one episode parses to an object, not an array.
  const items = channel.item ? [channel.item].flat() : [];

  const episodes = items.flatMap((item): Episode[] => {
    const audioUrl = enclosureUrl(item.enclosure);
    // No enclosure means nothing to play — a trailer post or a text-only entry.
    if (!audioUrl) return [];

    const durationSec = parseDuration(item["itunes:duration"]);
    const publishedAt = parseDate(item.pubDate);
    const artworkUrl = imageUrl(item["itunes:image"]);
    return [
      {
        title: text(item.title) || "Untitled episode",
        audioUrl,
        ...(durationSec !== undefined && { durationSec }),
        ...(publishedAt !== undefined && { publishedAt }),
        ...(artworkUrl && { artworkUrl }),
      },
    ];
  });

  const artworkUrl = imageUrl(channel["itunes:image"]) ?? imageUrl(channel.image);
  const author = text(channel["itunes:author"]);
  return {
    feedTitle: text(channel.title) || "Untitled podcast",
    ...(author && { author }),
    ...(artworkUrl && { artworkUrl }),
    episodes,
  };
}

/**
 * A cover's URL, in either spelling a feed uses: `<itunes:image href>`, or RSS's own
 * `<image><url>`. Only http(s), because this ends up as an `<img src>` on the shelf,
 * and a `javascript:` or `data:` URL out of somebody else's feed has no business there.
 */
function imageUrl(image: unknown): string | undefined {
  for (const candidate of [image].flat()) {
    const record = candidate as { "@href"?: unknown; url?: unknown } | null;
    const url = text(record?.["@href"]) || text(record?.url);
    if (/^https?:\/\//i.test(url)) return url;
  }
  return undefined;
}

/**
 * The URL exactly as the feed writes it — tracking prefixes, query string and all.
 *
 * Nothing is resolved or rewritten here, and the temptation to is worth naming: one
 * of these commonly answers a 302, and some hosts splice advertising so the same URL
 * returns a different byte count to different clients. Resolving it here would bake
 * in one client's answer to a question only the client fetching the audio can ask,
 * and that one goes through the proxy, which follows the redirect for itself.
 */
function enclosureUrl(enclosure: unknown): string | null {
  // Some feeds carry several enclosures; the first playable one is the episode.
  for (const candidate of [enclosure].flat()) {
    const url = (candidate as { "@url"?: unknown } | null)?.["@url"];
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

/** itunes:duration is written as seconds, M:SS, or H:MM:SS depending on the publisher. */
export function parseDuration(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw) return undefined;

  const parts = raw.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined;

  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function parseDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** The parser hands back a number for numeric-looking text, so normalise everything. */
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  const nested = (value as { "#text"?: unknown } | null)?.["#text"];
  return nested === undefined ? "" : text(nested);
}
