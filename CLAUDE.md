# duolistening

A self-hosted listening-practice tool. Import a YouTube video or podcast episode, transcribe it with your own LLM keys, and study it through a lyrics-style transcript: the current line scrolls into view and highlights as it plays, your native-language translation sits under each line, and Japanese gets furigana and part-of-speech colouring.

Read [CONTEXT.md](CONTEXT.md) for the domain vocabulary (**Resource**, **Transcript**, **Line**, **Word**, **Token**, **Library**) and use those words. Read [docs/adr/](docs/adr/) for why the architecture is shaped the way it is — seven decisions, one paragraph each.

**Status: both halves are complete and runnable.**

## Commands

```bash
npm test                                  # node:test, no framework
npm run typecheck                         # tsc --noEmit
npm run format                            # prettier
npm run build                             # vite → dist/web, which main.ts then serves
DUOLISTENING_PASSWORD=secret npm start    # boots on :3000

npm run dev:server                        # node --watch on :3000
npm run dev:web                           # vite on :5173, proxying /api and /media to :3000
```

`npm start` serves `dist/web` when it exists and warns that it is API-only when it
doesn't, so **build before you start**. In dev, run both halves and use :5173.

Environment: `DUOLISTENING_PASSWORD` (access gate — unset disables it, fine on a laptop, reckless in public), `DUOLISTENING_DATA_DIR` (default `./data`), `DUOLISTENING_S3_BUCKET` + `DUOLISTENING_S3_PREFIX` (switches storage to S3; credentials and `AWS_ENDPOINT_URL` come from the standard AWS variables), `PORT`.

External binaries: **ffmpeg/ffprobe** and **yt-dlp** must be on PATH. Everything else is npm.
The `Dockerfile` supplies all three; `compose.yaml` is the one-command way to run it.

Node 22.18+ (unflagged type stripping). Verified on 22.23 and 24.20 — the four
`audio/ffmpeg.test.ts` cases are the only ones that need a real ffmpeg.

## How the code is laid out

```
src/shared/     the contract both halves import — model.ts (types) and locate.ts
src/server/     ports.ts declares every seam; each module implements one
src/web/        the SPA — one file per screen, plus api.ts
docs/adr/       why things are the way they are
```

`src/server/ports.ts` is the map. Every interface lives there with its invariants and error modes documented; the implementation files hold no interface declarations of their own.

| Module                              | What it hides                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `storage/local.ts`, `storage/s3.ts` | All persistence, behind one `Storage` seam. Local also exports `createLocalMediaServer` (HTTP Range serving) |
| `library.ts`                        | The shelf: list/get/save/remove/savePosition, with cascade delete and a write mutex                          |
| `ingest.ts`                         | yt-dlp for YouTube, HTTP download for podcast enclosures, plus error classification                          |
| `podcast-feed.ts`                   | RSS fetching and parsing                                                                                     |
| `transcriber.ts`                    | **The deepest module.** Silence-aware chunking, per-chunk calls, timestamp offsetting, stitching             |
| `audio/ffmpeg.ts`                   | ffprobe duration, silencedetect, range extraction                                                            |
| `audio/speech-to-text.ts`           | One `/audio/transcriptions` call, and word-list-to-segment assignment                                        |
| `annotator.ts`                      | Batched translation, plus Japanese tokens. Owns the "is it Japanese" branch                                  |
| `japanese.ts`                       | kuromoji: morphemes, part-of-speech mapping, katakana→hiragana readings                                      |
| `text-model.ts`                     | One `/chat/completions` call, retry policy, JSON repair                                                      |
| `model-check.ts`                    | Trying both slots for real, so a typo surfaces in Settings and not mid-import                                |
| `import-jobs.ts`                    | ingest → transcribe → annotate as a background job, with progress — and the retry that resumes one           |
| `app.ts`                            | HTTP routes and the access gate. Takes every dependency; touches no env                                      |
| `main.ts`                           | Composition root. The only file that reads `process.env`                                                     |

The web half has one seam of its own, and it is the same idea: `web/api.ts` is the
only file that knows the server exists. Everything above it deals in model types.

| Module             | What it hides                                                            |
| ------------------ | ------------------------------------------------------------------------ |
| `web/api.ts`       | Every route, status code, `EventSource` and the session cookie           |
| `web/app.tsx`      | The access gate, the hash route, the header                              |
| `web/library.tsx`  | The shelf, the one paste-a-link box, and live import progress            |
| `web/player.tsx`   | The lyrics view: rAF sweep, follow-mode scroll, speed, line loop, ask-AI |
| `web/settings.tsx` | The two model slots and the language pair                                |

