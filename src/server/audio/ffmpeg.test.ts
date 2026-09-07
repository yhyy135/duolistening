// Runs against real ffmpeg. Silence detection and stream-copy extraction are exactly
// the things a stub cannot tell you the truth about — a wrong filter string or a
// misplaced -ss looks fine in a fake and produces silent, shifted audio in production.
//
// Skipped, not failed, when ffmpeg is absent: contributors without it can still run
// the rest of the suite.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import { promisify } from "node:util";
import { createFfmpegAudioTool, parseSilences } from "./ffmpeg.ts";

const run = promisify(execFile);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

describe("silencedetect output parsing", () => {
  it("pairs each start with its end", () => {
    const stderr = [
      "[silencedetect @ 0x7f] silence_start: 2.01288",
      "[silencedetect @ 0x7f] silence_end: 3.00399 | silence_duration: 0.991111",
      "[silencedetect @ 0x7f] silence_start: 7.5",
      "[silencedetect @ 0x7f] silence_end: 8.25 | silence_duration: 0.75",
    ].join("\n");

    assert.deepEqual(parseSilences(stderr), [
      { startSec: 2.01288, endSec: 3.00399 },
      { startSec: 7.5, endSec: 8.25 },
    ]);
  });

  it("drops a silence still open at the end of the file", () => {
    const parsed = parseSilences("silence_start: 9.5\n");
    assert.deepEqual(parsed, [], "a cut there would be at the end of the file anyway");
  });
});

describe("ffmpeg audio tool", { skip: !(await hasFfmpeg()) && "ffmpeg not installed" }, () => {
  const audio = createFfmpegAudioTool();
  let workDir: string;
  let source: string;

  before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-ffmpeg-"));
    source = path.join(workDir, "source.m4a");
    // Five seconds of tone with the third second muted.
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5",
      "-af",
      "volume=enable='between(t,2,3)':volume=0",
      source,
    ]);
  });

  it("reads the duration", async () => {
    assert.ok(Math.abs((await audio.durationSec(source)) - 5) < 0.2);
  });

  it("finds the quiet stretch, and only that one", async () => {
    const silences = await audio.detectSilences(source);

    assert.equal(silences.length, 1);
    assert.ok(Math.abs((silences[0] as { startSec: number }).startSec - 2) < 0.15);
    assert.ok(Math.abs((silences[0] as { endSec: number }).endSec - 3) < 0.15);
  });

  it("extracts a range as a playable file of the right length", async () => {
    const chunk = path.join(workDir, "chunk.m4a");
    await audio.extract(source, 1, 4, chunk);

    assert.ok((await fs.stat(chunk)).size > 0);
    assert.ok(
      Math.abs((await audio.durationSec(chunk)) - 3) < 0.25,
      "a chunk that is not the requested length means every timestamp after it is wrong",
    );
  });

  it("extracts from the position asked for, not from the start", async () => {
    // Take the second containing the muted stretch: it should be silent throughout.
    const chunk = path.join(workDir, "muted.m4a");
    await audio.extract(source, 2.1, 2.9, chunk);

    const silences = await audio.detectSilences(chunk);
    assert.equal(
      silences.length,
      1,
      "cutting from the wrong offset would give audible tone here",
    );
  });

  it("extracts from an mp3 source into a playable .m4a chunk", async () => {
    // Most podcast enclosures are mp3. A stream copy into the .m4a/MP4 container
    // this always writes rejects that codec outright — this only passes with a
    // real re-encode.
    const mp3Source = path.join(workDir, "source.mp3");
    await run("ffmpeg", ["-y", "-i", source, mp3Source]);

    const chunk = path.join(workDir, "from-mp3.m4a");
    await audio.extract(mp3Source, 1, 4, chunk);

    assert.ok(
      Math.abs((await audio.durationSec(chunk)) - 3) < 0.25,
      "the mp3-sourced chunk should extract to the requested length",
    );
  });
});
