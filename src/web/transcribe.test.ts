import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUEST_LIMIT_BYTES,
  fitsWhole,
  keptSegments,
  planFirst,
  planNext,
  stitch,
  transcribe,
  type ChunkResult,
  type RawSegment,
} from "./transcribe.ts";

/**
 * The numbers are the 26-minute episode measured while testing the proxy:
 * 43,421,257 bytes at 224kbps, which is 28,000 bytes a second and 1550.76 seconds.
 */
const TOTAL = 43_421_257;
const RATE = 28_000;
const DURATION = TOTAL / RATE;

/**
 * Stands in for the stored audio. The planner reads only `.size`, and the fake
 * endpoint below reads only `.size` — so allocating tens of megabytes of zeros per
 * test would buy nothing but a slower suite.
 */
const sized = (bytes: number) => ({ size: bytes }) as Blob;

/**
 * A stand-in endpoint that actually behaves like one: it reports the duration the
 * byte range really represents, and cuts segments on its own boundaries rather than
 * on the chunk's — which is the whole reason a seam has to be discovered instead of
 * calculated. A fake that returned tidy segments aligned to the chunk edge would
 * pass against arithmetic that is wrong.
 */
function endpoint(bytesPerSecond = RATE, segmentSec = 10) {
  const asked: { startByte: number; endByte: number }[] = [];
  const uploaded: Blob[] = [];

  const answer = (startByte: number, endByte: number) => {
    const durationSec = (endByte - startByte + 1) / bytesPerSecond;
    const segments: RawSegment[] = [];
    // Deliberately offset, so no segment boundary lands on the chunk edge.
    for (let at = 0; at < durationSec; at += segmentSec) {
      segments.push({
        startSec: at,
        endSec: Math.min(at + segmentSec, durationSec),
        text: `${(startByte + at * bytesPerSecond).toFixed(0)}`,
      });
    }
    return { durationSec, segments };
  };

  return {
    asked,
    uploaded,
    async transcribeBlob(blob: Blob) {
      uploaded.push(blob);
      asked.push({ startByte: 0, endByte: blob.size - 1 });
      return answer(0, blob.size - 1);
    },
    async transcribeUrl(url: string) {
      const [, start, end] = /(\d+)-(\d+)$/.exec(url)?.map(Number) ?? [];
      const startByte = start ?? 0;
      const endByte = end ?? TOTAL - 1;
      asked.push({ startByte, endByte });
      return answer(startByte, endByte);
    },
  };
}

const sliceUrl = (range?: { startByte: number; endByte: number }) =>
  range ? `https://proxy/?range=${range.startByte}-${range.endByte}` : "https://proxy/?whole";

const result = (over: Partial<ChunkResult> = {}): ChunkResult => ({
  chunk: { startByte: 0, endByte: REQUEST_LIMIT_BYTES - 1, startSec: 0 },
  durationSec: REQUEST_LIMIT_BYTES / RATE,
  segments: [
    { startSec: 0, endSec: 300, text: "one" },
    { startSec: 300, endSec: 900, text: "two" },
    { startSec: 900, endSec: 936.2, text: "cut in half" },
  ],
  ...over,
});

test("an episode under the limit is uploaded whole, not fetched by URL", async () => {
  const small = 5_056_814;
  const fake = endpoint();
  const audio = sized(small);
  assert.equal(fitsWhole(small), true);

  const lines = await transcribe({ ...fake, sliceUrl, audio });

  // The bytes that were kept are the bytes that were transcribed. Letting the
  // endpoint fetch for itself does not promise that: one real episode came back as
  // 412.5 seconds here and 449.8 there, both through the proxy, because the host
  // varies its advertising by region and a Worker runs at the caller's edge.
  assert.deepEqual(fake.uploaded, [audio]);
  assert.deepEqual(fake.asked, [{ startByte: 0, endByte: small - 1 }]);
  assert.ok(lines.length > 0);
  assert.equal(lines[0]?.startSec, 0);
});

test("the size comes from the Blob, so nothing probes the origin for one", async () => {
  // A separate probe could answer for a different version of the file than the one
  // in hand — which is the same mismatch in a smaller disguise.
  const fake = endpoint();
  await transcribe({ ...fake, sliceUrl, audio: sized(REQUEST_LIMIT_BYTES) });
  assert.deepEqual(fake.asked, [{ startByte: 0, endByte: REQUEST_LIMIT_BYTES - 1 }]);
});

test("the seam is the last complete segment, not the chunk edge", () => {
  const next = planNext(result(), TOTAL);

  // The third segment was cut mid-sentence, so the seam is where the second ended.
  assert.equal(next?.startSec, 900);
  assert.equal(next?.startByte, 900 * RATE);
});

test("a chunk with nothing to drop falls back to its own end", () => {
  const single = result({ segments: [{ startSec: 0, endSec: 500, text: "only" }] });
  const next = planNext(single, TOTAL);
  assert.equal(next?.startSec, single.durationSec);
});

