// The interface language, which is simply the user's Native Language: someone whose
// translations are in Spanish reads Spanish, so the buttons around them are Spanish
// too. The strings themselves live in shared/i18n.ts — the server needs one of them.

import { createContext, useContext } from "react";
import { t, type StringKey } from "../shared/i18n.ts";
import type { LanguageCode } from "../shared/model.ts";

/**
 * Cached so the very first paint — the password gate, before any API call can be
 * made — is already in the right language. The server stays the source of truth and
 * corrects this as soon as Settings loads.
 */
export const LOCALE_KEY = "duolistening.locale";

export const LocaleContext = createContext<LanguageCode>("en");

export function useT(): (key: StringKey, vars?: Record<string, string | number>) => string {
  const locale = useContext(LocaleContext);
  return (key, vars) => t(locale, key, vars);
}
