// The shell: the access gate, the hash route, and the header. Every screen below it
// assumes the session is already good.

import { useEffect, useState } from "react";
import type { LanguageCode } from "../shared/model.ts";
import { ApiError, api, reason, setOnUnauthorized } from "./api.ts";
import { LOCALE_KEY, LocaleContext, useT } from "./i18n.ts";
import { LibraryScreen } from "./library.tsx";
import { PlayerScreen } from "./player.tsx";
import { SettingsScreen } from "./settings.tsx";

/**
 * Auto, and the two ways to overrule it. Auto is stored and applied as the absence of
 * `data-theme`, so the CSS needs no rule for it — the media query is simply back in
 * charge. index.html applies the stored choice before first paint; this only keeps
 * the attribute in step with the button.
 */
const THEMES = ["auto", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const THEME_KEY = "duolistening.theme";

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
 * The Native Language, which is what every label on every screen is written in. Read
 * from Settings once the gate is open, and remembered locally so the gate itself —
 * which is drawn before any request can succeed — is already in the right language.
 */
function useLocale(gateOpen: boolean): [LanguageCode, (code: LanguageCode) => void] {
  const [locale, setLocale] = useState<LanguageCode>(
    () => (localStorage.getItem(LOCALE_KEY) as LanguageCode | null) ?? "en",
  );

  useEffect(() => {
    if (!gateOpen) return;
    api.settings().then(
      (settings) => setLocale(settings.nativeLanguage),
      () => undefined,
    );
  }, [gateOpen]);

  useEffect(() => {
    localStorage.setItem(LOCALE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  return [locale, setLocale];
}

export function App() {
  const [gate, setGate] = useState<"checking" | "locked" | "open">("checking");
  const [locale, setLocale] = useLocale(gate === "open");

  useEffect(() => {
    setOnUnauthorized(() => setGate("locked"));
    api.session().then(
      () => setGate("open"),
      () => setGate("locked"),
    );
  }, []);

  return (
    <LocaleContext.Provider value={locale}>
      <Shell gate={gate} onOpen={() => setGate("open")} onLocale={setLocale} />
    </LocaleContext.Provider>
  );
}

function Shell({
  gate,
  onOpen,
  onLocale,
}: {
  gate: "checking" | "locked" | "open";
  onOpen: () => void;
  onLocale: (code: LanguageCode) => void;
}) {
  const [theme, cycleTheme] = useTheme();
  const hash = useHash();
  const t = useT();
  const themeLabel: Record<Theme, string> = {
    auto: t("theme.auto"),
    light: t("theme.light"),
    dark: t("theme.dark"),
  };

  if (gate === "checking") return <p className="notice">…</p>;
  if (gate === "locked") return <Gate onOpen={onOpen} />;

  const resourceId = hash.startsWith("#/r/") ? decodeURIComponent(hash.slice(4)) : null;
  return (
    <>
      <header>
        <a href="#/" className="brand">
          duolistening
        </a>
        <a href="#/settings">{t("nav.settings")}</a>
        <button
          className="theme"
          onClick={cycleTheme}
          title={`${themeLabel.auto} / ${themeLabel.light} / ${themeLabel.dark}`}
        >
          {themeLabel[theme]}
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

/**
 * The single shared password (ADR 0001). A successful POST sets the session cookie,
 * so nothing is kept here — reloading the page stays logged in, and so does the
 * <audio> element, which cannot send a header of its own.
 */
function Gate({ onOpen }: { onOpen: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  return (
    <form
      className="gate"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await api.login(password);
          onOpen();
        } catch (failure) {
          setError(failure instanceof ApiError ? t("gate.wrongPassword") : reason(failure));
        }
      }}
    >
      <h1>duolistening</h1>
      <input
        type="password"
        autoFocus
        placeholder={t("gate.password")}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button type="submit">{t("gate.enter")}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
