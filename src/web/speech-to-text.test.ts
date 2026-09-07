import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelSlot } from "../shared/model.ts";
import {
  TranscriptionError,
  createSpeechToText,
  toSegments,
  type VerboseJson,
} from "./speech-to-text.ts";

const slot: ModelSlot = {
  baseUrl: "https://api.example/v1/",
  apiKey: "k",
  model: "whisper-large-v3-turbo",
};

const body = (over: Partial<VerboseJson> = {}): VerboseJson => ({
  duration: 928.57,
  segments: [
    { start: 0, end: 5, text: "one" },
    { start: 5, end: 10, text: "two" },
  ],
  ...over,
});

const ok = (json: unknown) =>
  new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });

/** Records every request so the form fields can be asserted on. */
function spy(...answers: Response[]) {
  const forms: FormData[] = [];
  const urls: string[] = [];
  let call = 0;
  const impl: typeof globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    forms.push(init?.body as FormData);
    return answers[Math.min(call++, answers.length - 1)] ?? ok(body());
  };
  return { impl, forms, urls, get calls() { return call; } };
}

test("the endpoint is handed a url, never bytes", async () => {
  const fetch = spy(ok(body()));
  const stt = createSpeechToText({ slot, fetch: fetch.impl });
  await stt.transcribeUrl("https://proxy/?range=0-25999999");

  assert.equal(fetch.urls[0], "https://api.example/v1/audio/transcriptions");
  assert.equal(fetch.forms[0]?.get("url"), "https://proxy/?range=0-25999999");
  assert.equal(fetch.forms[0]?.has("file"), false, "the browser never uploads the audio");
  assert.equal(fetch.forms[0]?.get("model"), "whisper-large-v3-turbo");
  assert.equal(fetch.forms[0]?.get("response_format"), "verbose_json");
});

test("both granularities are asked for, because word alone returns no segments", async () => {
  const fetch = spy(ok(body()));
  await createSpeechToText({ slot, fetch: fetch.impl }).transcribeUrl("https://proxy/");

  assert.deepEqual(fetch.forms[0]?.getAll("timestamp_granularities[]"), ["segment", "word"]);
});

test("the language is sent only when there is one to send", async () => {
  const withLanguage = spy(ok(body()));
  await createSpeechToText({ slot, fetch: withLanguage.impl }).transcribeUrl("https://p/", "ja");
  assert.equal(withLanguage.forms[0]?.get("language"), "ja");

  const without = spy(ok(body()));
  await createSpeechToText({ slot, fetch: without.impl }).transcribeUrl("https://p/");
  assert.equal(without.forms[0]?.has("language"), false, "unset means let the endpoint detect it");
});

test("a provider that rejects granularities is retried without them", async () => {
  const fetch = spy(new Response("unknown field", { status: 400 }), ok(body()));
  const result = await createSpeechToText({ slot, fetch: fetch.impl }).transcribeUrl("https://p/");

  assert.equal(fetch.calls, 2);
  assert.equal(fetch.forms[1]?.has("timestamp_granularities[]"), false);
  assert.equal(result.segments.length, 2);
});

test("a 400 that means the file is too big is not retried", async () => {
  const detail = JSON.stringify({
    error: { message: "media file too large - size limit: 26214400", code: "media_too_large" },
  });
  const fetch = spy(new Response(detail, { status: 400 }));

  await assert.rejects(
    createSpeechToText({ slot, fetch: fetch.impl }).transcribeUrl("https://p/"),
    (error: TranscriptionError) => error.reason === "too_large",
  );
  // Retrying sends the same oversized file again and fails identically, twice as slowly.
  assert.equal(fetch.calls, 1);
});

test("statuses become reasons a caller can act on", async () => {
  const cases: [number, string][] = [
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [413, "too_large"],
    [500, "server"],
    [502, "server"],
  ];
  for (const [status, reason] of cases) {
    const fetch = spy(new Response("no", { status }));
    await assert.rejects(
      createSpeechToText({ slot, fetch: fetch.impl }).transcribeUrl("https://p/"),
      (error: TranscriptionError) => error.reason === reason,
      `${status} should be ${reason}`,
    );
  }
});

test("an unreachable endpoint is a network failure, not a crash", async () => {
  const fetch: typeof globalThis.fetch = () => Promise.reject(new Error("dns"));
  await assert.rejects(
    createSpeechToText({ slot, fetch }).transcribeUrl("https://p/"),
    (error: TranscriptionError) => error.reason === "network",
  );
});

test("a reply with no duration is refused rather than guessed at", async () => {
  // The duration is the byte-rate denominator: without it the next chunk's seam
  // would be placed from a number nobody supplied.
  for (const duration of [undefined, 0, "928" as unknown as number]) {
    const fetch = spy(ok(body({ duration })));
    await assert.rejects(
      createSpeechToText({ slot, fetch: fetch.impl }).transcribeUrl("https://p/"),
      (error: TranscriptionError) => error.reason === "bad_response",
      `duration ${String(duration)} should be refused`,
    );
  }
});

test("words are assigned to the segment their midpoint falls in", () => {
  const segments = toSegments(
    body({
      words: [
        { word: "a", start: 0, end: 2 },
        // Straddles the boundary; its midpoint at 5.5 puts it in the second segment.
        { word: "b", start: 4.5, end: 6.5 },
        { word: "c", start: 7, end: 9 },
      ],
    }),
  );

  assert.deepEqual(segments[0]?.words?.map((w) => w.text), ["a"]);
  assert.deepEqual(segments[1]?.words?.map((w) => w.text), ["b", "c"]);
});

test("segments come back whole when the provider gave no word timing", () => {
  // Including the real shape a provider returns when only `word` was requested.
  for (const words of [undefined, null, []]) {
    const segments = toSegments(body({ words }));
    assert.equal(segments.length, 2);
    assert.equal("words" in segments[0]!, false, "absent, never empty (ADR 0004)");
  }
});

test("a reply with only `text` and no segments is nothing, not one giant Line", () => {
  for (const segments of [undefined, null, []]) {
    assert.deepEqual(toSegments({ duration: 10, text: "the whole episode", segments }), []);
  }
});

test("a segment missing its timestamps is dropped, not defaulted to zero", () => {
  const segments = toSegments(
    body({ segments: [{ start: 0, end: 5, text: "keep" }, { end: 10, text: "no start" }] }),
  );
  assert.deepEqual(segments.map((s) => s.text), ["keep"]);
});
