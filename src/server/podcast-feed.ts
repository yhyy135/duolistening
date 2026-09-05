import { XMLParser } from "fast-xml-parser";
import type { Episode } from "../shared/model.ts";
import type { PodcastFeed } from "./ports.ts";

export interface PodcastFeedOptions {
  fetch?: typeof globalThis.fetch;
}

/**
 * Reads an RSS feed and lists its episodes.
 *
 * Fetched here rather than in the browser: podcast hosts rarely send CORS headers,
 * so this is one of the reasons the backend exists at all.
 */
export function createPodcastFeed(options: PodcastFeedOptions = {}): PodcastFeed {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async listEpisodes(feedUrl: string) {
      let response: Response;
      try {
        response = await doFetch(feedUrl, { redirect: "follow" });
      } catch (cause) {
        throw new Error(`Could not reach ${feedUrl}`, { cause });
      }
      if (!response.ok) {
        throw new Error(`Feed request failed with ${response.status}`);
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
}

export function parseFeed(xml: string): { feedTitle: string; episodes: Episode[] } {
  const document = parser.parse(xml) as { rss?: { channel?: unknown } };
  const channel = document.rss?.channel as
    { title?: unknown; item?: RssItem | RssItem[] } | undefined;
  if (!channel) throw new Error("Not an RSS feed");

  // A feed with exactly one episode parses to an object, not an array.
  const items = channel.item ? [channel.item].flat() : [];

  const episodes = items.flatMap((item): Episode[] => {
    const audioUrl = enclosureUrl(item.enclosure);
    // No enclosure means nothing to play — a trailer post or a text-only entry.
    if (!audioUrl) return [];

    const durationSec = parseDuration(item["itunes:duration"]);
    const publishedAt = parseDate(item.pubDate);
    return [
      {
        title: text(item.title) || "Untitled episode",
        audioUrl,
        ...(durationSec !== undefined && { durationSec }),
        ...(publishedAt !== undefined && { publishedAt }),
      },
    ];
  });

  return { feedTitle: text(channel.title) || "Untitled podcast", episodes };
}

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
