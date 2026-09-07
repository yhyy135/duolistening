// Settings: the two model slots (ADR 0002), the byte proxy (ADR 0009), and the
// language pair.
//
// The masking is gone, and it is worth saying why rather than leaving a hole where
// it was. It existed because settings crossed a wire: the server sent `••••abcd`, a
// value coming back still masked meant "leave the stored key alone", and a Show
// button fetched the real one on demand. ADR 0008 removed the server, so a key never
// leaves this browser and there is no wire to protect. What is left is shoulder
// surfing, which is a display concern — hence a password field with a toggle that
// asks nobody anything.

import { useEffect, useRef, useState } from "react";
import {
  LANGUAGES,
  LANGUAGE_NAMES,
  type LanguageCode,
  type ModelSlot,
  type ProxySettings,
  type Settings,
  type SettingsCheck,
  type SlotCheck,
} from "../shared/model.ts";
import { useT } from "./i18n.ts";
import { checkSettings } from "./model-check.ts";
import { checkProxy, type ProxyCheck } from "./proxy.ts";
import { readSettings, writeSettings } from "./store.ts";
import { listModels } from "./text-model.ts";

type SlotField = "textModel" | "transcriptionModel";

const EMPTY_SLOT: ModelSlot = { baseUrl: "", apiKey: "", model: "" };
const BLANK: Settings = {
  textModel: EMPTY_SLOT,
  transcriptionModel: EMPTY_SLOT,
  nativeLanguage: "en",
  // No targetLanguage: unset means "detect it per recording", and a default here
  // would pin every import to one language for someone who never opened this screen.
};

/**
 * The clip a provider is asked to fetch for itself, and the URL the proxy is asked to
 * pull through. Same file, and it has to be absolute — whoever fetches it is not this
 * browser. A proxy narrowed with ALLOWED_HOSTS has to include this origin, or a
 * correctly configured proxy reports itself broken.
 */
const probeUrl = () => new URL("/probe.wav", location.origin).href;

const reason = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

/** `onLocale` so the interface switches language the moment the Native Language does,
    rather than on the next reload. */
