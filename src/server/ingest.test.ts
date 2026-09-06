import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { SourceRef } from "../shared/model.ts";
import { createIngestor, type IngestError, parseInfoJson } from "./ingest.ts";
import type { AudioTool } from "./ports.ts";

const audio: AudioTool = {
  durationSec: async () => 1555,
  detectSilences: async () => [],
  extract: async () => undefined,
};

describe("yt-dlp metadata parsing", () => {
  it("picks the info object out of surrounding output", () => {
    const stdout = [
      "[youtube] Extracting URL",
      '{"title":"episode405","duration":1555}',
      "",
    ].join("\n");

    assert.deepEqual(parseInfoJson(stdout), { title: "episode405", durationSec: 1555 });
  });

  it("shrugs off output with no JSON in it", () => {
    assert.deepEqual(parseInfoJson("[download] 100%"), {});
  });
});

describe("ingestor", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "duolistening-ingest-"));
  });

  describe("youtube", () => {
    /** Stands in for yt-dlp: records the arguments and drops a file where it would. */
    function stubYtDlp(stdout: string, fileName = "audio.m4a") {
      const calls: string[][] = [];
      const run = async (_file: string, args: string[]) => {
        calls.push(args);
        await fs.writeFile(path.join(workDir, fileName), "pretend audio");
        return { stdout, stderr: "" };
      };
      return Object.assign(run, { calls });
    }

    it("downloads one video and reports what it got", async () => {
      const run = stubYtDlp('{"title":"episode405「自己紹介」","duration":1555}');

      const media = await createIngestor({ audio, run }).ingest(
        { kind: "youtube", url: "https://youtu.be/abc" },
        workDir,
      );

      assert.equal(media.title, "episode405「自己紹介」");
      assert.equal(media.durationSec, 1555);
      assert.equal(media.audioPath, path.join(workDir, "audio.m4a"));
    });

    it("refuses to follow a playlist, however the link is written", async () => {
      const run = stubYtDlp("{}");
      await createIngestor({ audio, run }).ingest(
        { kind: "youtube", url: "https://youtube.com/watch?v=abc&list=PL123" },
        workDir,
      );

      assert.ok(
        run.calls[0]?.includes("--no-playlist"),
        "a link carrying list= must still import exactly one video",
      );
    });

    it("finds the audio whatever extension yt-dlp settled on", async () => {
      const run = stubYtDlp("{}", "audio.opus");
      const media = await createIngestor({ audio, run }).ingest(
        { kind: "youtube", url: "https://youtu.be/abc" },
        workDir,
      );

      assert.equal(media.audioPath, path.join(workDir, "audio.opus"));
    });

    it("measures the file itself when yt-dlp reports no duration", async () => {
      const run = stubYtDlp('{"title":"no duration here"}');
      const media = await createIngestor({ audio, run }).ingest(
        { kind: "youtube", url: "https://youtu.be/abc" },
        workDir,
      );

      assert.equal(media.durationSec, 1555, "fell back to probing the downloaded file");
    });

    it("says why it failed, in terms worth showing someone", async () => {
      const cases: [string, string][] = [
        [
          "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
          "unavailable",
        ],
        ["ERROR: [youtube] abc: Video unavailable", "unavailable"],
        ["ERROR: The uploader has not made this video available in your country", "blocked"],
        ["ERROR: Sign in to confirm your age. This video may be inappropriate", "blocked"],
        // "webpage" contains "age" — matching on bare words called this a block.
        ["ERROR: unable to download webpage: timed out", "network"],
        ["ERROR: [youtube] abc: This video has been removed by the uploader", "unavailable"],
      ];

      for (const [stderr, expected] of cases) {
        const run = async () => {
          throw Object.assign(new Error("Command failed"), { stderr });
        };
        await assert.rejects(
          createIngestor({ audio, run }).ingest(
            { kind: "youtube", url: "https://youtu.be/abc" },
            workDir,
          ),
          (error: IngestError) => {
            assert.equal(error.reason, expected, stderr);
            return true;
          },
        );
      }
    });

    it("names the real problem when yt-dlp is not installed", async () => {
      const run = async () => {
        throw Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
      };

      await assert.rejects(
        createIngestor({ audio, run }).ingest(
          { kind: "youtube", url: "https://youtu.be/abc" },
          workDir,
        ),
        (error: IngestError) => {
          assert.equal(error.reason, "tool_missing");
          assert.match(error.message, /not installed|PATH/i);
          return true;
        },
      );
    });
  });

  describe("podcast", () => {
    const episode: SourceRef = {
      kind: "podcast",
      feedUrl: "https://example.com/feed.xml",
      episodeUrl: "https://cdn.example.com/episodes/405.mp3",
      title: "episode405「自己紹介」",
    };

    const serving = (body: string, init?: ResponseInit) =>
      (async () => new Response(body, init)) as unknown as typeof globalThis.fetch;

    it("downloads the enclosure and keeps the episode's own title", async () => {
      const media = await createIngestor({ audio, fetch: serving("pretend audio") }).ingest(
        episode,
        workDir,
      );

      assert.equal(media.title, "episode405「自己紹介」");
      assert.equal(media.durationSec, 1555, "duration comes from probing the file");
      assert.equal(await fs.readFile(media.audioPath, "utf8"), "pretend audio");
      assert.equal(path.extname(media.audioPath), ".mp3");
    });

    it("reports download progress when the server declares a size", async () => {
      // A real CDN sends content-length, and that is what switches the progress tap
      // on — so until this test existed, nothing exercised the tap at all. It matters
      // that the fake is a real Response: its body is a web ReadableStream, which is
      // exactly what Node's fetch returns and what the tap has to cope with.
      const bytes = "pretend audio";
      const seen: number[] = [];

      const media = await createIngestor({
        audio,
        fetch: serving(bytes, { headers: { "content-length": String(bytes.length) } }),
      }).ingest(episode, workDir, (fraction) => seen.push(fraction));

      assert.ok(seen.length > 0, "progress was reported");
      assert.equal(seen.at(-1), 1, "progress reaches 1 when the whole body arrives");
      assert.equal(
        await fs.readFile(media.audioPath, "utf8"),
        bytes,
        "watching the bytes go past must not consume them",
      );
    });

    it("does not trust a URL to name a sensible file", async () => {
      const media = await createIngestor({ audio, fetch: serving("audio") }).ingest(
        { ...episode, episodeUrl: "https://cdn.example.com/stream?id=405" },
        workDir,
      );

      assert.equal(path.extname(media.audioPath), ".mp3", "falls back to a sane default");
    });

    it("reports a missing episode as unavailable, not as a network glitch", async () => {
      await assert.rejects(
        createIngestor({ audio, fetch: serving("gone", { status: 404 }) }).ingest(
          episode,
          workDir,
        ),
        (error: IngestError) => {
          assert.equal(error.reason, "unavailable");
          return true;
        },
      );
    });

    it("reports an unreachable host as a network failure", async () => {
      const fetch = (async () => {
        throw new TypeError("getaddrinfo ENOTFOUND");
      }) as unknown as typeof globalThis.fetch;

      await assert.rejects(
        createIngestor({ audio, fetch }).ingest(episode, workDir),
        (error: IngestError) => {
          assert.equal(error.reason, "network");
          return true;
        },
      );
    });
  });
});
