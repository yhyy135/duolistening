// What identifies an episode at a glance, in both looks: its show's cover.
//
// The cover is the show's own artwork when the feed gave one, and a monogram where there
// is none: an episode imported before covers were recorded, a page opened offline, or a
// host that refuses the request.
//
// Straight from whoever hosts the image rather than through the proxy, the way the
// recommendations already load Apple's artwork: an <img> needs no CORS, and routing
// pictures through the reader's own Worker would bill them for decoration. What that
// costs is one request to the image host whenever the browser has no copy cached. It
// goes out with no referrer, so the host learns an address and not this page.

import { useState } from "react";

/**
 * Two characters for a name in a script without word spaces — the first two of
 * ごん狐 are more recognisable than any initial — and the initials of the first two
 * words otherwise. Punctuation is dropped first, since plenty of Japanese titles open
 * on a 「 and plenty of English ones on a quote mark.
 */
export function monogram(name: string): string {
  const letters = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(letters)
  ) {
    return Array.from(letters.replace(/ /g, "")).slice(0, 2).join("");
  }
  return letters
    .split(" ")
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
}

/** One of six tile colours, fixed per name, so a show keeps its colour on every row. */
function tint(name: string): number {
  let sum = 0;
  for (const character of name) sum += character.codePointAt(0) ?? 0;
  return (sum % 6) + 1;
}

/**
 * Decorative: whatever holds a cover also shows the title it belongs to, so a screen
 * reader hearing the picture as well would hear everything twice.
 */
export function Cover({ src, name }: { src?: string; name: string }) {
  // Keyed by the URL that failed, so a different cover gets its own chance to load.
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={`cover tile-${tint(name)}`} aria-hidden="true">
      <span className="monogram">{monogram(name)}</span>
      {src && failed !== src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
        />
      )}
    </span>
  );
}
