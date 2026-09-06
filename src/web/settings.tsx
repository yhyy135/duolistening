// Settings: the two model slots (ADR 0002) and the language pair.

import { useEffect, useState } from "react";
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

  useEffect(() => {
    api.settings().then(setSettings, (failure: unknown) => setStatus(reason(failure)));
  }, []);

  if (!settings) return <p className="notice">{status ?? "Loading…"}</p>;

  const edit = (change: Partial<Settings>) => {
    setSettings({ ...settings, ...change });
    // A tick from before the edit would be vouching for something else.
    setCheck(null);
    setStatus(null);
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
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setStatus("Saving…");
          try {
            // The reply re-masks both keys, so what is on screen keeps matching what
            // is stored — and a second save in a row still means "leave them alone".
            setSettings(await api.saveSettings(settings));
            setStatus("Saved");
          } catch (failure) {
            setStatus(reason(failure));
          }
        }}
      >
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
          slot={settings.transcriptionModel}
          check={check?.transcriptionModel}
          onChange={(transcriptionModel) => edit({ transcriptionModel })}
        />

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
  slot,
  check,
  onChange,
}: {
  legend: string;
  modelHint: string;
  slot: ModelSlot;
  check: SlotCheck | undefined;
  onChange: (slot: ModelSlot) => void;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
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
          {LANGUAGE_NAMES[code]}
        </option>
      ))}
    </select>
  );
}