test("planNext stops once the seam reaches the end of the file", () => {
  const last = result({
    chunk: { startByte: TOTAL - 1_000_000, endByte: TOTAL - 1, startSec: 1500 },
    durationSec: 1_000_000 / RATE,
    segments: [
      { startSec: 0, endSec: 20, text: "a" },
      { startSec: 20, endSec: 35.7, text: "b" },
    ],
  });
  assert.equal(planNext(last, TOTAL), null);
});

test("a short remainder is halved rather than left as its own tiny chunk", () => {
  // 1.2x the limit left: splitting gives two sane chunks instead of one full and one
  // stub, and an ASR will hallucinate onto a stub.
  const total = REQUEST_LIMIT_BYTES * 2.2;
  const next = planNext(result(), total);

  assert.ok(next);
  const length = next.endByte - next.startByte + 1;
  const remaining = total - next.startByte;
  assert.ok(length < REQUEST_LIMIT_BYTES, "did not take a full chunk");
  assert.ok(Math.abs(length - remaining / 2) <= 1, "took half of what was left");
});

test("the truncated segment is dropped from every chunk but the last", () => {
  const done = result();
  assert.deepEqual(
    keptSegments(done, false).map((s) => s.text),
    ["one", "two"],
  );
  assert.deepEqual(
    keptSegments(done, true).map((s) => s.text),
    ["one", "two", "cut in half"],
  );
});

test("stitching puts every chunk back on one timeline, words included", () => {
  const lines = stitch([
    {
      chunk: { startByte: 0, endByte: 99, startSec: 0 },
      durationSec: 30,
      segments: [
        {
          startSec: 0,
          endSec: 10,
          text: " a ",
          words: [{ text: "a", startSec: 1, endSec: 2 }],
        },
        { startSec: 10, endSec: 20, text: "b" },
        { startSec: 20, endSec: 30, text: "dropped" },
      ],
    },
    {
      chunk: { startByte: 100, endByte: 199, startSec: 20 },
      durationSec: 30,
      segments: [{ startSec: 0, endSec: 10, text: "c" }],
    },
  ]);

  assert.deepEqual(
    lines.map((l) => [l.text, l.startSec, l.endSec]),
    [
      ["a", 0, 10],
      ["b", 10, 20],
      ["c", 20, 30],
    ],
  );
  assert.deepEqual(lines[0]?.words, [{ text: "a", startSec: 1, endSec: 2 }]);
  // Absent, never empty — the player reads that to choose word- or line-level highlight.
  assert.equal("words" in lines[1]!, false);
});

test("a full episode comes back as one continuous timeline with no gap at the seams", async () => {
  const fake = endpoint();
  const lines = await transcribe({ ...fake, sliceUrl, audio: sized(TOTAL) });

  assert.ok(fake.asked.length > 1, "needed more than one chunk");
  assert.equal(fake.asked[0]?.startByte, 0);
  assert.equal(
    fake.asked.at(-1)?.endByte,
    TOTAL - 1,
    "the last chunk reaches the end of the file",
  );
  // Exactly one, or the tail was fetched and billed twice — which still stitches into
  // a continuous timeline, so continuity alone would not notice.
  assert.equal(fake.asked.filter((a) => a.endByte === TOTAL - 1).length, 1);

  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    const previous = lines[index - 1]!;
    assert.ok(line.startSec >= previous.startSec, `line ${index} goes backwards`);
    assert.ok(
      Math.abs(line.startSec - previous.endSec) < 0.01,
      `gap or overlap at line ${index}: ${previous.endSec} → ${line.startSec}`,
    );
  }
  assert.ok(Math.abs((lines.at(-1)?.endSec ?? 0) - DURATION) < 1, "covers the whole episode");
});

test("a variable bitrate file self-corrects instead of drifting", async () => {
  // The planner's rate comes from the chunk it just saw. Here the endpoint runs at a
  // different rate than the first chunk implied, which is what VBR does — each chunk's
  // own reported duration has to re-anchor the next, or error compounds down the file.
  const fake = endpoint(RATE * 0.8);
  const lines = await transcribe({ ...fake, sliceUrl, audio: sized(TOTAL) });

  assert.equal(fake.asked.at(-1)?.endByte, TOTAL - 1);
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    assert.ok(
      Math.abs(line.startSec - lines[index - 1]!.endSec) < 0.01,
      `drifted apart at line ${index}`,
    );
  }
});

test("progress only ever moves forward and finishes at one", async () => {
  const seen: number[] = [];
  await transcribe({
    ...endpoint(),
    sliceUrl,
    audio: sized(TOTAL),
    onProgress: (p) => seen.push(p),
  });

  assert.ok(seen.length > 1);
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => a - b),
    "went backwards",
  );
  assert.equal(seen.at(-1), 1);
});

test("planFirst never asks for more than the file holds", () => {
  assert.equal(planFirst(1000, REQUEST_LIMIT_BYTES).endByte, 999);
  assert.equal(planFirst(TOTAL).endByte, REQUEST_LIMIT_BYTES - 1);
});
