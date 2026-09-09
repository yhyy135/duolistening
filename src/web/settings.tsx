// Settings: the two model slots (ADR 0002), the byte proxy (ADR 0009), and the
// language pair.
//
// The masking used to protect a wire: the server sent `••••abcd`, a value coming
// back still masked meant "leave the stored key alone", and a Show button fetched
// the real one on demand. ADR 0008 removed the server, so a key never leaves this
// browser and there is no wire left to protect — what remains is shoulder surfing,
// a display concern only. It is no longer a password field over that concern,
// though: `type="password"` inside a form with a submit handler is exactly the
// shape Safari and Chrome watch for to offer to remember a website password, for a
// field that has never held one. The masking is CSS now — `-webkit-text-security`
// on a plain `type="text"` input — with autocomplete, autocorrect and
// autocapitalize all switched off so an API key survives being typed on a phone.

import { useEffect, useRef, useState } from "react";
import {
  LANGUAGES,
  type LanguageCode,
  type ModelSlot,
  type ProxySettings,
  type Settings,
  type SettingsCheck,
  type SlotCheck,
} from "../shared/model.ts";
import { Icon } from "./icons.tsx";
import { t as translate } from "../shared/i18n.ts";
import { rememberLocale, useLanguageName, useT } from "./i18n.ts";
import { checkSettings } from "./model-check.ts";
import { checkProxy, type ProxyCheck } from "./proxy.ts";
import { decodeSettings, encodeSettings } from "./settings-transfer.ts";
import { readSettings, writeSettings } from "./store.ts";
import { listModels } from "./text-model.ts";

type SlotField = "textModel" | "transcriptionModel";

interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Where this provider hands out a key. Absent for one that needs none (Ollama). */
  keyUrl?: string;
  /** False for a provider with no speech-to-text model — left off the Transcription
      Model slot's list entirely rather than offered and left to fail there. Default
      true. */
  transcription?: boolean;
}

/**
 * Quick-fill for the Base URL field. Not part of `ModelSlot` — nothing about which
 * preset was picked is stored, so the dropdown reverse-matches the current `baseUrl`
 * against this list and falls back to "custom" when it was typed by hand or edited
 * since (e.g. Cloudflare's ACCOUNT_ID placeholder).
 */
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    // Beta OpenAI compatibility layer: chat and models, no /audio/transcriptions.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    transcription: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    transcription: false,
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    // OpenAI-compatible since 2024; the account id has to be filled in by hand.
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
  },
  { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1" },
];

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
  /** Back, armed: the next click on it leaves without saving. */
  const [discarding, setDiscarding] = useState(false);
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
    // An armed Back is about the edits that existed when it was armed.
    setDiscarding(false);
  };

  /**
   * A whole Settings off the transfer string, replacing rather than merging: an absent
   * `targetLanguage` means "detect each recording's own language", and spreading this
   * over the current form would keep whatever language was set here instead.
   *
   * Nothing is written. The form goes dirty like any other edit, so Back still arms
   * and Save is still the thing that keeps it — a string someone pasted by mistake
   * costs one Back, not a Settings screen overwritten before they could look at it.
   */
  const applyImported = (imported: Settings) => {
    setSettings(imported);
    // The interface follows the pasted Native Language the same way the dropdown
    // makes it follow, so you can see what arrived. `savedRef` is untouched, so
    // discarding puts the old one back.
    onLocale(imported.nativeLanguage);
    setCheck(null);
    setProxyCheck(null);
    setModelsStatus({});
    setDiscarding(false);
    // Looked up in the language that just arrived, not through `t`. The interface has
    // only been told to switch; this render's `t` still answers in the language being
    // left, so the one sentence about the import would land in the wrong one.
    setStatus(translate(imported.nativeLanguage, "settings.imported"));
  };

  /**
   * Two clicks on one button, the way the shelf's Delete does it, and for a reason the
   * shelf only half stated: `confirm()` does not merely read as a browser error, it can
   * silently answer `false`. A viewer that blocks modals — a sandboxed frame, or Chrome
   * once a reader has ticked "prevent this page from creating additional dialogs" —
   * returns that without showing anything, and this button then did nothing at all,
   * forever, with no way to find out why. Changing the Native Language is enough to
   * make the form dirty, so that was most of the ways out of this screen.
   */
  const goBack = () => {
    const dirty = JSON.stringify(settings) !== JSON.stringify(savedRef.current);
    if (dirty && !discarding) return setDiscarding(true);
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
      <div className="settings-head">
        {/* Focus leaving disarms it, so a Back armed and then ignored is not a trap
            waiting for the next person who reaches for it. */}
        <button
          type="button"
          className={discarding ? "back armed" : "back"}
          onClick={goBack}
          onBlur={() => setDiscarding(false)}
        >
          <Icon name="arrow-left" />
          {discarding ? t("settings.discard") : t("common.back")}
        </button>
        <SettingsTransfer settings={settings} onImport={applyImported} />
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setStatus(t("common.saving"));
          try {
            await writeSettings(settings);
            savedRef.current = settings;
            // Only now, and only here. The interface has been following this dropdown
            // since it changed, but until this line nothing was stored, and a cache
            // written from the preview is what left readers with an interface in one
            // language and this screen showing another.
            rememberLocale(settings.nativeLanguage);
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
          <button
            type="button"
            className="ghost"
            disabled={checking}
            onClick={() => void test()}
          >
            {checking ? t("settings.testing") : t("settings.test")}
          </button>
          {status && <span className="notice">{status}</span>}
        </div>
      </form>
    </main>
  );
}

