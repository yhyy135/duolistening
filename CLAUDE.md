# duolistening

A listening-practice tool. Import a podcast episode, transcribe it with your own LLM keys, and study it through a lyrics-style transcript: the current line scrolls into view and highlights as it plays, your native-language translation sits under each line, and Japanese gets furigana and part-of-speech colouring.

Read [CONTEXT.md](CONTEXT.md) for the domain vocabulary (**Resource**, **Transcript**, **Line**, **Word**, **Token**, **Library**) and use those words. Read [docs/adr/](docs/adr/) for why the architecture is shaped the way it is — eleven decisions, one paragraph each. 0008–0011 are the recent ones; they supersede 0001, 0003 and 0007 outright, and 0011 supersedes the part of 0005 that says when Tokens are computed.

**Everything lives in the reader's browser.** No server, no accounts, no database, no `data/` directory. Settings — API keys included — the shelf, Transcripts and audio blobs are all in IndexedDB, which is what lets several people share one deployment while each pays for their own transcription (ADR 0008). The only thing deployed beside the static page is a Cloudflare Worker that proxies bytes (ADR 0009).

## Commands

```bash
npm test          # node:test, no framework
npm run typecheck # tsc --noEmit
npm run format    # prettier
npm run build     # assets + vite → dist/web
npm run dev:web   # assets + vite on :5173
```

`assets` runs automatically before both `build` and `dev:web`. It writes the two things that must be served from the app's own origin: the Settings check's probe clip, and kuromoji's dictionary and bundle. Its output is gitignored.

There are no external binaries. ffmpeg and yt-dlp went with the server.

**Deploying** is two independent halves that know nothing about each other: `dist/web` on any static host, and `worker/` on Cloudflare. A reader points the page at a proxy from the Settings screen, so the page carries no configuration at all.

**One deployment requirement**: whatever serves `dist/web` must not send `Content-Encoding: gzip` for `/kuromoji/dict/*`. Those files are gzip _content_ which kuromoji gunzips itself, not a transfer encoding — see the invariant below, which cost an hour.

Node 22.18+ (unflagged type stripping).

## How the code is laid out

```
src/shared/  the model and the pure logic — model.ts, locate.ts, i18n.ts
src/web/     everything else: the pipeline and the four screens
worker/      the byte proxy, deployed separately
scripts/     what has to be generated into src/web/public before a build
docs/adr/    why things are the way they are
```

There is no `ports.ts` any more. It existed to hold the seams a server needed; with one implementation of everything, each module declares the narrow shape it actually depends on — the Annotator asks for `completeJson`, not for a whole TextModel.

| Module              | What it hides                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `store.ts`          | All persistence — IndexedDB, and the audio content-type correction on the way in                                           |
| `backup.ts`         | The export document, and validating one someone hands back                                                                 |
| `pipeline.ts`       | The composition root: the only file that knows how the pieces fit together                                                 |
| `import.ts`         | ingest → transcribe, and the retry that resumes one                                                                        |
| `transcribe.ts`     | **The deepest module.** Byte-range chunking, ASR-placed seams, stitching                                                   |
| `speech-to-text.ts` | One `/audio/transcriptions` call in `url` mode, and word-list-to-segment assignment                                        |
| `text-model.ts`     | `/chat/completions` — plain, JSON-repaired, or streamed — plus `listModels`                                                |
| `annotate.ts`       | Batched translation, Japanese Tokens, and which window to translate next                                                   |
| `japanese.ts`       | kuromoji: loading it, morphemes, part-of-speech mapping, katakana→hiragana                                                 |
| `proxy.ts`          | Every URL the Worker understands, an episode's size, and the proxy's own check                                             |
| `podcast-feed.ts`   | RSS fetching (through the proxy) and parsing                                                                               |
| `model-check.ts`    | Trying both slots for real, so a typo surfaces in Settings and not mid-import                                              |
| `app.tsx`           | The hash route, the header, the theme, the Native Language context                                                         |
| `library.tsx`       | The shelf, the paste-a-link box, live import progress, and export/import                                                   |
| `player.tsx`        | The lyrics view: rAF sweep, follow-mode scroll, speed, line loop, ask-AI, and the translation window that follows playback |
| `settings.tsx`      | Two model slots, the proxy, the language pair, and the connection checks                                                   |
| `shared/i18n.ts`    | Every user-facing string, in all eight languages — including the ask-AI prompt                                             |
| `web/i18n.ts`       | Which of them is in force: the Native Language, held in a context                                                          |
| `worker/index.ts`   | Following a redirect, adding CORS, and serving a byte range as a whole file                                                |

## Invariants that are easy to break

Every one of these was a real bug. If you change the code near one, keep the test that guards it.

