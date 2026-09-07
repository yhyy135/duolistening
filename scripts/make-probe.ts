import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { quietTone } from "../src/web/model-check.ts";

/**
 * Writes the clip the Settings check hands a transcription provider to fetch.
 *
 * Generated at build time rather than committed, because the alternative is a binary
 * blob in the repo that nobody can review — while the generator beside it is ordinary
 * code with tests. It lands in Vite's `public/`, so it ships to `dist/web` untouched
 * and is served from the app's own origin at `/probe.wav`, which is what the provider
 * has to be able to reach.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "src", "web", "public", "probe.wav");

await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, quietTone());
console.log(`wrote ${path.relative(path.join(here, ".."), target)}`);