## Invariants that are easy to break

Every one of these was a real bug caught by a test. If you change the code near one, keep the test that guards it.

- **A retry resumes; it never restarts.** A stored Transcript means annotate only; stored audio means skip the download. Restarting instead would re-download and pay the transcription bill again to recover from a rate-limited translation — making the cheapest failure the most expensive. The pipeline stores those intermediates precisely so this can work. (`import-jobs.ts`)
- **Audio is written back only when it was just fetched.** On a resume it is already in the Library, and saving the restored copy would re-upload every byte to the same key. (`import-jobs.ts`)
- **A job publishes `ready`/`failed` only after the Library write and temp cleanup finish.** The terminal phase is what stops a watcher; publishing early lets the UI read a stale shelf. (`import-jobs.ts`)
- **`save` writes blobs then the shelf; `remove` rewrites the shelf then deletes blobs.** Mirror images, so a crash halfway leaves unreachable bytes, never a shelf entry pointing at a missing file. (`library.ts`)
- **`words` is omitted, never `[]`.** An empty array reads as "word timing exists" and the player renders karaoke highlighting against nothing. (`transcriber.ts`, ADR 0004)
- **Translations are matched back by index, never by position.** A model that drops or reorders one entry would otherwise shift every later translation onto the wrong Line — invisible in the UI, wrong everywhere. (`annotator.ts`)
- **Furigana comes from kuromoji's `reading`, not `pronunciation`.** `pronunciation` writes long vowels as ー (ショーカイ); furigana is written しょうかい. (`japanese.ts`)
- **`Word` and `Token` are different things.** Word = audio timing from the ASR. Token = morphology from kuromoji. Japanese has no spaces, so their boundaries genuinely disagree; never merge the two arrays. Reconciling them for display is `tokenWords`' job, and it happens at render time — a Token never gains a timestamp (ADR 0005).
- **A masked API key means "unchanged".** Anything starting with `••••` is the value we showed the browser; storing it would wipe the real key on any settings save. The connection check runs the edit through the same `applySettingsEdit`, so testing a slot you did not retype probes the stored key rather than the mask. (`settings.ts`, `app.ts`)
- **The connection check calls the endpoint the pipeline calls.** A cheaper probe — listing `/models`, or just resolving the host — passes for a model name that does not exist and for a provider that cannot transcribe at all. The transcription slot therefore gets a real generated clip, and it is a quiet tone rather than digital silence because some endpoints reject an all-zero file as "no audio" and would fail a working slot. (`model-check.ts`)
- **Storage keys are untrusted.** They carry ids that came off a URL; `..` escapes the root on the local adapter. Both adapters validate. (`storage/key.ts`)
- **The access gate covers `/api/*` and `/media/*` only.** The SPA shell must load before anyone can be asked for a password. (`app.ts`)
- **`<audio>` cannot send headers**, so the gate accepts a cookie as well as a bearer token. (`app.ts`)
- **The web half keeps no token.** `POST /api/session` sets an httpOnly cookie, and that cookie is what `fetch`, `<audio>` and `EventSource` all carry. Storing a bearer token instead would work for `fetch` and silently break the other two. (`web/api.ts`)
- **An import's `EventSource` is closed on unmount.** A browser allows only a handful of connections per host; a forgotten stream is one the player's `<audio>` cannot have. (`web/library.tsx`)
- **The saved position rides on `timeupdate`; only the highlight rides on `requestAnimationFrame`.** A hidden tab suspends rAF entirely while `<audio>` keeps playing — measured, not assumed: 0 frames in 5 seconds with playback advancing normally. So the frame loop stops refreshing `seconds`, and someone who switches tabs, listens on and then closes the page is rewound to wherever they switched away. `timeupdate` keeps firing in a hidden tab, and its four-times-a-second is coarse only for word highlighting, never for a resume point. Reading `audioRef` at save time is not the fix: React detaches the ref before the unmount cleanup runs, which is what the `seconds` ref exists for. (`web/player.tsx`)
- **Playback is sampled with `requestAnimationFrame`, not `timeupdate`.** `timeupdate` fires about four times a second — visibly late for word-level highlight. The cost is contained by only setting state when `locate` returns a different Line or Word. (`web/player.tsx`)
- **Tokens are swept by Word, never merged with them.** `tokenWords` matches both back onto `line.text` by character offset, so a Word covering three Tokens lights all three at once. Merging the two arrays instead — the obvious shortcut — silently mis-times every Line whose boundaries disagree, which for Japanese is most of them. (`shared/locate.ts`)
- **Every colour is one `light-dark()` token, and no rule below the palette names a colour.** A hardcoded hex renders one screen wrong in one theme, for the half of users on the other one, which is the bug nobody reports. Both values sitting on one line is what makes that structurally hard: a token cannot be restyled for light and forgotten for dark. `color-scheme` picks the half that applies and hands the same choice to what CSS does not draw, including the `<audio>` controls. Cost: this needs Chrome 123 / Safari 17.5 / Firefox 120, and on anything older every colour is invalid at once — a loud failure, not a subtle one.
- **The manual theme override is the `data-theme` attribute, and "auto" is its absence.** `:root[data-theme="light"|"dark"]` sets `color-scheme` outright; removing the attribute puts `prefers-color-scheme` back in charge with no rule of its own. `index.html` applies the stored choice in a blocking script before first paint — React's effect runs after it, and a dark flash on every load is exactly what someone who chose light is trying to avoid. (`app.tsx`, `styles.css`)
- **A faded Word is faded differently per theme.** On a dark ground a `pending` Word is still a light shape against black; on a light ground the same opacity walks it into the background. `--pending` is the one token that is not a colour, so `light-dark()` cannot hold it and it states both themes the long way.
- **No TypeScript syntax that emits code.** Node runs these files by stripping types, so parameter properties, enums and namespaces break at runtime. `erasableSyntaxOnly` in tsconfig rejects them at typecheck.