- **Audio is stored with its true content type, never an assumed one.** These files are MP3 — podcast enclosures nearly always are — while a pipeline naming them `.m4a` will tell `<audio>` they are AAC-in-MP4. Chrome sniffs content and hides it completely; Safari believes the label and refuses with `MEDIA_ERR_SRC_NOT_SUPPORTED`, except where an `ID3` header is magic enough to override it, so whether an episode plays comes down to coincidence. The magic bytes therefore beat the declaration, at one choke point. (`store.ts`)
- **Whatever serves the kuromoji dictionary must not claim `Content-Encoding: gzip`.** The browser would decode it first, and kuromoji's unguarded gunzip then throws inside an XHR `onload` handler — where the exception eats the callback and the tokenizer hangs with no error anywhere. (`vite.config.ts` for dev; a deployment requirement in production)
- **kuromoji is loaded as a classic script, not imported.** Its gunzip dependency ends in `}).call(this)` and keeps the result as its global, which is `window` in a classic script and `undefined` in an ES module. (`japanese.ts`)
- **A retry resumes; it never restarts.** A stored Transcript means there is nothing left to do; stored audio means skip the download. Restarting would pay the transcription bill again to recover from a failed download, making the cheapest failure the most expensive. (`import.ts`)
- **Audio is captured during the import, not streamed at playback.** One real host splices advertising per fetch — the same episode came back thirty seconds longer to a different client — so audio pulled next week would sit a whole ad break away from the timestamps made from it today. That is also why every byte goes through the proxy, which pins one User-Agent: a byte offset means nothing across two versions of a file. (`import.ts`, `worker/index.ts`)
- **The last position is parked in `localStorage`, not written to IndexedDB, when the page is closing.** A transaction opened at `pagehide` is not reliably committed, and there is no beacon for IndexedDB. `localStorage` is synchronous, which is the feature here. The store folds it back in on the next read — from both `getResource` and `listResources`, because a deep link to the player never touches the shelf. (`store.ts`, `player.tsx`)
- **A chunk that reached the end of the file is the last one.** Otherwise the seam rule drops its final segment as truncated and plans another chunk to re-transcribe the tail — paying twice and stitching the same words in again. Continuity checks do not notice, because the duplicate still lands on a consistent timeline. (`transcribe.ts`)
- **Both timestamp granularities are requested.** Asking for `word` alone comes back with `segments: null`, and segments are what place the seam between chunks. (`speech-to-text.ts`)
- **A transcription reply without a duration is refused.** That number is the byte-rate denominator the next chunk's seam is derived from; guessing it seams in the wrong place, silently. (`speech-to-text.ts`)
- **`words` is omitted, never `[]`.** An empty array reads as "word timing exists" and the player renders karaoke highlighting against nothing. (`transcribe.ts`, ADR 0004)
- **Translations are matched back by index, never by position.** A model that drops or reorders one entry would otherwise shift every later translation onto the wrong Line — invisible in the UI, wrong everywhere. (`annotate.ts`)
- **A translation block is marked asked before the request goes out, not after it comes back.** The player re-checks the window on every render, so a window whose request failed — or whose reply skipped a Line — would otherwise be sent again immediately, forever. A reload is what retries one. (`player.tsx`, ADR 0011)
- **Whether an episode is Japanese is decided over the whole Transcript, never over the window being translated.** The studied language is usually unset and the answer then comes from kana in the text; a window that happens to contain none is not evidence, and Tokens appearing on some blocks and not their neighbours is the bug that follows. (`annotate.ts`, `player.tsx`)
- **A landed translation is written with `saveTranscript`, not `save`.** `save` also writes the Resource row, and the only Resource the player holds is the one it read when the screen opened — which would put back the `lastPositionSec` that has been written under it since. The two writers are live at the same time now that translation happens during playback. (`store.ts`)
- **No secret leaves in an export.** `forExport` blanks them, and `backup.test.ts` sweeps the exported object for the values rather than checking three field names — because naming fields is exactly what failed when `proxy.key` joined Settings. (`backup.ts`)
- **An import only ever adds.** A colliding id means the same Resource, and the copy already here may hold a playback position the file does not. (`backup.ts`)
- **The connection check calls the endpoint the pipeline calls, in the mode it calls it.** A cheaper probe passes for a model that does not exist; an upload-only probe passes for a provider that cannot fetch a `url`, which is how every import moves audio. The transcription slot gets a real generated clip, and it is a quiet tone rather than digital silence because some endpoints reject an all-zero file as "no audio". (`model-check.ts`)
- **Furigana comes from kuromoji's `reading`, not `pronunciation`.** `pronunciation` writes long vowels as ー (ショーカイ); furigana is written しょうかい. (`japanese.ts`)
- **`Word` and `Token` are different things.** Word = audio timing from the ASR. Token = morphology from kuromoji. Japanese has no spaces, so their boundaries genuinely disagree; never merge the two arrays. Reconciling them for display is `tokenWords`' job, at render time (ADR 0005).
- **Tokens are swept by Word, never merged with them.** `tokenWords` matches both back onto `line.text` by character offset, so a Word covering three Tokens lights all three at once. (`shared/locate.ts`)
- **The studied language is optional; the native language never is.** Unset means the transcription call omits `language` and the translation prompt names no source language — both providers detect it — so one shelf can hold Japanese, Spanish and English episodes. Japanese Tokens are then decided by the transcript's own text (kana), which is why the Annotator takes the tokenizer as a thunk: only the Transcript knows whether that dictionary is worth loading. (`annotate.ts`)
- **kuromoji is behind a dynamic load and a thunk, and both halves matter.** A value import puts it in the main bundle for every reader; a static thunk downloads the dictionary for someone studying Spanish. The type it needs comes through an `import type`, which is erased before a bundler sees it. (`japanese.ts`, `pipeline.ts`)
- **The interface language _is_ the Native Language.** One setting, not two. It is cached in `localStorage` because Settings live in IndexedDB, which cannot be read before a first paint, and a shell that flashed English on every load is what someone who set their language is trying to avoid. The ask-AI prompt comes from the same table, asked in the native language, which is what makes the answer come back in it without a sentence instructing the model to. (`web/i18n.ts`, `player.tsx`)
- **`completeStream` never retries.** `complete` and `completeJson` retry a rate limit or a server error; streaming does not, because a retry after part of an answer has reached the ask-AI popup would show a second answer under the first. (`text-model.ts`)
- **The playback rate rides on `timeupdate`; only the highlight rides on `requestAnimationFrame`.** A hidden tab suspends rAF entirely while `<audio>` keeps playing — measured, not assumed: 0 frames in 5 seconds with playback advancing normally. Reading `audioRef` at save time is not the fix either: React detaches the ref before the unmount cleanup runs, which is what the `seconds` ref exists for. (`player.tsx`)
- **Playback is sampled with `requestAnimationFrame`, not `timeupdate`.** `timeupdate` fires about four times a second — visibly late for word-level highlight. The cost is contained by only setting state when `locate` returns a different Line or Word. (`player.tsx`)
- **Every colour is one `light-dark()` token, and no rule below the palette names a colour.** A hardcoded hex renders one screen wrong in one theme, for the half of users on the other one, which is the bug nobody reports. Cost: Chrome 123 / Safari 17.5 / Firefox 120, and on anything older every colour is invalid at once — a loud failure, not a subtle one.
- **The manual theme override is the `data-theme` attribute, and "auto" is its absence.** `index.html` applies the stored choice in a blocking script before first paint; React's effect runs after it, and a dark flash on every load is exactly what someone who chose light is trying to avoid. (`app.tsx`, `styles.css`)
- **A faded Word is faded differently per theme.** `--pending` is the one token that is not a colour, so `light-dark()` cannot hold it and it states both themes the long way.
- **The proxy's key is its only gate, and it is a real secret because the page does not carry it.** An origin allowlist beside it would refuse nobody the key does not already refuse — `curl` omits `Origin` — while locking out a reader hosting the page themselves. (`worker/index.ts`, ADR 0009)
- **No TypeScript syntax that emits code.** Node runs these files by stripping types, so parameter properties, enums and namespaces break at runtime. `erasableSyntaxOnly` in tsconfig rejects them at typecheck.

