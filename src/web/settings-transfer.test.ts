import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSettings, encodeSettings } from "./settings-transfer.ts";
import type { Settings } from "../shared/model.ts";

const full: Settings = {
  textModel: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-text", model: "gpt-4o-mini" },
  transcriptionModel: {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "gsk-speech",
    model: "whisper-large-v3-turbo",
  },
  nativeLanguage: "zh-CN",
  targetLanguage: "ja",
  proxy: { baseUrl: "https://proxy.example.workers.dev", key: "proxy-secret" },
};

test("a round trip returns every field, keys included — which is the point", async () => {
  const decoded = await decodeSettings(await encodeSettings(full));
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.settings, full);
});

test("two exports of the same Settings differ, because the IV is fresh each time", async () => {
  assert.notEqual(await encodeSettings(full), await encodeSettings(full));
});

test("an absent targetLanguage stays absent rather than becoming a default", async () => {
  const { targetLanguage: _dropped, ...detecting } = full;
  const decoded = await decodeSettings(await encodeSettings(detecting));
  assert.ok(decoded.ok);
  assert.equal("targetLanguage" in decoded.settings, false);
});

test("something that is not one of these strings is refused, not parsed", async () => {
  for (const nonsense of ["", "   ", "hello", "sk-a-real-looking-key", "dl1.", "dl1.!!!!"]) {
    assert.equal((await decodeSettings(nonsense)).ok, false, nonsense);
  }
});

test("one edited character fails the tag rather than decoding to something plausible", async () => {
  const encoded = await encodeSettings(full);
  // A character in the middle, not the last one. Base64 encodes four characters to
  // three bytes, so when the body's length is not a multiple of four the final
  // character carries bits that decoding throws away — flipping *that* one is not an
  // edit at all, and a test doing it passes on the length of the day rather than on
  // anything AES-GCM did.
  const at = Math.floor(encoded.length / 2);
  const flipped =
    encoded.slice(0, at) + (encoded[at] === "A" ? "B" : "A") + encoded.slice(at + 1);
  assert.notEqual(flipped, encoded);
  assert.equal((await decodeSettings(flipped)).ok, false);
});

test("a truncated paste is refused, which is the mistake people actually make", async () => {
  const encoded = await encodeSettings(full);
  assert.equal((await decodeSettings(encoded.slice(0, -8))).ok, false);
});

test("whitespace around a pasted string is forgiven — copying picks it up", async () => {
  const decoded = await decodeSettings(`\n  ${await encodeSettings(full)}  \n`);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.settings, full);
});

test("a string missing a model slot is refused whole", async () => {
  const { textModel: _gone, ...partial } = full;
  const encoded = await encodeSettings(partial as unknown as Settings);
  assert.equal((await decodeSettings(encoded)).ok, false);
});

test("an unknown nativeLanguage is refused, an unknown targetLanguage only dropped", async () => {
  const wrongNative = await encodeSettings({
    ...full,
    nativeLanguage: "xx",
  } as unknown as Settings);
  assert.equal((await decodeSettings(wrongNative)).ok, false);

  const wrongTarget = await decodeSettings(
    await encodeSettings({ ...full, targetLanguage: "xx" } as unknown as Settings),
  );
  assert.ok(wrongTarget.ok);
  assert.equal("targetLanguage" in wrongTarget.settings, false);
});

test("a field nobody asked for does not ride along into the store", async () => {
  const encoded = await encodeSettings({
    ...full,
    somethingElse: "smuggled",
  } as unknown as Settings);
  const decoded = await decodeSettings(encoded);
  assert.ok(decoded.ok);
  assert.equal("somethingElse" in decoded.settings, false);
});
