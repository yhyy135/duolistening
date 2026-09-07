import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { quietTone } from "../src/web/model-check.ts";

/**
 * Puts everything that has to be served from this app's own origin into Vite's
 * `public/`, from where it ships to `dist/web` untouched. Both things here need that
 * origin specifically, for different reasons.
 *
 * Run by `prebuild` and `predev:web`; the output is gitignored, because a repo full
 * of binaries nobody can review is the thing generating them avoids.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const publicDir = path.join(root, "src", "web", "public");

/**
 * The clip the Settings check hands a transcription provider to fetch, proving it
 * understands the `url` parameter every import depends on. The provider fetches it,
 * so it has to be somewhere the provider can reach.
 */
await mkdir(publicDir, { recursive: true });
await writeFile(path.join(publicDir, "probe.wav"), quietTone());

/**
 * kuromoji's dictionary. Same-origin by necessity rather than preference: the loader
 * joins each filename on with `path.join`, which collapses `https://host/dict` into
 * `https:/host/dict` and fetches nothing, so a CDN is out without patching kuromoji.
 *
 * Copied rather than committed — 17MB of gzipped binaries — and downloaded by nobody
 * until a Transcript turns out to have kana in it.
 */
const dictFrom = path.join(root, "node_modules", "kuromoji", "dict");
const dictTo = path.join(publicDir, "kuromoji", "dict");
await cp(dictFrom, dictTo, { recursive: true });

/**
 * kuromoji's prebuilt UMD bundle, served beside its dictionary and loaded as a
 * classic script rather than imported.
 *
 * That is not a preference either. Its gunzip dependency ends in `}).call(this)` and
 * keeps the result as its global — which is `window` in a classic script and
 * `undefined` in an ES module, where the bundle then dies on
 * `Cannot use 'in' operator to search for 'Zlib' in undefined`. A script tag is the
 * one loader that still gives that file the `this` it was written for.
 */
await cp(
  path.join(root, "node_modules", "kuromoji", "build", "kuromoji.js"),
  path.join(publicDir, "kuromoji", "kuromoji.js"),
);

const files = await readdir(dictTo);
console.log(
  `wrote probe.wav, kuromoji.js and ${files.length} dictionary files into src/web/public`,
);
