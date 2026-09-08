// The shell: the hash route and the header.
//
// There is no access gate any more, and its absence is the point rather than an
// omission. ADR 0001 added a single shared password because a deployment held one
// person's API keys and Library on a server anyone could find. ADR 0008 moved all
// of that into the reader's own browser, so a stranger who loads this page gets an
// empty one — there is nothing on the other side of a gate to protect.

import { useEffect, useState } from "react";
import type { LanguageCode } from "../shared/model.ts";
import { Icon, type IconName } from "./icons.tsx";
import { LocaleContext, cachedLocale, rememberLocale, useT } from "./i18n.ts";
import { LibraryScreen } from "./library.tsx";
import { PlayerScreen } from "./player.tsx";
import { SettingsScreen } from "./settings.tsx";
import { readSettings } from "./store.ts";

/**
 * Auto, and the two ways to overrule it. Auto is stored and applied as the absence of
 * `data-theme`, so the CSS needs no rule for it — the media query is simply back in
 * charge. index.html applies the stored choice before first paint; this only keeps
 * the attribute in step with the button.
 */
const THEMES = ["auto", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const THEME_KEY = "duolistening.theme";
const THEME_ICONS: Record<Theme, IconName> = {
  auto: "display",
  light: "sun",
  dark: "moon",
};

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    // Anything else in that key is someone else's data, or ours from a version that
    // spelled it differently. Either way the system preference is the safe answer.
    return THEMES.includes(stored as Theme) ? (stored as Theme) : "auto";
  });

  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return [theme, () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!)];
}

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
  return (
    <LocaleContext.Provider value={locale}>
      <Shell onLocale={setLocale} />
    </LocaleContext.Provider>
  );
}

function Shell({ onLocale }: { onLocale: (code: LanguageCode) => void }) {
  const [theme, cycleTheme] = useTheme();
  const hash = useHash();
  const t = useT();
  const themeLabel: Record<Theme, string> = {
    auto: t("theme.auto"),
    light: t("theme.light"),
    dark: t("theme.dark"),
  };

  const resourceId = hash.startsWith("#/r/") ? decodeURIComponent(hash.slice(4)) : null;
  return (
    <>
      <header>
        <a href="#/" className="brand">
          duolistening
        </a>
        <a href="#/settings" aria-label={t("nav.settings")} title={t("nav.settings")}>
          <Icon name="gear" />
        </a>
        {/* The label the text used to carry is now the accessible name, and it still
            says which of the three modes is in force rather than which one the click
            would move to — a control that announces its own state. "Auto" gets the
            screen it defers to, because there is no glyph for "whatever you set your
            system to" and a half-lit sun would read as a third theme. */}
        <button
          className="theme"
          onClick={cycleTheme}
          aria-label={themeLabel[theme]}
          title={`${themeLabel.auto} / ${themeLabel.light} / ${themeLabel.dark}`}
        >
          <Icon name={THEME_ICONS[theme]} />
        </button>
      </header>
      {resourceId ? (
        <PlayerScreen id={resourceId} />
      ) : hash === "#/settings" ? (
        <SettingsScreen onLocale={onLocale} />
      ) : (
        <LibraryScreen />
      )}
    </>
  );
}
