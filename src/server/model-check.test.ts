import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { describe, it } from "node:test";
import type { Settings } from "../shared/model.ts";
import { createFfmpegAudioTool } from "./audio/ffmpeg.ts";
import { createSettingsCheck } from "./model-check.ts";
import type { SpeechToText, TextModel } from "./ports.ts";
import { ModelError } from "./text-model.ts";

const settings: Settings = {
  textModel: { baseUrl: "https://example.com/v1", apiKey: "k", model: "gpt" },
  transcriptionModel: { baseUrl: "https://example.com/v1", apiKey: "k", model: "whisper" },
  nativeLanguage: "zh-CN",
  targetLanguage: "ja",
};

const workingText: TextModel = {
  complete: async () => "ok",
  completeJson: async () => {
    throw new Error("unused");
  },
};
const workingSpeech: SpeechToText = { transcribeChunk: async () => [] };

const build = (parts: { text?: TextModel; speech?: SpeechToText } = {}) =>
  createSettingsCheck({
    textModel: () => parts.text ?? workingText,
    speechToText: () => parts.speech ?? workingSpeech,
  });

describe("settings check", () => {
  it("passes when both slots answer", async () => {
    assert.deepEqual(await build()(settings), {
      textModel: { ok: true, detail: "" },
      transcriptionModel: { ok: true, detail: "" },
    });
  });

  it("reports each slot separately, so one failure does not hide the other", async () => {
    const result = await build({
      text: {
        ...workingText,
        complete: async () => {
          throw new ModelError("auth", "401 Unauthorized");
        },
      },
    })(settings);

    assert.equal(result.textModel.ok, false);
    assert.match(result.textModel.detail, /API key was rejected/);
    assert.equal(result.transcriptionModel.ok, true, "the other slot was still tried");
  });

  it("turns each failure reason into something worth reading", async () => {
    const reasonSays = async (error: ModelError) =>
      (
        await build({
          text: {
            ...workingText,
            complete: async () => {
              throw error;
            },
          },
        })(settings)
      ).textModel.detail;

    assert.match(
      await reasonSays(new ModelError("bad_request", "404 no such model")),
      /model name/,
    );
    assert.match(await reasonSays(new ModelError("network", "ECONNREFUSED")), /base URL/);
    assert.match(await reasonSays(new ModelError("rate_limit", "429")), /key looks fine/);
  });

  it("says so instead of calling out when a slot is blank", async () => {
    let called = false;
    const result = await build({
      text: {
        ...workingText,
        complete: async () => {
          called = true;
          return "ok";
        },
      },
    })({ ...settings, textModel: { baseUrl: "", apiKey: "", model: "" } });

    assert.deepEqual(result.textModel, { ok: false, detail: "Not configured." });
    assert.equal(
      called,
      false,
      "an empty base URL would only fail as a confusing network error",
    );
  });

  it("hands the transcription endpoint a real, playable clip", async () => {
    // The point of the whole probe is that it exercises the actual endpoint, so the
    // file has to be audio a decoder accepts. A fake SpeechToText would happily take
    // a corrupt header and every real provider would then reject a working slot —
    // so this asks ffprobe, not the fake.
    let probed: { durationSec: number; bytes: number } | null = null;
    const audio = createFfmpegAudioTool();

    await build({
      speech: {
        transcribeChunk: async (audioPath) => {
          probed = {
            durationSec: await audio.durationSec(audioPath),
            bytes: (await fs.stat(audioPath)).size,
          };
          return [];
        },
      },
    })(settings);

    assert.ok(probed, "the transcription slot was probed");
    const { durationSec, bytes } = probed as unknown as { durationSec: number; bytes: number };
    assert.ok(Math.abs(durationSec - 1) < 0.05, `ffprobe read ${durationSec}s, expected ~1s`);
    assert.equal(
      bytes,
      44 + 16000 * 2,
      "44-byte header plus a second of 16-bit mono at 16 kHz",
    );
  });

  it("cleans up the clip whether the probe passed or failed", async () => {
    const seen: string[] = [];
    const capture: SpeechToText = {
      transcribeChunk: async (audioPath) => {
        seen.push(audioPath);
        throw new ModelError("server", "502");
      },
    };

    await build({ speech: capture })(settings);

    assert.equal(seen.length, 1);
    await assert.rejects(
      () => fs.stat(seen[0] as string),
      "the temp clip must not be left behind",
    );
  });
});