export function SettingsScreen({ onLocale }: { onLocale: (code: LanguageCode) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [check, setCheck] = useState<SettingsCheck | null>(null);
  const [proxyCheck, setProxyCheck] = useState<ProxyCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [fetchingModels, setFetchingModels] = useState<SlotField | null>(null);
  const [modelOptions, setModelOptions] = useState<Partial<Record<SlotField, string[]>>>({});
  const [modelsStatus, setModelsStatus] = useState<Partial<Record<SlotField, SlotCheck>>>({});
  // What is actually stored, so Back can tell a real edit from a screen nobody touched.
  const savedRef = useRef<Settings | null>(null);
  const t = useT();

  useEffect(() => {
    readSettings().then(
      (loaded) => {
        const current = loaded ?? BLANK;
        savedRef.current = current;
        setSettings(current);
      },
      (failure: unknown) => setStatus(reason(failure)),
    );
  }, []);

  if (!settings) return <p className="notice">{status ?? t("common.loading")}</p>;

  const edit = (change: Partial<Settings>) => {
    setSettings({ ...settings, ...change });
    // A tick from before the edit would be vouching for something else.
    setCheck(null);
    setProxyCheck(null);
    setStatus(null);
    setModelsStatus({});
  };

  const goBack = () => {
    const dirty = JSON.stringify(settings) !== JSON.stringify(savedRef.current);
    if (dirty && !confirm(t("settings.discard"))) return;
    // The interface followed the unsaved Native Language; discarding puts it back.
    if (savedRef.current) onLocale(savedRef.current.nativeLanguage);
    history.back();
  };

  async function test() {
    const edited = settings as Settings;
    setChecking(true);
    setStatus(null);
    try {
      // Together, because a reader wants to know what is wrong, not what is wrong
      // first. Three probes against three different things.
      const [slots, proxy] = await Promise.all([
        checkSettings({
          textModel: edited.textModel,
          transcriptionModel: edited.transcriptionModel,
          ...(edited.targetLanguage && { targetLanguage: edited.targetLanguage }),
          probeUrl: probeUrl(),
        }),
        checkProxy(edited.proxy, probeUrl()),
      ]);
      setCheck(slots);
      setProxyCheck(proxy);
    } catch (failure) {
      setStatus(reason(failure));
    } finally {
      setChecking(false);
    }
  }

  async function fetchModels(field: SlotField) {
    setFetchingModels(field);
    try {
      const models = await listModels((settings as Settings)[field]);
      setModelOptions((current) => ({ ...current, [field]: models }));
      setModelsStatus((current) => ({
        ...current,
        [field]: { ok: true, detail: t("settings.modelsFound", { count: models.length }) },
      }));
    } catch (failure) {
      setModelsStatus((current) => ({
        ...current,
        [field]: { ok: false, detail: reason(failure) },
      }));
    } finally {
      setFetchingModels(null);
    }
  }

  return (
    <main className="settings">
      <button type="button" className="back" onClick={goBack}>
        {t("common.back")}
      </button>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setStatus(t("common.saving"));
          try {
            await writeSettings(settings);
            savedRef.current = settings;
            setStatus(t("common.saved"));
          } catch (failure) {
            setStatus(reason(failure));
          }
        }}
      >
        {/* First, and ahead of the slots below: the language pair is the setting
            someone actually comes back to change, while a key mistyped once is
            rarely touched again. */}
        <fieldset>
          <legend>{t("settings.languages")}</legend>
          <label>
            {t("settings.native")}
            <LanguageSelect
              value={settings.nativeLanguage}
              onChange={(nativeLanguage) => {
                // Only reachable with a real language: this select has no empty option.
                if (!nativeLanguage) return;
                edit({ nativeLanguage });
                onLocale(nativeLanguage);
              }}
            />
          </label>
          {/* Optional, and empty by default: each import detects its own language, so
              this is only worth setting to overrule a recording the model mishears. */}
          <label>
            {t("settings.studying")}
            <LanguageSelect
              value={settings.targetLanguage}
              auto={t("settings.autoDetect")}
              onChange={(targetLanguage) => edit({ targetLanguage })}
            />
          </label>
        </fieldset>

        <Slot
          field="textModel"
          legend={t("settings.textModel")}
          modelHint="gpt-4o-mini"
          slot={settings.textModel}
          check={check?.textModel}
          modelOptions={modelOptions.textModel}
          modelsStatus={modelsStatus.textModel}
          fetchingModels={fetchingModels === "textModel"}
          onFetchModels={() => void fetchModels("textModel")}
          onChange={(textModel) => edit({ textModel })}
        />
        <Slot
          field="transcriptionModel"
          legend={t("settings.transcriptionModel")}
          modelHint="whisper-1"
          hint={t("settings.groqHint")}
          slot={settings.transcriptionModel}
          check={check?.transcriptionModel}
          modelOptions={modelOptions.transcriptionModel}
          modelsStatus={modelsStatus.transcriptionModel}
          fetchingModels={fetchingModels === "transcriptionModel"}
          onFetchModels={() => void fetchModels("transcriptionModel")}
          onChange={(transcriptionModel) => edit({ transcriptionModel })}
        />
        <Proxy
          proxy={settings.proxy}
          check={proxyCheck}
          onChange={(proxy) => edit({ proxy })}
        />

        <div className="actions">
          <button type="submit">{t("common.save")}</button>
          <button type="button" className="ghost" disabled={checking} onClick={() => void test()}>
            {checking ? t("settings.testing") : t("settings.test")}
          </button>
          {status && <span className="notice">{status}</span>}
        </div>
      </form>
    </main>
  );
}

/**
 * A key field. `type="password"` and a toggle, which is the whole of what masking
 * has to be now: the value is already here, so revealing it asks nobody anything.
 */
function SecretInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [shown, setShown] = useState(false);
  const t = useT();
  return (
    <span className="field-row">
      <input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" className="ghost" onClick={() => setShown(!shown)}>
        {t("settings.show")}
      </button>
    </span>
  );
}

