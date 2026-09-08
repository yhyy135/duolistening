// The interface language, which is simply the user's Native Language: someone whose
// translations are in Spanish reads Spanish, so the buttons around them are Spanish
// too. The strings themselves live in shared/i18n.ts — the server needs one of them.

import { createContext, useCallback, useContext } from "react";
import { t, type StringKey } from "../shared/i18n.ts";
import type { LanguageCode } from "../shared/model.ts";

/**
 * Cached so the very first paint is already in the right language. Settings live in
 * IndexedDB, which cannot be read before a render, and a shell that flashed English
 * on every load is what someone who set their language is trying to avoid.
 */
export const LOCALE_KEY = "duolistening.locale";

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
