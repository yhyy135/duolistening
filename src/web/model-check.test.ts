import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelSlot } from "../shared/model.ts";
import { checkSettings, quietTone } from "./model-check.ts";

const good: ModelSlot = { baseUrl: "https://api.example/v1", apiKey: "k", model: "m" };

const chatOk = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));

/** Answers per endpoint, so the two slots can be given different fates. */
function router(answers: { chat?: () => Response; audio?: () => Response } = {}) {
  const urls: string[] = [];
  const bodies: FormData[] = [];
  const impl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/audio/transcriptions")) {
      bodies.push(init?.body as FormData);
      return answers.audio?.() ?? new Response("{}", { status: 200 });
    }
    return answers.chat?.() ?? chatOk();
  };
  return { impl, urls, bodies };
}

test("both slots are tried, and each is reported on its own", async () => {
  const fetch = router({ audio: () => new Response("no such model", { status: 400 }) });
  const result = await checkSettings({ textModel: good, transcriptionModel: good, fetch: fetch.impl });

  assert.equal(result.textModel.ok, true);
  assert.equal(result.transcriptionModel.ok, false);
  // A broken slot must not hide a working one, so both endpoints were called.
  assert.ok(fetch.urls.some((u) => u.endsWith("/chat/completions")));
  assert.ok(fetch.urls.some((u) => u.endsWith("/audio/transcriptions")));
});

test("each probe calls the endpoint the pipeline calls, not a cheaper one", async () => {
  const fetch = router();
  await checkSettings({ textModel: good, transcriptionModel: good, fetch: fetch.impl });

  // Listing /models would pass for a model name that does not exist.
  assert.equal(fetch.urls.some((u) => u.endsWith("/models")), false);
  assert.deepEqual(fetch.urls.sort(), [
    "https://api.example/v1/audio/transcriptions",
    "https://api.example/v1/chat/completions",
  ]);
});

test("the transcription probe sends real audio under the configured model name", async () => {
  const fetch = router();
  await checkSettings({
    textModel: good,
    transcriptionModel: { ...good, model: "whisper-large-v3-turbo" },
    targetLanguage: "ja",
    fetch: fetch.impl,
  });

  const form = fetch.bodies[0]!;
  assert.equal(form.get("model"), "whisper-large-v3-turbo");
  assert.equal(form.get("language"), "ja");
  const clip = form.get("file") as Blob;
  assert.equal(clip.type, "audio/wav");
  assert.ok(clip.size > 1000, "an empty probe would prove nothing");
});

test("an unconfigured slot says so without calling anything", async () => {
  for (const slot of [{ ...good, baseUrl: "" }, { ...good, model: "  " }]) {
    const fetch = router();
    const result = await checkSettings({ textModel: slot, transcriptionModel: good, fetch: fetch.impl });

    assert.equal(result.textModel.ok, false);
    assert.equal(result.textModel.detail, "Not configured.");
    // A blank base URL would otherwise fail as a confusing network error.
    assert.equal(fetch.urls.some((u) => u.endsWith("/chat/completions")), false);
  }
});

test("a failure explains itself in terms the reader can act on", async () => {
  const cases: [number, RegExp][] = [
    [401, /API key was rejected/],
    [400, /model name is wrong/],
    [429, /Rate limited/],
    [500, /server error/],
  ];
  for (const [status, hint] of cases) {
    const fetch = router({ audio: () => new Response("nope", { status }) });
    const result = await checkSettings({
      textModel: good,
      transcriptionModel: good,
      fetch: fetch.impl,
    });
    assert.match(result.transcriptionModel.detail, hint, `${status}`);
  }
});

test("an unreachable host is named as such, not as a rejected key", async () => {
  const fetch: typeof globalThis.fetch = () => Promise.reject(new Error("dns"));
  const result = await checkSettings({ textModel: good, transcriptionModel: good, fetch });

  assert.match(result.transcriptionModel.detail, /Could not reach/);
});

test("the probe clip is a real WAV, and is not digital silence", () => {
  const wav = quietTone();
  const view = new DataView(wav.buffer);
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...wav.slice(at, at + length));

  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(36, 4), "data");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 16000, "16kHz");
  assert.equal(view.getUint16(34, true), 16, "16-bit");
  // Header says exactly as many bytes as follow it, or a decoder truncates or over-reads.
  assert.equal(view.getUint32(40, true), wav.length - 44);
  assert.equal(view.getUint32(4, true), wav.length - 8);

  // Some endpoints treat an all-zero clip as no audio and reject it, which would
  // report a working slot as broken.
  const samples = new Int16Array(wav.buffer, 44, (wav.length - 44) / 2);
  assert.ok(samples.some((sample) => sample !== 0), "silence would fail a working slot");
  assert.ok(
    samples.every((sample) => Math.abs(sample) <= 3000),
    "quiet: loud enough to be audio, not loud enough to be unpleasant",
  );
});
