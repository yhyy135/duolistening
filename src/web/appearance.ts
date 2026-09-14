// How this device draws the app: which look, and light or dark (ADR 0016).
//
// Neither belongs in Settings. Both are facts about a screen rather than about a
// reader, both have to be in force before the first paint — IndexedDB cannot promise
// that and localStorage can — and neither is worth a Save button, so a choice applies
// the moment it is made. index.html applies both before anything renders; this is the
// other half, which the Settings screen reads and writes through.
//
// Each default is the *absence* of its attribute, so the stylesheet's bare `:root`
// is the Standard look in the system's own light or dark, with no rule needed for it.

export const LOOKS = ["standard", "station"] as const;
export type Look = (typeof LOOKS)[number];

export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The same two keys index.html reads before the bundle has loaded. */
const LOOK_KEY = "duolistening.look";
const THEME_KEY = "duolistening.theme";

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    // Anything else there is someone else's data, or ours from a build that spelled
    // it differently. Either way the default is the safe answer.
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function apply(attribute: "look" | "theme", key: string, value: string, fallback: string) {
  if (value === fallback) delete document.documentElement.dataset[attribute];
  else document.documentElement.dataset[attribute] = value;
  try {
    if (value === fallback) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode. The choice holds for this visit and is forgotten after it.
  }
  syncChrome();
}

export const storedLook = () => stored(LOOK_KEY, LOOKS, "standard");
export const storedTheme = () => stored(THEME_KEY, THEMES, "auto");

export const applyLook = (look: Look) => apply("look", LOOK_KEY, look, "standard");
export const applyTheme = (theme: Theme) => apply("theme", THEME_KEY, theme, "auto");

/**
 * The browser's own chrome — a phone's status bar, an installed app's title bar —
 * painted the ground the page is actually showing.
 *
 * Read back from the page rather than kept in a table here, because that ground now
 * depends on three things at once: the look, the manual theme, and the system's
 * scheme when the theme is auto. index.html's two media-keyed values are only the
 * first paint's guess, and are right for the Standard look alone.
 */
export function syncChrome(): void {
  const ground = getComputedStyle(document.body).backgroundColor;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = ground;
  });
}
