import assert from "node:assert/strict";
import { test } from "node:test";
import { audioType, typedAudio } from "./store.ts";

/**
 * Only the pure half is covered here. Everything above it is IndexedDB, which does
 * not exist in Node and which a fake would only tell us what we told it — that half
 * is driven in a real browser instead, the same bargain `audio/ffmpeg.test.ts` makes
 * about ffmpeg.
 *
 * The byte prefixes below are the ones actually observed in the three episodes in
 * the local Library, which is where the bug this guards came from.
 */

const head = (...bytes: number[]) => new Uint8Array([...bytes, ...Array(12 - bytes.length).fill(0)]);
const ascii = (text: string, pad = 0) =>
  head(...Array(pad).fill(0), ...[...text].map((c) => c.charCodeAt(0)));

// Real first bytes: an MP3 opening on a bare frame sync, and one behind an ID3v2 tag.
const BARE_MPEG = head(0xff, 0xfb, 0xc0, 0x64);
const ID3_MPEG = head(0x49, 0x44, 0x33, 0x03);

test("the bytes beat the declaration, which is the entire point", () => {
  // A real server answered exactly this for files that were MPEG throughout, because
  // the pipeline had named them .m4a. Believing it is what broke Safari.
  assert.equal(audioType("audio/mp4a-latm", BARE_MPEG), "audio/mpeg");
  assert.equal(audioType("audio/mp4a-latm", ID3_MPEG), "audio/mpeg");
  assert.equal(audioType("audio/mp4", BARE_MPEG), "audio/mpeg");
});

test("an ID3 tag and a bare frame sync are both MPEG", () => {
  // The difference between these two decided whether an episode played in Safari,
  // because WebKit will override a wrong label for ID3 and not for a bare frame.
  assert.equal(audioType(null, ID3_MPEG), "audio/mpeg");
  assert.equal(audioType(null, BARE_MPEG), "audio/mpeg");
  // Frame sync is eleven set bits, so the second byte varies above 0xe0.
  assert.equal(audioType(null, head(0xff, 0xf3, 0x48, 0xc4)), "audio/mpeg");
  assert.equal(audioType(null, head(0xff, 0xe0)), "audio/mpeg");
});

test("the other containers a podcast turns up in", () => {
  assert.equal(audioType(null, ascii("ftyp", 4)), "audio/mp4");
  assert.equal(audioType(null, ascii("OggS")), "audio/ogg");
  assert.equal(audioType(null, ascii("fLaC")), "audio/flac");
  const wav = head(...[..."RIFF"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."WAVE"].map((c) => c.charCodeAt(0)));
  assert.equal(audioType(null, wav), "audio/wav");
});

test("RIFF alone is not a WAV", () => {
  const webp = head(...[..."RIFF"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."WEBP"].map((c) => c.charCodeAt(0)));
  assert.equal(audioType("image/webp", webp), "image/webp");
});

test("an unrecognised format falls back to what the server said", () => {
  const unknown = head(0x01, 0x02, 0x03, 0x04);
  assert.equal(audioType("audio/aac", unknown), "audio/aac");
  assert.equal(audioType("audio/AAC; charset=binary", unknown), "audio/aac");
});

test("a server that said nothing useful leaves the type empty, never a guess", () => {
  const unknown = head(0x01, 0x02, 0x03, 0x04);
  for (const declared of [null, undefined, "", "application/octet-stream", "binary/octet-stream"]) {
    assert.equal(audioType(declared, unknown), "", `${declared} should not become a type`);
  }
});

test("typedAudio relabels a Blob whose type is wrong", async () => {
  const mp3 = new Blob([BARE_MPEG], { type: "audio/mp4a-latm" });
  const fixed = await typedAudio(mp3);

  assert.equal(fixed.type, "audio/mpeg");
  assert.equal(fixed.size, mp3.size);
  assert.deepEqual(new Uint8Array(await fixed.arrayBuffer()), BARE_MPEG);
});

test("typedAudio prefers a passed-in header over the Blob's own type", async () => {
  // fetch().blob() takes its type from the response header, but a caller reading
  // Content-Type itself should be able to hand it over without a second round trip.
  const blob = new Blob([ID3_MPEG]);
  assert.equal((await typedAudio(blob, "audio/mp4a-latm")).type, "audio/mpeg");
});

test("typedAudio leaves an already-correct Blob alone", async () => {
  const mp3 = new Blob([ID3_MPEG], { type: "audio/mpeg" });
  assert.equal(await typedAudio(mp3), mp3, "no copy of a 41MB Blob for nothing");
});
