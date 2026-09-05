import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTranscriber, planCuts } from "./transcriber.ts";
import type { AudioTool, RawSegment, Silence, SpeechToText } from "./ports.ts";

const silence = (startSec: number, endSec: number): Silence => ({ startSec, endSec });

function stubAudio(durationSec: number, silences: Silence[] = []) {
  const extracted: { startSec: number; endSec: number }[] = [];
  const tool: AudioTool = {
    durationSec: async () => durationSec,
    detectSilences: async () => silences,
    extract: async (_source, startSec, endSec) => {
      extracted.push({ startSec, endSec });
    },
  };
  return Object.assign(tool, { extracted });
}

/** Returns one segment per chunk, always starting at that chunk's own zero. */
function stubSpeech(segments: (chunkIndex: number) => RawSegment[]) {
  const calls: string[] = [];
  const speech: SpeechToText = {
    transcribeChunk: async (audioPath) => {
      const index = calls.length;
      calls.push(audioPath);
      return segments(index);
    },
  };
  return Object.assign(speech, { calls });
}

describe("planCuts", () => {
  it("keeps a short recording whole", () => {
    assert.deepEqual(planCuts(600, [], 1200, 90), [{ startSec: 0, endSec: 600 }]);
  });

  it("cuts in the last pause before the limit", () => {
    const cuts = planCuts(2000, [silence(1100, 1110), silence(1180, 1190)], 1200, 90);

    assert.deepEqual(cuts, [
      { startSec: 0, endSec: 1185 },
      { startSec: 1185, endSec: 2000 },
    ]);
  });

  it("ignores pauses too far back to be worth using", () => {
    // Only silence is at 100s, well outside the 90s window before the 1200s limit.
    const cuts = planCuts(2000, [silence(100, 110)], 1200, 90);
    assert.equal(cuts[0]?.endSec, 1200, "falls back to the hard limit");
  });

  it("cuts on the limit when someone talks straight through it", () => {
    const cuts = planCuts(3000, [], 1200, 90);

    assert.deepEqual(cuts, [
      { startSec: 0, endSec: 1200 },
      // The 1800s left over would split into 1200 + 600; halving it avoids the runt.
      { startSec: 1200, endSec: 2100 },
      { startSec: 2100, endSec: 3000 },
    ]);
  });

  it("splits the tail evenly rather than stranding a few seconds alone", () => {
    // 1205s left after the limit would otherwise be 1200 + 5, and a five-second clip
    // is where ASR models invent text.
    const cuts = planCuts(1205, [], 1200, 90);

    assert.deepEqual(cuts, [
      { startSec: 0, endSec: 602.5 },
      { startSec: 602.5, endSec: 1205 },
    ]);
  });

  it("never emits a chunk longer than the limit", () => {
    const silences = Array.from({ length: 40 }, (_, index) =>
      silence(index * 97, index * 97 + 2),
    );
    for (const cut of planCuts(7200, silences, 1200, 90)) {
      assert.ok(
        cut.endSec - cut.startSec <= 1200,
        `chunk ${JSON.stringify(cut)} is over the limit`,
      );
    }
  });
});

describe("transcriber", () => {
  const language = "ja" as const;

  it("sends a short recording straight through, untouched", async () => {
    const audio = stubAudio(600);
    const speech = stubSpeech(() => [{ startSec: 0, endSec: 2, text: " こんにちは " }]);

    const lines = await createTranscriber({ audio, speech, maxChunkSeconds: 1200 }).transcribe(
      "/tmp/whole.m4a",
      { language },
    );

    assert.deepEqual(audio.extracted, [], "no chunking work for something under the limit");
    assert.deepEqual(speech.calls, ["/tmp/whole.m4a"], "the original file is sent as-is");
    assert.deepEqual(lines, [{ startSec: 0, endSec: 2, text: "こんにちは" }]);
  });

  it("puts every chunk's timestamps back on one timeline", async () => {
    const audio = stubAudio(2390, [silence(1190, 1200)]);
    const speech = stubSpeech((chunk) => [
      { startSec: 0, endSec: 3, text: `chunk${chunk} first` },
      { startSec: 10, endSec: 13, text: `chunk${chunk} second` },
    ]);

    const lines = await createTranscriber({ audio, speech, maxChunkSeconds: 1200 }).transcribe(
      "/tmp/long.m4a",
      { language },
    );

    assert.equal(audio.extracted.length, 2);
    assert.deepEqual(
      lines.map((line) => [line.startSec, line.endSec]),
      [
        [0, 3],
        [10, 13],
        // Second chunk starts at the midpoint of the silence, 1195.
        [1195, 1198],
        [1205, 1208],
      ],
    );
  });

  it("shifts word timings along with their line", async () => {
    const audio = stubAudio(2400, []);
    const speech = stubSpeech(() => [
      {
        startSec: 5,
        endSec: 8,
        text: "今日は",
        words: [{ text: "今日", startSec: 5, endSec: 6.5 }],
      },
    ]);

    const lines = await createTranscriber({ audio, speech, maxChunkSeconds: 1200 }).transcribe(
      "/tmp/long.m4a",
      { language },
    );

    assert.equal(
      lines[1]?.words?.[0]?.startSec,
      1205,
      "a word must not stay on its chunk's clock",
    );
  });

  it("leaves words off entirely when the endpoint returned none", async () => {
    const audio = stubAudio(60);
    const speech = stubSpeech(() => [{ startSec: 0, endSec: 1, text: "hi", words: [] }]);

    const lines = await createTranscriber({ audio, speech }).transcribe("/tmp/a.m4a", {
      language,
    });

    assert.ok(
      !("words" in (lines[0] ?? {})),
      "an empty array would look like word timing exists",
    );
  });

  it("reports progress per chunk", async () => {
    const audio = stubAudio(3600, []);
    const speech = stubSpeech(() => []);
    const seen: number[] = [];

    await createTranscriber({ audio, speech, maxChunkSeconds: 1200 }).transcribe(
      "/tmp/long.m4a",
      {
        language,
        onProgress: (fraction) => seen.push(fraction),
      },
    );

    assert.deepEqual(seen, [1 / 3, 2 / 3, 1]);
  });
});
