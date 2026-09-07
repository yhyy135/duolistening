// Composition root: reads the environment, builds every adapter once, wires them
// together and listens. The only file that knows which Storage adapter is in play,
// and the only one that touches process.env.

import { existsSync } from "node:fs";
import * as path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { JAPANESE, type Settings } from "../shared/model.ts";
import { createAnnotator } from "./annotator.ts";
import { createApp } from "./app.ts";
import { createFfmpegAudioTool } from "./audio/ffmpeg.ts";
import { createSpeechToText } from "./audio/speech-to-text.ts";
import { createImportJobs } from "./import-jobs.ts";
import { createIngestor } from "./ingest.ts";
import { createJapaneseTokenizerOnce } from "./japanese.ts";
import { createLibrary } from "./library.ts";
import { createSettingsCheck } from "./model-check.ts";
import { createPodcastFeed } from "./podcast-feed.ts";
import type { JapaneseTokenizer, Storage } from "./ports.ts";
import { readSettings } from "./settings.ts";
import { createLocalMediaServer, createLocalStorage } from "./storage/local.ts";
import { createS3Storage } from "./storage/s3.ts";
import { createTextModel, listModels } from "./text-model.ts";
import { createTranscriber } from "./transcriber.ts";

const env = process.env;
const port = Number(env["PORT"] ?? 3000);
const password = env["DUOLISTENING_PASSWORD"] ?? "";
const dataDir = path.resolve(env["DUOLISTENING_DATA_DIR"] ?? "./data");
const bucket = env["DUOLISTENING_S3_BUCKET"];
const webRoot = "./dist/web";

const { storage, serveMedia, where } = buildStorage();

const audio = createFfmpegAudioTool();
const library = createLibrary(storage);
const podcastFeed = createPodcastFeed();
const ingestor = createIngestor({ audio });

// Loaded on the first Japanese import and kept — someone studying Korean never pays
// for the dictionary, and someone studying Japanese pays once.
const japaneseTokenizer = createJapaneseTokenizerOnce();

const textModelFor = (settings: Settings) => createTextModel({ slot: settings.textModel });
const speechToTextFor = (settings: Settings) =>
  createSpeechToText({ slot: settings.transcriptionModel });

const importJobs = createImportJobs({
  library,
  ingestor,
  settings: () => readSettings(storage),
  transcriber: (settings) => createTranscriber({ audio, speech: speechToTextFor(settings) }),
  annotator: async (settings) =>
    createAnnotator({
      textModel: textModelFor(settings),
      ...(settings.targetLanguage === JAPANESE && {
        tokenizer: (await japaneseTokenizer()) as JapaneseTokenizer,
      }),
    }),
});

const app = createApp({
  storage,
  library,
  importJobs,
  podcastFeed,
  textModel: textModelFor,
  checkSettings: createSettingsCheck({
    textModel: textModelFor,
    speechToText: speechToTextFor,
  }),
  listModels,
  password,
  ...(serveMedia && { serveMedia }),
});

if (existsSync(webRoot)) {
  // Vite puts a content hash in every asset filename, so a changed file is a changed
  // URL and these can be cached forever.
  app.use("/assets/*", cacheFor("public, max-age=31536000, immutable"));
  app.use("/assets/*", serveStatic({ root: webRoot }));
  // Everything else is a client-side route, so hand back the shell and let the SPA
  // work out what to show. The shell's URL never changes, so without this a browser
  // caches it heuristically off last-modified and an upgraded install keeps running
  // the previous build's JavaScript against the new API.
  app.get("*", cacheFor("no-cache"), serveStatic({ root: webRoot, path: "index.html" }));
} else {
  console.warn(`No web build at ${webRoot} — API only. Run the frontend build first.`);
}

if (!password) {
  console.warn(
    "DUOLISTENING_PASSWORD is not set: anyone who can reach this port can use your API keys.",
  );
}
console.log(`duolistening listening on http://localhost:${port} (storage: ${where})`);
serve({ fetch: app.fetch, port });

/** Sets cache-control on whatever the handler after it produced. */
function cacheFor(value: string): MiddlewareHandler {
  return async (context, next) => {
    await next();
    context.header("cache-control", value);
  };
}

function buildStorage(): {
  storage: Storage;
  serveMedia?: ReturnType<typeof createLocalMediaServer>;
  where: string;
} {
  if (bucket) {
    return {
      // Region and credentials come from the standard AWS variables; AWS_ENDPOINT_URL
      // points this at MinIO, R2 or B2 without any code change.
      storage: createS3Storage({
        client: new S3Client({}),
        bucket,
        ...(env["DUOLISTENING_S3_PREFIX"] && { keyPrefix: env["DUOLISTENING_S3_PREFIX"] }),
      }),
      // No media route under S3: playback URLs are presigned and the browser fetches
      // the audio straight from the bucket.
      where: `s3://${bucket}`,
    };
  }

  return {
    storage: createLocalStorage({ rootDir: dataDir }),
    serveMedia: createLocalMediaServer(dataDir),
    where: dataDir,
  };
}
