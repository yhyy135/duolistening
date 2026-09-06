// Trying the two model slots for real, so a typo in a base URL or a model name
// surfaces on the Settings screen rather than fifteen minutes into an import.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelSlot, Settings, SettingsCheck, SlotCheck } from "../shared/model.ts";
import type { SpeechToText, TextModel } from "./ports.ts";
import { ModelError, type ModelErrorReason } from "./text-model.ts";

/** Short enough to cost nothing, and it still exercises auth, routing and the model name. */
const PROMPT = "Reply with the single word: ok";

/**
 * ports.ts documents what each reason means for the caller; this is that guidance
 * aimed at the person reading the Settings screen.
 */
const HINT: Record<ModelErrorReason, string> = {
  auth: "The API key was rejected.",
  bad_request: "The request was rejected — most often the model name is wrong.",
  rate_limit: "Rate limited. The key looks fine; try again shortly.",
  server: "The provider returned a server error.",
  network: "Could not reach that base URL.",
  bad_response: "It answered, but not in the shape an OpenAI-compatible endpoint should.",
};

export interface ModelCheckOptions {
  textModel: (settings: Settings) => TextModel;
  speechToText: (settings: Settings) => SpeechToText;
}

/**
 * Tries both slots at once and reports each separately, so one broken slot does not
 * hide the state of the other.
 *
 * Each probe calls the same method the pipeline calls, against the same endpoint —
 * a cheaper check (a `/models` listing, say) would pass for a model name that does
 * not exist and a provider that cannot transcribe.
 */
export function createSettingsCheck(options: ModelCheckOptions) {
  return async function check(settings: Settings): Promise<SettingsCheck> {
    const [textModel, transcriptionModel] = await Promise.all([
      probe(settings.textModel, () => options.textModel(settings).complete(PROMPT)),
      probe(settings.transcriptionModel, async () => {
        // The endpoint wants a file, so it gets one — a second of quiet tone, a few
        // tens of kilobytes, costing a rounding error at any provider's per-minute
        // rate. Generated rather than committed: a fixture would be a binary blob in
        // the repo that nobody could review.
        const clip = path.join(
          await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-check-")),
          "probe.wav",
        );
        try {
          await fs.writeFile(clip, quietTone());
          await options.speechToText(settings).transcribeChunk(clip, settings.targetLanguage);
        } finally {
          await fs.rm(path.dirname(clip), { recursive: true, force: true });
        }
      }),
    ]);
    return { textModel, transcriptionModel };
  };
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

/**
 * One second of a quiet 440 Hz tone as a 16-bit mono WAV.
 *
 * A tone rather than digital silence: some endpoints treat an all-zero clip as no
 * audio at all and reject it, which would report a working slot as broken.
 */
function quietTone(): Buffer {
  const rate = 16000;
  const samples = rate;
  const body = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    body.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}
