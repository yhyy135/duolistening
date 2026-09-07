import type { LanguageCode, ModelSlot, SettingsCheck, SlotCheck } from "../shared/model.ts";
import { ModelError, type ModelErrorReason, createTextModel } from "./text-model.ts";

// Trying the two model slots for real, so a typo in a base URL or a model name
// surfaces on the Settings screen rather than fifteen minutes into an import.

/** Short enough to cost nothing, and it still exercises auth, routing and the model name. */
const PROMPT = "Reply with the single word: ok";

/** The reason codes, aimed at the person reading the Settings screen. */
const HINT: Record<ModelErrorReason, string> = {
  auth: "The API key was rejected.",
  bad_request: "The request was rejected — most often the model name is wrong.",
  rate_limit: "Rate limited. The key looks fine; try again shortly.",
  server: "The provider returned a server error.",
  network: "Could not reach that base URL.",
  bad_response: "It answered, but not in the shape an OpenAI-compatible endpoint should.",
};

export interface CheckOptions {
  textModel: ModelSlot;
  transcriptionModel: ModelSlot;
  targetLanguage?: LanguageCode;
  fetch?: typeof globalThis.fetch;
}

/**
 * Tries both slots at once and reports each separately, so one broken slot does not
 * hide the state of the other.
 */
export async function checkSettings(options: CheckOptions): Promise<SettingsCheck> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const [textModel, transcriptionModel] = await Promise.all([
    probe(options.textModel, () =>
      createTextModel({ slot: options.textModel, fetch: doFetch }).complete(PROMPT),
    ),
    probe(options.transcriptionModel, () =>
      transcribeClip(options.transcriptionModel, options.targetLanguage, doFetch),
    ),
  ]);
  return { textModel, transcriptionModel };
}

/**
 * Posts a second of quiet tone to `/audio/transcriptions` — the endpoint the pipeline
 * calls, with the model name the pipeline will use. A cheaper probe, listing
 * `/models` or resolving the host, passes for a model that does not exist and for a
 * provider that cannot transcribe at all.
 *
 * It uploads the clip where an import hands over a URL, and that is a real gap rather
 * than an oversight: a provider could accept this and still not know the `url`
 * parameter ADR 0010 relies on. Closing it properly needs a fetchable clip, so it
 * needs somewhere to host one; detecting it from the shape of an error message would
 * couple this screen to one provider's wording. So the gap is named here instead —
 * everything else about the slot is proven, and `url` support fails loudly on the
 * first import with the provider's own message.
 *
 * The clip is generated rather than committed: a fixture would be a binary blob in
 * the repo that nobody could review.
 */
async function transcribeClip(
  slot: ModelSlot,
  language: LanguageCode | undefined,
  doFetch: typeof globalThis.fetch,
): Promise<void> {
  const endpoint = `${slot.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;
  const form = new FormData();
  form.set("file", new Blob([quietTone()], { type: "audio/wav" }), "probe.wav");
  form.set("model", slot.model);
  if (language) form.set("language", language);

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${slot.apiKey}` },
      body: form,
    });
  } catch (cause) {
    throw new ModelError("network", `Could not reach ${endpoint}`, { cause });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ModelError(reasonFor(response.status), detail.slice(0, 300));
  }
}

async function probe(slot: ModelSlot, work: () => Promise<unknown>): Promise<SlotCheck> {
  // Calling out with a blank base URL would fail as a confusing network error.
  if (!slot.baseUrl.trim() || !slot.model.trim()) {
    return { ok: false, detail: "Not configured." };
  }
  try {
    await work();
    return { ok: true, detail: "" };
  } catch (error) {
    return { ok: false, detail: explain(error) };
  }
}

function explain(error: unknown): string {
  if (!(error instanceof ModelError)) {
    return error instanceof Error ? error.message : String(error);
  }
  return `${HINT[error.reason]} ${error.message}`.trim();
}

function reasonFor(status: number): ModelErrorReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

/**
 * One second of a quiet 440 Hz tone as a 16-bit mono WAV.
 *
 * A tone rather than digital silence: some endpoints treat an all-zero clip as no
 * audio at all and reject it, which would report a working slot as broken.
 *
 * Written with a DataView rather than Node's Buffer, which the browser does not have.
 */
export function quietTone(): Uint8Array<ArrayBuffer> {
  const rate = 16000;
  const samples = rate;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (at: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(at + index, text.charCodeAt(index));
    }
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);

  for (let index = 0; index < samples; index++) {
    view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 3000), true);
  }
  return bytes;
}