## Testing conventions

- `node --test` with `node:assert`. No test framework, and don't add one — Node 24 strips types and runs `*.test.ts` directly.
- Test through a module's interface, not past it. Fakes are plain object literals implementing a port.
- **Use the real thing where a stub would lie.** `japanese.test.ts` loads the actual kuromoji dictionary; `audio/ffmpeg.test.ts` synthesises audio with ffmpeg and checks real silence detection. A wrong filter string or a misplaced `-ss` passes against a fake and ships broken.
- `storage/contract.test.ts` runs one suite against **both** Storage adapters. The S3 half only runs when `DUOLISTENING_TEST_S3_BUCKET` is set.
- **One unexplained failure, 2026-09-07.** A full run came back 166/167 while a dev server, Docker and a browser were all busy on the same machine; 40 later runs could not reproduce it and the failing test was never identified. If it returns, start with the two `setTimeout(…, 10)` waits in `import-jobs.test.ts` — they assume the queue advances within 10ms, which is the only load-sensitive assumption in the suite.
- A `ponytail:` comment marks a deliberate shortcut and names its ceiling. There are two: the Library's in-process write mutex, and the in-memory job queue. Both break under multi-instance deployment, which the single-tenant design (ADR 0001) rules out for now.

## Not yet done

- **No `LICENSE`.** Needs choosing before this is published anywhere; the README says so too.
- **No CI.** `npm test && npm run typecheck && npm run build` is the whole of it.
- **The ask-AI popup is one shot.** Clicking `?` sends one fixed prompt about one Line and shows one answer; there is no input box, and the server keeps no history, so re-opening it asks the identical question and gets the identical answer. A hard sentence usually takes two or three rounds. Deferred deliberately (2026-09-07) rather than forgotten: it is not a front-end change. `TextModel.complete(prompt: string)` in `ports.ts` takes a single string, so follow-up means giving that seam a message list and changing `POST /api/ask` to match.
- **No retry for a `ready` Resource.** Re-importing would discard a Transcript that cost money, so `POST /api/library/:id/retry` answers 409 and redoing one is delete-and-import.
- **No Vite React plugin** — a dev edit reloads the page instead of hot-swapping the component, which loses playback position. Deliberate, and accepted: production is unaffected. Add `@vitejs/plugin-react` if it starts to grate.
- **No DOM tests.** The web half's real logic lives in `shared/locate.ts` — pure, and covered there. The rest is rendering, and testing it would mean adding a DOM and a test framework this project deliberately doesn't have; it is checked by driving the built app in a browser instead.
