// The shell: the hash route and the Native Language. Each screen draws its own top bar,
// because each has a different job for it — the shelf's is the app's name, the
// player's is a way back, and the Settings screen's holds an armed Back of its own.
//
// There is no access gate any more, and its absence is the point rather than an
// omission. ADR 0001 added a single shared password because a deployment held one
// person's API keys and Library on a server anyone could find. ADR 0008 moved all
// of that into the reader's own browser, so a stranger who loads this page gets an
// empty one — there is nothing on the other side of a gate to protect.

import { useEffect, useState } from "react";
import type { LanguageCode } from "../shared/model.ts";
import { syncChrome } from "./appearance.ts";
import { LocaleContext, cachedLocale, rememberLocale } from "./i18n.ts";
import { LibraryScreen } from "./library.tsx";
import { PlayerScreen } from "./player.tsx";
import { SettingsScreen } from "./settings.tsx";
import { readSettings } from "./store.ts";

/** The current hash route, re-read on every back/forward and every link click. */
function useHash(): string {
  const [hash, setHash] = useState(() => location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(location.hash || "#/");
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/**
 * The Native Language, which is what every label on every screen is written in.
 *
 * Cached in localStorage and read from there synchronously, so the first paint is
 * already in the right language. Settings live in IndexedDB, which cannot be read
 * before a render, and a shell that flashed English on every load would be exactly
 * what someone who set their language is trying to avoid.
 */
function useLocale(): [LanguageCode, (code: LanguageCode) => void] {
  const [locale, setLocale] = useState<LanguageCode>(() => cachedLocale() ?? "en");

  // The store is the authority and this is where it says so: the language it holds
  // wins over the cache, and a store with no settings in it puts the interface back to
  // English and empties the cache with it. Without that second half, a browser that
  // once previewed a language in Settings and never saved would keep answering in it
  // for good — see the note on rememberLocale.
  useEffect(() => {
    readSettings().then(
      (settings) => {
        setLocale(settings?.nativeLanguage ?? "en");
        rememberLocale(settings?.nativeLanguage ?? null);
      },
      () => undefined,
    );
  }, []);

  // Deliberately not writing the cache: `setLocale` is also how the Settings screen
  // previews an unsaved choice, and caching that is precisely the bug above.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return [locale, setLocale];
}

export function App() {
  const [locale, setLocale] = useLocale();
  const hash = useHash();

  // The status bar takes the ground the page is actually showing. With the theme on
  // auto the system can switch schemes under an open page, and nothing else would
  // tell the chrome.
  useEffect(() => {
    syncChrome();
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", syncChrome);
    return () => scheme.removeEventListener("change", syncChrome);
  }, []);

  const resourceId = hash.startsWith("#/r/") ? decodeURIComponent(hash.slice(4)) : null;
  return (
    <LocaleContext.Provider value={locale}>
      {resourceId ? (
        <PlayerScreen id={resourceId} />
      ) : hash === "#/settings" ? (
        <SettingsScreen onLocale={setLocale} />
      ) : (
        <LibraryScreen />
      )}
    </LocaleContext.Provider>
  );
}