/**
 * Settings out of one browser and into another, as one string to copy (see
 * `settings-transfer.ts`, which is also where the honest description of what that
 * string protects lives — obfuscation, not confidentiality, which is why the export
 * says so on screen rather than letting the word "encrypted" imply otherwise).
 *
 * Two `<dialog>`s rather than two screens: this is the last thing anyone does on a new
 * device and the first thing they forget exists, and a route of its own would be one
 * more thing to find.
 */
function SettingsTransfer({
  settings,
  onImport,
}: {
  settings: Settings;
  onImport: (settings: Settings) => void;
}) {
  const t = useT();
  const exportRef = useRef<HTMLDialogElement>(null);
  const importRef = useRef<HTMLDialogElement>(null);
  const [cipher, setCipher] = useState("");
  /** Whatever the last copy attempt has to say — it succeeded, or it could not. */
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function showExport() {
    setCopyStatus(null);
    setCipher(await encodeSettings(settings));
    exportRef.current?.showModal();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(cipher);
      setCopyStatus(t("settings.copied"));
    } catch {
      // Denied permission, or an insecure origin. The text is on screen and selectable,
      // so saying what to do instead beats a button that quietly did nothing.
      setCopyStatus(t("settings.copyFailed"));
    }
  }

  async function apply() {
    const result = await decodeSettings(pasted);
    // Every way this fails means one thing to a reader — what you pasted is not one of
    // these strings — so there is one sentence for all of them. `result.problem` says
    // which, in English, for whoever is looking at a console.
    if (!result.ok) {
      console.warn("settings transfer:", result.problem);
      return setProblem(t("settings.importFailed"));
    }
    onImport(result.settings);
    setPasted("");
    setProblem(null);
    importRef.current?.close();
  }

  return (
    <div className="transfer">
      <button type="button" className="ghost" onClick={() => void showExport()}>
        <Icon name="download" />
        {t("settings.exportSettings")}
      </button>
      <button
        type="button"
        className="ghost"
        onClick={() => {
          setProblem(null);
          importRef.current?.showModal();
        }}
      >
        <Icon name="upload" />
        {t("settings.importSettings")}
      </button>

      <dialog ref={exportRef} className="ask-dialog transfer-dialog">
        <p className="text">{t("settings.exportTitle")}</p>
        {/* Ahead of the string, not under it: it says what the string is for, and
            that is worth reading before the eye lands on 500 characters of base64. */}
        <p className="note">{t("settings.exportWarning")}</p>
        {/* Read-only rather than a <p>: a textarea scrolls, selects, and hands the
            whole value to a manual copy when the clipboard API is not available. */}
        <textarea
          className="cipher"
          value={cipher}
          readOnly
          rows={6}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="actions">
          <button type="button" onClick={() => void copy()}>
            {t("settings.copy")}
          </button>
          <button type="button" className="ghost" onClick={() => exportRef.current?.close()}>
            {t("common.close")}
          </button>
          {copyStatus && <span className="notice">{copyStatus}</span>}
        </div>
      </dialog>

      <dialog ref={importRef} className="ask-dialog transfer-dialog">
        <p className="text">{t("settings.importTitle")}</p>
        <textarea
          className="cipher"
          value={pasted}
          placeholder={t("settings.cipherPlaceholder")}
          rows={6}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => setPasted(event.target.value)}
        />
        {problem && <p className="error">{problem}</p>}
        <div className="actions">
          <button type="button" disabled={!pasted.trim()} onClick={() => void apply()}>
            {t("settings.importApply")}
          </button>
          <button type="button" className="ghost" onClick={() => importRef.current?.close()}>
            {t("common.close")}
          </button>
        </div>
      </dialog>
    </div>
  );
}

/**
 * A key field. Always `type="text"` — never `type="password"`, which is what a
 * browser's password manager keys off, together with the submit handler around it.
 * Masking is `-webkit-text-security` instead (see the `.masked` rule in
 * styles.css), so revealing the value asks nobody anything: it is already here.
 */
function SecretInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const t = useT();
  return (
    <span className="field-row">
      <input
        type="text"
        className={shown ? undefined : "masked"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      <button
        type="button"
        className="ghost"
        onClick={() => setShown(!shown)}
        aria-label={t(shown ? "settings.hide" : "settings.show")}
      >
        <Icon name={shown ? "eye-off" : "eye"} />
      </button>
    </span>
  );
}

function Slot({
  field,
  legend,
  modelHint,
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
  // "Custom" is not a preset with a baseUrl of its own, so picking it is otherwise a
  // no-op: the dropdown's value is derived from `slot.baseUrl`, and with nothing
  // changed it immediately reverse-matches back to whichever preset that URL still
  // belongs to. This is the one bit of provider choice that has to live outside
  // `slot` — sticky until a real preset (or another blank slot) overrides it.
  const [forcedCustom, setForcedCustom] = useState(false);
  // DeepSeek etc: a preset with no speech-to-text model of its own has nothing to
  // offer the Transcription Model slot, so it is left out of that list entirely
  // rather than offered and left to fail against it.
  const presets = PROVIDER_PRESETS.filter(
    (preset) => field !== "transcriptionModel" || preset.transcription !== false,
  );
  const matched = presets.find((preset) => preset.baseUrl === slot.baseUrl);
  const activeProvider = forcedCustom ? undefined : matched;
  return (
    <fieldset>
      <legend>{legend}</legend>
      <label>
        {t("settings.provider")}
        <select
          value={activeProvider?.id ?? "custom"}
          onChange={(event) => {
            if (event.target.value === "custom") {
              setForcedCustom(true);
              return;
            }
            const preset = presets.find((candidate) => candidate.id === event.target.value);
            if (!preset) return;
            setForcedCustom(false);
            onChange({ ...slot, baseUrl: preset.baseUrl });
          }}
        >
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value="custom">{t("settings.providerCustom")}</option>
        </select>
      </label>
      <label>
        {t("settings.baseUrl")}
        <input
          value={slot.baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => {
            setForcedCustom(false);
            onChange({ ...slot, baseUrl: event.target.value });
          }}
        />
      </label>
      <ProviderHint field={field} provider={activeProvider} />
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
          <button
            type="button"
            className="ghost"
            disabled={fetchingModels}
            onClick={onFetchModels}
          >
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

/** The host to send someone to, stated plainly rather than as a full URL — the same
    shorthand `settings.groqHint` already used for console.groq.com. */
function hostOf(url: string): string {
  return new URL(url).hostname;
}

/**
 * Guidance for getting a key out of whichever provider is active, mirroring
 * mastersgo.cc's per-provider "create a key" links. One shape for every provider
 * that has a `keyUrl`: a line naming where the key comes from, then the link on its
 * own line. Groq's transcription slot and Cloudflare add one short tip above it —
 * the model Whisper actually wants, and the account id the base URL still needs —
 * but the key instructions underneath stay the same line, not a rewritten paragraph.
 */
function ProviderHint({
  field,
  provider,
}: {
  field: SlotField;
  provider: ProviderPreset | undefined;
}) {
  const t = useT();
  if (!provider) return null;
  if (provider.id === "ollama") return <p className="hint">{t("settings.ollamaHint")}</p>;
  return (
    <>
      {provider.id === "cloudflare" && (
        <p className="hint">
          {t("settings.cloudflareHint", {
            model:
              field === "transcriptionModel"
                ? "@cf/openai/whisper-large-v3-turbo"
                : "@cf/meta/llama-3.1-8b-instruct",
          })}
        </p>
      )}
      {provider.id === "groq" && field === "transcriptionModel" && (
        <p className="hint">{t("settings.groqHint")}</p>
      )}
      {provider.keyUrl && (
        <p className="hint">
          {t("settings.getApiKey", {
            host: hostOf(provider.keyUrl),
            action: t("settings.fetchModels"),
          })}
          <br />
          <a href={provider.keyUrl} target="_blank" rel="noreferrer">
            {t("settings.getApiKeyLink")}
          </a>
        </p>
      )}
    </>
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

/** Each language's own name for itself — shown beside the name the interface would
    write, so someone scanning the list finds their language by its own script whatever
    language the interface happens to be in. */
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

function languageLabel(code: LanguageCode, named: string): string {
  const native = NATIVE_NAMES[code];
  return native === named ? native : `${native} - ${named}`;
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
  const languageOf = useLanguageName();
  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange((event.target.value || undefined) as LanguageCode)}
    >
      {auto !== undefined && <option value="">{auto}</option>}
      {LANGUAGES.map((code) => (
        <option key={code} value={code}>
          {languageLabel(code, languageOf(code))}
        </option>
      ))}
    </select>
  );
}
