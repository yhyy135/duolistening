import { storageKeys, type ModelSlot, type Settings } from "../shared/model.ts";
import type { Storage } from "./ports.ts";

const EMPTY_SLOT: ModelSlot = { baseUrl: "", apiKey: "", model: "" };

const DEFAULTS: Settings = {
  textModel: EMPTY_SLOT,
  transcriptionModel: EMPTY_SLOT,
  nativeLanguage: "en",
  // No targetLanguage: unset means "detect it per recording", and a default here
  // would silently pin every import to Japanese for someone who never opened Settings.
};

/** Marks a key the browser was never shown. Anything starting with it means "unchanged". */
const MASK = "••••";

export function readSettings(storage: Storage): Promise<Settings> {
  return storage
    .readDoc<Settings>(storageKeys.settings)
    .then((stored) => ({ ...DEFAULTS, ...stored }));
}

export function writeSettings(storage: Storage, settings: Settings): Promise<void> {
  return storage.writeDoc(storageKeys.settings, settings);
}

/** What the browser is allowed to see: enough of the key to recognise, not to use. */
export function maskSettings(settings: Settings): Settings {
  return {
    ...settings,
    textModel: maskSlot(settings.textModel),
    transcriptionModel: maskSlot(settings.transcriptionModel),
  };
}

/**
 * Applies an edit from the browser. A key that comes back still masked means the
 * user did not touch that field, so the stored one is kept — without this, opening
 * the settings screen and saving would wipe both keys.
 */
export function applySettingsEdit(current: Settings, edit: Settings): Settings {
  return {
    ...edit,
    textModel: mergeSlot(current.textModel, edit.textModel),
    transcriptionModel: mergeSlot(current.transcriptionModel, edit.transcriptionModel),
  };
}

function maskSlot(slot: ModelSlot): ModelSlot {
  if (!slot.apiKey) return slot;
  return { ...slot, apiKey: `${MASK}${slot.apiKey.slice(-4)}` };
}

function mergeSlot(current: ModelSlot, edit: ModelSlot): ModelSlot {
  return { ...edit, apiKey: edit.apiKey.startsWith(MASK) ? current.apiKey : edit.apiKey };
}