## Testing conventions

- `node --test` with `node:assert`. No test framework, and don't add one.
- Test through a module's interface, not past it. Fakes are plain object literals or an injected `fetch`.
- **Use the real thing where a stub would lie.** `japanese.test.ts` loads the actual kuromoji dictionary. `speech-to-text.test.ts`'s fake endpoint reports the duration a byte range really represents and cuts segments on its own boundaries, because a fake returning segments aligned to the chunk edge would pass against arithmetic that is wrong.
- **There are no DOM tests**, deliberately — the logic worth testing is pure and lives below the components. IndexedDB and the browser half of kuromoji are driven in a real browser instead, with a throwaway page. That is not optional diligence: this refactor's last three bugs — a language table indexed by position, a placeholder still naming YouTube, and a dictionary hanging on a header — were all invisible to `tsc` and to 336 passing tests.
- A `ponytail:` comment marks a deliberate shortcut and names its ceiling. There are none left; the two that existed were a write mutex and a job queue, and both went with the server.

## Not yet done

- **No `LICENSE`.** Needs choosing before this is published anywhere.
- **No CI.** `npm test && npm run typecheck && npm run build` is the whole of it.
- **Nothing has been deployed, and no episode has been imported end to end** on the new architecture. Every piece is verified on its own and the two halves have never been run together against a real feed.
- **A Library is per-browser-per-origin.** A phone and a laptop are two Libraries with no path between them, and the export is the only bridge. For a listening app the phone is a plausible primary device, so this is the sharpest open question (ADR 0008).
- **Translation can fall behind playback**, on a fast connection to a slow model: the Lines are there and the audio plays, the translations simply arrive under them late. Accepted (ADR 0011). A window that fails is not retried until the page is reloaded, and the only sign is the message beside the lyrics.
- **The ask-AI popup is one shot.** One fixed prompt about one Line, no input box, no history — so re-opening it asks the identical question. `completeStream(prompt: string)` takes a single string; follow-up means giving it a message list.
- **No retry for a `ready` Resource.** Re-importing would discard a Transcript that cost money, so redoing one is delete-and-import.
- **No Vite React plugin** — a dev edit reloads the page instead of hot-swapping the component, which loses playback position. Deliberate; production is unaffected.
