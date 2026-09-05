import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { ModelSlot } from "../../shared/model.ts";
import type { ModelError } from "../text-model.ts";
import { createSpeechToText, toSegments } from "./speech-to-text.ts";

const slot: ModelSlot = {
  baseUrl: "https://api.example.com/v1/",
  apiKey: "sk-test",
  model: "whisper-1",
};

function stubFetch(...outcomes: Response[]) {
  const calls: { url: string; form: FormData }[] = [];
  let index = 0;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), form: init?.body as FormData });
    return (outcomes[Math.min(index++, outcomes.length - 1)] as Response).clone();
  }) as unknown as typeof globalThis.fetch;
  return Object.assign(fetch, { calls });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("verbose_json to segments", () => {
  it("keeps segment timing and text", () => {
    const segments = toSegments({
      segments: [
        { start: 0, end: 2.5, text: "今日は自己紹介をします" },
        { start: 2.5, end: 5, text: "よろしくお願いします" },
      ],
    });

    assert.deepEqual(segments, [
      { startSec: 0, endSec: 2.5, text: "今日は自己紹介をします" },
      { startSec: 2.5, endSec: 5, text: "よろしくお願いします" },
    ]);
  });

  it("files the flat word list into the segments they belong to", () => {
    // The API returns words for the whole request, not nested under each segment.
    const segments = toSegments({
      segments: [
        { start: 0, end: 2, text: "今日は" },
        { start: 2, end: 4, text: "自己紹介" },
      ],
      words: [
        { word: "今日", start: 0.1, end: 0.9 },
        { word: "は", start: 1.0, end: 1.4 },
        { word: "自己", start: 2.2, end: 2.9 },
        { word: "紹介", start: 3.0, end: 3.8 },
      ],
    });

    assert.deepEqual(
      segments[0]?.words?.map((word) => word.text),
      ["今日", "は"],
    );
    assert.deepEqual(
      segments[1]?.words?.map((word) => word.text),
      ["自己", "紹介"],
    );
  });

  it("gives a word straddling a boundary to exactly one segment", () => {
    const segments = toSegments({
      segments: [
        { start: 0, end: 2, text: "a" },
        { start: 2, end: 4, text: "b" },
      ],
      // Midpoint 2.1 — starts in the first segment, belongs to the second.
      words: [{ word: "またぐ", start: 1.7, end: 2.5 }],
    });

    assert.equal(segments[0]?.words, undefined);
    assert.deepEqual(
      segments[1]?.words?.map((word) => word.text),
      ["またぐ"],
    );
  });

  it("leaves words off when the endpoint returned none", () => {
    const segments = toSegments({ segments: [{ start: 0, end: 2, text: "hi" }] });
    assert.ok(!("words" in (segments[0] ?? {})));
  });

  it("returns nothing when there are no segments at all", () => {
    // Some providers answer with only a `text` field. One Line spanning the whole
    // episode is worse than none — it would make the lyrics view a wall of text.
    assert.deepEqual(toSegments({ text: "the entire episode as one blob" }), []);
  });
});

describe("speech to text", () => {
  let audioPath: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-stt-"));
    audioPath = path.join(dir, "chunk-0.m4a");
    await fs.writeFile(audioPath, "pretend audio");
  });

  it("posts the file and asks for word-level timing", async () => {
    const fetch = stubFetch(json({ segments: [{ start: 0, end: 1, text: "hi" }] }));
    await createSpeechToText({ slot, fetch }).transcribeChunk(audioPath, "ja");

    const call = fetch.calls[0];
    assert.equal(call?.url, "https://api.example.com/v1/audio/transcriptions");
    assert.equal(call?.form.get("model"), "whisper-1");
    assert.equal(call?.form.get("language"), "ja");
    assert.equal(call?.form.get("response_format"), "verbose_json");
    assert.deepEqual(call?.form.getAll("timestamp_granularities[]"), ["segment", "word"]);
    assert.ok(call?.form.get("file"));
  });

  it("retries without granularities when the provider rejects them", async () => {
    // Losing word timing is a downgrade the player handles; failing the whole import
    // because a provider does not know one optional field is not.
    const fetch = stubFetch(
      json({ error: "unknown parameter" }, 400),
      json({ segments: [{ start: 0, end: 1, text: "hi" }] }),
    );

    const segments = await createSpeechToText({ slot, fetch }).transcribeChunk(audioPath, "ja");

    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1]?.form.getAll("timestamp_granularities[]").length, 0);
    assert.equal(segments.length, 1);
  });

  it("reports a bad key as an auth failure, not a mystery", async () => {
    const fetch = stubFetch(json({ error: "nope" }, 401));

    await assert.rejects(
      createSpeechToText({ slot, fetch }).transcribeChunk(audioPath, "ja"),
      (error: ModelError) => {
        assert.equal(error.reason, "auth");
        return true;
      },
    );
  });

  it("reports an unreachable endpoint as a network failure", async () => {
    const fetch = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      createSpeechToText({ slot, fetch }).transcribeChunk(audioPath, "ja"),
      (error: ModelError) => {
        assert.equal(error.reason, "network");
        return true;
      },
    );
  });
});
