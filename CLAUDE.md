# duolistening

A self-hosted listening-practice tool. Import a YouTube video or podcast episode, transcribe it with your own LLM keys, and study it through a lyrics-style transcript: the current line scrolls into view and highlights as it plays, your native-language translation sits under each line, and Japanese gets furigana and part-of-speech colouring.

Read [CONTEXT.md](CONTEXT.md) for the domain vocabulary (**Resource**, **Transcript**, **Line**, **Word**, **Token**, **Library**) and use those words. Read [docs/adr/](docs/adr/) for why the architecture is shaped the way it is — seven decisions, one paragraph each.

**Status: the server is complete and runnable. The frontend does not exist yet.**

## Commands

```bash
npm test                                  # node:test, no framework
npm run typecheck                         # tsc --noEmit
npm run format                            # prettier
DUOLISTENING_PASSWORD=secret npm start    # boots on :3000
```

Environment: `DUOLISTENING_PASSWORD` (access gate — unset disables it, fine on a laptop, reckless in public), `DUOLISTENING_DATA_DIR` (default `./data`), `DUOLISTENING_S3_BUCKET` + `DUOLISTENING_S3_PREFIX` (switches storage to S3; credentials and `AWS_ENDPOINT_URL` come from the standard AWS variables), `PORT`.

External binaries: **ffmpeg/ffprobe** and **yt-dlp** must be on PATH. Everything else is npm.

## How the code is laid out

```
src/shared/     the contract both halves import — model.ts (types) and locate.ts
src/server/     ports.ts declares every seam; each module implements one
docs/adr/       why things are the way they are
```

`src/server/ports.ts` is the map. Every interface lives there with its invariants and error modes documented; the implementation files hold no interface declarations of their own.

| Module | What it hides |
|---|---|
| `storage/local.ts`, `storage/s3.ts` | All persistence, behind one `Storage` seam. Local also exports `createLocalMediaServer` (HTTP Range serving) |
| `library.ts` | The shelf: list/get/save/remove/savePosition, with cascade delete and a write mutex |
| `ingest.ts` | yt-dlp for YouTube, HTTP download for podcast enclosures, plus error classification |
| `podcast-feed.ts` | RSS fetching and parsing |
| `transcriber.ts` | **The deepest module.** Silence-aware chunking, per-chunk calls, timestamp offsetting, stitching |
| `audio/ffmpeg.ts` | ffprobe duration, silencedetect, range extraction |
| `audio/speech-to-text.ts` | One `/audio/transcriptions` call, and word-list-to-segment assignment |
| `annotator.ts` | Batched translation, plus Japanese tokens. Owns the "is it Japanese" branch |
| `japanese.ts` | kuromoji: morphemes, part-of-speech mapping, katakana→hiragana readings |
| `text-model.ts` | One `/chat/completions` call, retry policy, JSON repair |
| `import-jobs.ts` | ingest → transcribe → annotate → store as a background job, with progress |
| `app.ts` | HTTP routes and the access gate. Takes every dependency; touches no env |
| `main.ts` | Composition root. The only file that reads `process.env` |

## Invariants that are easy to break

Every one of these was a real bug caught by a test. If you change the code near one, keep the test that guards it.

- **A job publishes `ready`/`failed` only after the Library write and temp cleanup finish.** The terminal phase is what stops a watcher; publishing early lets the UI read a stale shelf. (`import-jobs.ts`)
- **`save` writes blobs then the shelf; `remove` rewrites the shelf then deletes blobs.** Mirror images, so a crash halfway leaves unreachable bytes, never a shelf entry pointing at a missing file. (`library.ts`)
- **`words` is omitted, never `[]`.** An empty array reads as "word timing exists" and the player renders karaoke highlighting against nothing. (`transcriber.ts`, ADR 0004)
- **Translations are matched back by index, never by position.** A model that drops or reorders one entry would otherwise shift every later translation onto the wrong Line — invisible in the UI, wrong everywhere. (`annotator.ts`)
- **Furigana comes from kuromoji's `reading`, not `pronunciation`.** `pronunciation` writes long vowels as ー (ショーカイ); furigana is written しょうかい. (`japanese.ts`)
- **`Word` and `Token` are different things.** Word = audio timing from the ASR. Token = morphology from kuromoji. Japanese has no spaces, so their boundaries genuinely disagree; never merge the two arrays.
- **A masked API key means "unchanged".** Anything starting with `••••` is the value we showed the browser; storing it would wipe the real key on any settings save. (`settings.ts`)
- **Storage keys are untrusted.** They carry ids that came off a URL; `..` escapes the root on the local adapter. Both adapters validate. (`storage/key.ts`)
- **The access gate covers `/api/*` and `/media/*` only.** The SPA shell must load before anyone can be asked for a password. (`app.ts`)
- **`<audio>` cannot send headers**, so the gate accepts a cookie as well as a bearer token. (`app.ts`)
- **No TypeScript syntax that emits code.** Node runs these files by stripping types, so parameter properties, enums and namespaces break at runtime. `erasableSyntaxOnly` in tsconfig rejects them at typecheck.

## Testing conventions

- `node --test` with `node:assert`. No test framework, and don't add one — Node 24 strips types and runs `*.test.ts` directly.
- Test through a module's interface, not past it. Fakes are plain object literals implementing a port.
- **Use the real thing where a stub would lie.** `japanese.test.ts` loads the actual kuromoji dictionary; `audio/ffmpeg.test.ts` synthesises audio with ffmpeg and checks real silence detection. A wrong filter string or a misplaced `-ss` passes against a fake and ships broken.
- `storage/contract.test.ts` runs one suite against **both** Storage adapters. The S3 half only runs when `DUOLISTENING_TEST_S3_BUCKET` is set.
- A `ponytail:` comment marks a deliberate shortcut and names its ceiling. There are two: the Library's in-process write mutex, and the in-memory job queue. Both break under multi-instance deployment, which the single-tenant design (ADR 0001) rules out for now.

## Not yet done

- **The whole frontend.** `src/shared/locate.ts` (which Line and Word playback is on, pure and tested) is the only piece that exists.
- **Never run for real:** a yt-dlp download of an actual video, the S3 adapter against a real bucket, and RSS parsing against a real published feed. All three are covered by tests against fakes or synthetic input; none has touched the real thing.
