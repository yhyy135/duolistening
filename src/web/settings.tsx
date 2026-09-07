// Settings: the two model slots (ADR 0002) and the language pair.

import { useEffect, useRef, useState } from "react";
import {
  LANGUAGES,
  LANGUAGE_NAMES,
  type LanguageCode,
  type ModelSlot,
  type Settings,
  type SettingsCheck,
  type SlotCheck,
} from "../shared/model.ts";
import { api, reason } from "./api.ts";

export function SettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [check, setCheck] = useState<SettingsCheck | null>(null);
  const [checking, setChecking] = useState(false);
  // What is actually stored, so Back can tell a real edit from a screen nobody
  // touched without asking the server again.
  const savedRef = useRef<Settings | null>(null);

  useEffect(() => {
    api.settings().then(
      (loaded) => {
        savedRef.current = loaded;
        setSettings(loaded);
      },
      (failure: unknown) => setStatus(reason(failure)),
    );
  }, []);

  if (!settings) return <p className="notice">{status ?? "Loading…"}</p>;

  const edit = (change: Partial<Settings>) => {
    setSettings({ ...settings, ...change });
    // A tick from before the edit would be vouching for something else.
    setCheck(null);
    setStatus(null);
  };

  const goBack = () => {
    const dirty = JSON.stringify(settings) !== JSON.stringify(savedRef.current);
    if (dirty && !confirm("Discard unsaved changes?")) return;
    history.back();
  };

  async function test() {
    setChecking(true);
    setStatus(null);
    try {
      setCheck(await api.checkSettings(settings as Settings));
    } catch (failure) {
      setStatus(reason(failure));
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="settings">
      <button type="button" className="back" onClick={goBack}>
        ← Back
      </button>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setStatus("Saving…");
          try {
            // The reply re-masks both keys, so what is on screen keeps matching what
            // is stored — and a second save in a row still means "leave them alone".
            const saved = await api.saveSettings(settings);
            savedRef.current = saved;
            setSettings(saved);
            setStatus("Saved");
          } catch (failure) {
            setStatus(reason(failure));
          }
        }}
      >
        {/* First, and ahead of the two model slots below: the language pair is the
            setting someone actually comes back to change, while a key mistyped once
            is rarely touched again. */}
        <fieldset>
          <legend>Languages</legend>
          <label>
            Studying
            <LanguageSelect
              value={settings.targetLanguage}
              onChange={(targetLanguage) => edit({ targetLanguage })}
            />
          </label>
          <label>
            Translate into
            <LanguageSelect
              value={settings.nativeLanguage}
              onChange={(nativeLanguage) => edit({ nativeLanguage })}
            />
          </label>
        </fieldset>

        <Slot
          legend="Text Model — translation and the ask-AI popup"
          modelHint="gpt-4o-mini"
          slot={settings.textModel}
          check={check?.textModel}
          onChange={(textModel) => edit({ textModel })}
        />
        <Slot
          legend="Transcription Model — speech to text"
          modelHint="whisper-1"
          hint="Groq runs Whisper for free: try https://api.groq.com/openai/v1 with model whisper-large-v3-turbo — get a key at console.groq.com."
          slot={settings.transcriptionModel}
          check={check?.transcriptionModel}
          onChange={(transcriptionModel) => edit({ transcriptionModel })}
        />

        <div className="actions">
          <button type="submit">Save</button>
          <button
            type="button"
            className="ghost"
            disabled={checking}
            onClick={() => void test()}
          >
            {checking ? "Testing…" : "Test connection"}
          </button>
          {status && <span className="notice">{status}</span>}
        </div>
      </form>
    </main>
  );
}

function Slot({
  legend,
  modelHint,
  hint,
  slot,
  check,
  onChange,
}: {
  legend: string;
  modelHint: string;
  /** A free-form tip shown under the legend — where to find a slot worth trying. */
  hint?: string;
  slot: ModelSlot;
  check: SlotCheck | undefined;
  onChange: (slot: ModelSlot) => void;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      {hint && <p className="hint">{hint}</p>}
      <label>
        Base URL
        <input
          value={slot.baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => onChange({ ...slot, baseUrl: event.target.value })}
        />
      </label>
      <label>
        API key
        {/* Arrives masked (••••abcd). Sending it back unchanged keeps the stored key. */}
        <input
          value={slot.apiKey}
          onChange={(event) => onChange({ ...slot, apiKey: event.target.value })}
        />
      </label>
      <label>
        Model
        <input
          value={slot.model}
          placeholder={modelHint}
          onChange={(event) => onChange({ ...slot, model: event.target.value })}
        />
      </label>
      {check && (
        <p className={check.ok ? "slot-check ok" : "slot-check bad"}>
          {check.ok ? "✓ Answered." : check.detail}
        </p>
      )}
    </fieldset>
  );
}

/** Each language's own name for itself — shown beside the English name (which is
    what LANGUAGE_NAMES is really for: naming the language to the Text Model), so
    someone scanning the list finds their language by its own script. */
const NATIVE_NAMES: Record<LanguageCode, string> = {
  ja: "日本語",
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
};

function languageLabel(code: LanguageCode): string {
  const native = NATIVE_NAMES[code];
  const english = LANGUAGE_NAMES[code];
  return native === english ? native : `${native} - ${english}`;
}

function LanguageSelect({
  value,
  onChange,
}: {
  value: LanguageCode;
  onChange: (code: LanguageCode) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as LanguageCode)}>
      {LANGUAGES.map((code) => (
        <option key={code} value={code}>
          {languageLabel(code)}
        </option>
      ))}
    </select>
  );
}
