// The interface language, which is simply the user's Native Language: someone whose
// translations are in Spanish reads Spanish, so the buttons around them are Spanish
// too. The strings themselves live in shared/i18n.ts — the server needs one of them.

import { createContext, useCallback, useContext } from "react";
import { languageName, t, type StringKey } from "../shared/i18n.ts";
import { LANGUAGES, type LanguageCode } from "../shared/model.ts";

/**
 * Cached so the very first paint is already in the right language. Settings live in
 * IndexedDB, which cannot be read before a render, and a shell that flashed English
 * on every load is what someone who set their language is trying to avoid.
 */
const LOCALE_KEY = "duolistening.locale";

/**
 * The cache mirrors the **stored** Native Language, never the one a screen is showing.
 *
 * Those are not the same thing, and the difference was a real bug. The Settings screen
 * switches the interface the moment its dropdown changes, so you can see what you are
 * choosing — but nothing is saved until Save. When the cache was written from that
 * live preview, a reader who picked a language and then left without saving got an
 * interface in one language and a Settings screen showing another, permanently: the
 * Back button's restore only runs if you press Back, and the read below could not
 * correct a browser that had never saved any settings at all.
 *
 * So there are exactly two writers, both of them facts about the store rather than
 * the screen: a successful save, and the read at boot — which also clears the cache
 * when there is nothing stored, because a mirror of nothing is nothing.
 */
export function rememberLocale(code: LanguageCode | null): void {
  try {
    if (code) localStorage.setItem(LOCALE_KEY, code);
    else localStorage.removeItem(LOCALE_KEY);
  } catch {
    // Private mode. The interface still follows the setting for this visit; only the
    // head start on the next first paint is lost.
  }
}

/** What the last save left here, if it is still a language this build offers. */
export function cachedLocale(): LanguageCode | null {
  try {
    const code = localStorage.getItem(LOCALE_KEY);
    return LANGUAGES.includes(code as LanguageCode) ? (code as LanguageCode) : null;
  } catch {
    return null;
  }
}

export const LocaleContext = createContext<LanguageCode>("en");

/**
 * `useCallback`, and it is not a micro-optimisation — it is a correctness fix that
 * cost a real bug. Returning a fresh closure each render made every `useEffect` that
 * listed `t` a dependency re-run on every render, and the player's does the one thing
 * that must not happen twice: its cleanup revokes the audio's blob URL. The element
 * was left pointing at a revoked blob and failed with MEDIA_ERR_NETWORK, which reads
 * like a network problem for a URL that never touches the network.
 */
export function useT(): (key: StringKey, vars?: Record<string, string | number>) => string {
  const locale = useContext(LocaleContext);
  return useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => t(locale, key, vars),
    [locale],
  );
}

/**
 * A language's name in the interface's own language — the same shape as `useT`, and
 * `useCallback` for the same reason stated there.
 */
export function useLanguageName(): (code: LanguageCode) => string {
  const locale = useContext(LocaleContext);
  return useCallback((code: LanguageCode) => languageName(code, locale), [locale]);
}