function Slot({
  field,
  legend,
  modelHint,
  hint,
  slot,
  check,
  modelOptions,
  modelsStatus,
  fetchingModels,
  onFetchModels,
  onChange,
}: {
  field: SlotField;
  legend: string;
  modelHint: string;
  /** A free-form tip shown under the legend — where to find a slot worth trying. */
  hint?: string;
  slot: ModelSlot;
  check: SlotCheck | undefined;
  /** Model ids from the last successful fetch, offered as the Model field's dropdown. */
  modelOptions: string[] | undefined;
  modelsStatus: SlotCheck | undefined;
  fetchingModels: boolean;
  onFetchModels: () => void;
  onChange: (slot: ModelSlot) => void;
}) {
  const datalistId = `models-${field}`;
  const t = useT();
  return (
    <fieldset>
      <legend>{legend}</legend>
      {hint && <p className="hint">{hint}</p>}
      <label>
        {t("settings.baseUrl")}
        <input
          value={slot.baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => onChange({ ...slot, baseUrl: event.target.value })}
        />
      </label>
      <label>
        {t("settings.apiKey")}
        <SecretInput value={slot.apiKey} onChange={(apiKey) => onChange({ ...slot, apiKey })} />
      </label>
      <label>
        {t("settings.model")}
        <span className="field-row">
          {/* A native datalist: typing filters the fetched list, and a model the list
              does not have can still be typed by hand — the same freedom the plain
              text field already had. */}
          <input
            value={slot.model}
            placeholder={modelHint}
            list={datalistId}
            onChange={(event) => onChange({ ...slot, model: event.target.value })}
          />
          <button type="button" className="ghost" disabled={fetchingModels} onClick={onFetchModels}>
            {fetchingModels ? t("settings.fetching") : t("settings.fetchModels")}
          </button>
        </span>
        {modelOptions && (
          <datalist id={datalistId}>
            {modelOptions.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        )}
      </label>
      {modelsStatus && (
        <p className={modelsStatus.ok ? "slot-check ok" : "slot-check bad"}>
          {modelsStatus.detail}
        </p>
      )}
      {check && (
        <p className={check.ok ? "slot-check ok" : "slot-check bad"}>
          {/* A passing check can still carry something worth reading: a provider that
              transcribed an upload but could not fetch a URL is not broken, and
              imports will not work either. */}
          {check.ok ? check.detail || t("settings.answered") : check.detail}
        </p>
      )}
    </fieldset>
  );
}

function Proxy({
  proxy,
  check,
  onChange,
}: {
  proxy: ProxySettings | undefined;
  check: ProxyCheck | null;
  onChange: (proxy: ProxySettings) => void;
}) {
  const current = proxy ?? { baseUrl: "", key: "" };
  const t = useT();
  return (
    <fieldset>
      <legend>{t("settings.proxy")}</legend>
      <p className="hint">{t("settings.proxyHint")}</p>
      <label>
        {t("settings.baseUrl")}
        <input
          value={current.baseUrl}
          placeholder="https://duolistening-proxy.workers.dev/"
          onChange={(event) => onChange({ ...current, baseUrl: event.target.value })}
        />
      </label>
      <label>
        {/* Not an API key: a shared secret the deployer hands out, and the proxy's
            only gate (ADR 0009). It is a secret precisely because it lives here
            rather than in the page everyone downloads. */}
        {t("settings.proxyKey")}
        <SecretInput value={current.key} onChange={(key) => onChange({ ...current, key })} />
      </label>
      {check && (
        <p className={check.ok ? "slot-check ok" : "slot-check bad"}>
          {check.ok ? t("settings.answered") : check.detail}
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

/** With `auto`, an empty option is offered and an empty value means "detect it". */
function LanguageSelect({
  value,
  auto,
  onChange,
}: {
  value: LanguageCode | undefined;
  auto?: string;
  onChange: (code: LanguageCode | undefined) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange((event.target.value || undefined) as LanguageCode)}
    >
      {auto !== undefined && <option value="">{auto}</option>}
      {LANGUAGES.map((code) => (
        <option key={code} value={code}>
          {languageLabel(code)}
        </option>
      ))}
    </select>
  );
}
