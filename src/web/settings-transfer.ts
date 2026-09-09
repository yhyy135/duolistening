// Settings out of one browser and into another, as a single string to copy.
//
// A Library is per-browser-per-origin (ADR 0008), so a phone and a laptop are two
// installs with nothing between them, and setting the second one up means retyping two
// base URLs, two API keys, two model names and the proxy's URL and key off a screen.
// This is that, as one paste.
//
// **This is obfuscation, not confidentiality, and the difference matters here.** The
// key below is a constant in a bundle anybody can download, so anybody who has this
// page can decrypt any string this produces. What it buys is that the result does not
// *look* like an API key: it will not be recognised and scraped by something crawling a
// screenshot, a chat log or a pastebin, and it cannot be read over a shoulder. What it
// does not buy is safety in posting it anywhere. The export dialog says so, in the
// reader's own language, rather than leaving the word "encrypted" to imply otherwise.
//
// The alternative is a passphrase the reader picks, run through PBKDF2 — real
// confidentiality, at the cost of a passphrase to remember and to get wrong. That is
// the upgrade path if this string ever needs to travel somewhere untrusted. The same
// reasoning is already written down one file over, on `ProxySettings.key`: a secret is
// only a secret because it is typed in per reader rather than compiled into a bundle.
//
// This is also the one path that deliberately carries secrets, which is the exact
// opposite of `backup.ts`'s rule that no secret leaves in an export. The two stay
// separate on purpose: a Library backup is a file that ends up in cloud storage and
// must not carry keys, while this is a string a reader reads off one of their own
// screens and types into another.

import {
  LANGUAGES,
  type LanguageCode,
  type ModelSlot,
  type Settings,
} from "../shared/model.ts";

/**
 * Not a secret — see the header. Named so that nobody later mistakes it for one and
 * starts protecting it, and versioned so a future format can change the key with it.
 */
const OBFUSCATION_SECRET = "duolistening/settings-transfer/v1";

/**
 * Marks the string as this app's, so "you pasted the wrong thing" is distinguishable
 * from "this did not decrypt" — and cheap to spot before any crypto runs.
 */
const PREFIX = "dl1.";

/** AES-GCM wants 12 bytes, and it is prepended to the ciphertext rather than stored. */
const IV_BYTES = 12;

const key = async () =>
  crypto.subtle.importKey(
    "raw",
    // SHA-256 of the constant, so the key is 32 bytes without writing 32 numbers out.
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(OBFUSCATION_SECRET)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

/** Every Setting, including the keys, as one line the reader can copy. */
export async function encodeSettings(settings: Settings): Promise<string> {
  // Fresh per export: reusing an IV under one fixed key is the way AES-GCM breaks.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await key(),
      new TextEncoder().encode(JSON.stringify(settings)),
    ),
  );
  const bytes = new Uint8Array(iv.length + sealed.length);
  bytes.set(iv);
  bytes.set(sealed, iv.length);
  return PREFIX + toBase64Url(bytes);
}

/**
 * The other half. `problem` is English and for a developer reading a console; the
 * screen shows one translated sentence, because every failure here means the same
 * thing to a reader — what you pasted is not a settings string from this app.
 */
export type TransferResult = { ok: true; settings: Settings } | { ok: false; problem: string };

export async function decodeSettings(text: string): Promise<TransferResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return { ok: false, problem: "Not a settings string." };

  let json: string;
  try {
    const bytes = fromBase64Url(trimmed.slice(PREFIX.length));
    // Authenticated, so a string edited by a character fails here rather than
    // decoding into something plausible and half-filling the form with it.
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) },
      await key(),
      bytes.subarray(IV_BYTES),
    );
    json = new TextDecoder().decode(opened);
  } catch {
    return { ok: false, problem: "That string is damaged or was not written by this app." };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, problem: "That string did not contain settings." };
  }

  const settings = validSettings(raw);
  return settings
    ? { ok: true, settings }
    : { ok: false, problem: "That string is missing settings this build needs." };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validSlot = (value: unknown): ModelSlot | null => {
  if (!isRecord(value)) return null;
  const { baseUrl, apiKey, model } = value;
  if (typeof baseUrl !== "string") return null;
  if (typeof apiKey !== "string") return null;
  if (typeof model !== "string") return null;
  return { baseUrl, apiKey, model };
};

/**
 * Rebuilt field by field rather than cast, which is what makes this a trust boundary
 * and not a cast with extra steps. A string is something a reader was handed, and a
 * hand-edited one must not be able to put a field of its own choosing into IndexedDB
 * — nor a `nativeLanguage` this build has no strings for, which would leave the
 * interface blank with no way back to a screen that could fix it.
 */
function validSettings(raw: unknown): Settings | null {
  if (!isRecord(raw)) return null;

  const textModel = validSlot(raw.textModel);
  const transcriptionModel = validSlot(raw.transcriptionModel);
  if (!textModel || !transcriptionModel) return null;

  const known = (value: unknown): value is LanguageCode =>
    typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
  if (!known(raw.nativeLanguage)) return null;

  const proxy = isRecord(raw.proxy) ? raw.proxy : null;

  return {
    textModel,
    transcriptionModel,
    nativeLanguage: raw.nativeLanguage,
    // Absent is a real value, not a missing one: it means "detect each recording's
    // own language", so an unknown code drops back to that rather than refusing.
    ...(known(raw.targetLanguage) && { targetLanguage: raw.targetLanguage }),
    ...(typeof proxy?.baseUrl === "string" &&
      typeof proxy.key === "string" && {
        proxy: { baseUrl: proxy.baseUrl, key: proxy.key },
      }),
  };
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
    character.charCodeAt(0),
  );
