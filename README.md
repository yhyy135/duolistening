# duolistening

Self-hosted listening practice. Paste a YouTube link or a podcast feed, and it
transcribes the episode with your own LLM keys and gives you back a lyrics-style
transcript: the current line scrolls into view and lights up word by word as it
plays, your own language sits underneath, and Japanese gets furigana and
part-of-speech colouring.

It is one person's tool. There are no accounts — one deployment serves you, with a
single shared password in front of it.

## What you need

- **Node 22.18 or newer.** The server runs its TypeScript sources directly, which
  needs a Node that strips types without a flag. Verified on 22.23 and 24.20.
- **ffmpeg** and **ffprobe** — measuring, cutting and normalising audio.
- **yt-dlp** — fetching audio from YouTube. Not needed for podcasts.
- **An OpenAI-compatible chat endpoint and an OpenAI-compatible transcription
  endpoint.** They can be the same provider or two different ones. See below.

Docker gives you the first three for free.

## Running it

### Docker

```bash
echo "DUOLISTENING_PASSWORD=pick-something" > .env
docker compose up --build
```

Then open http://localhost:3000. Compose reads that `.env` for every subcommand, so
`logs`, `ps` and `down` all work afterwards without repeating yourself. Your library
and audio live in a named volume and survive `docker compose down`.

### From source

```bash
npm ci
npm run build                                  # the browser half, into dist/web
DUOLISTENING_PASSWORD=pick-something npm start # http://localhost:3000
```

`npm start` serves `dist/web` when it is there and warns that it is API-only when it
is not, so build before you start.

## Pointing it at models

Nothing works until you open **Settings** and fill in the two slots. They are
separate because the jobs are different: transcription has to return per-segment
timestamps, which most chat models cannot do.

| Slot                    | Endpoint used                     | What it does                      |
| ----------------------- | --------------------------------- | --------------------------------- |
| **Text Model**          | `{base URL}/chat/completions`     | Translation, and the ask-AI popup |
| **Transcription Model** | `{base URL}/audio/transcriptions` | Speech to text                    |

Each slot takes a base URL, an API key and a model name. Some combinations:

- **One provider for both** — base URL `https://api.openai.com/v1`, with a chat model
  such as `gpt-4o-mini` and `whisper-1`.
- **Split across two** — this is the combination the pipeline was last verified
  end to end against: OpenRouter (`https://openrouter.ai/api/v1`) for text, and Groq
  (`https://api.groq.com/openai/v1`, `whisper-large-v3-turbo`) for transcription.
- **Something local** — anything serving the same two paths, such as a local
  llama.cpp or vLLM server, works. Point the base URL at it and leave the key blank
  if it does not want one.

Word-by-word highlighting needs word-level timestamps. duolistening asks for them
and quietly falls back to highlighting the whole line when a provider will not give
them, so a provider that lacks them still works, just less precisely.

Set the language pair here too: what you are studying, and what to translate into.
It is recorded on each import, so changing it later never mislabels transcripts you
already have.

## Configuration

Everything except the model slots is an environment variable.

| Variable                 | Default  | Meaning                                                |
| ------------------------ | -------- | ------------------------------------------------------ |
| `DUOLISTENING_PASSWORD`  | _unset_  | The shared password. Unset disables the gate entirely. |
| `DUOLISTENING_DATA_DIR`  | `./data` | Where everything is kept, when using local storage.    |
| `DUOLISTENING_S3_BUCKET` | _unset_  | Set it to keep everything in S3 instead of on disk.    |
| `DUOLISTENING_S3_PREFIX` | _unset_  | Key prefix within that bucket.                         |
| `PORT`                   | `3000`   |                                                        |

**Set a password.** It is the only thing between a stranger who finds the URL and
your API budget. Unset is reasonable on a laptop and reckless anywhere else — the
server says so at startup.

### Storage

By default everything — settings, transcripts and audio — goes under
`DUOLISTENING_DATA_DIR`. Set `DUOLISTENING_S3_BUCKET` and it goes to S3 instead,
with audio streamed to the browser from presigned URLs so it never passes through
the server. Credentials come from the standard AWS variables, and `AWS_ENDPOINT_URL`
points it at MinIO, R2 or B2 without any code change.

There is no database.

## Importing

Paste into the one box on the library screen:

- a **YouTube** link — imported straight away;
- anything else is treated as a **podcast RSS feed**, and you pick an episode.

Importing runs in the background and takes minutes; the shelf shows the phase as it
goes. If it fails — a rate-limited key, a video that will not download — the entry
stays on the shelf with the reason, and **Retry** picks up from whatever survived
rather than starting over, so a failed translation does not mean paying to download
and transcribe the whole thing again.

## Development

```bash
npm test          # node:test, no framework
npm run typecheck
npm run format
npm run dev:server  # :3000
npm run dev:web     # :5173, proxying /api and /media to :3000 — use this one
```

[CLAUDE.md](CLAUDE.md) is the map of the codebase, [CONTEXT.md](CONTEXT.md) defines
the vocabulary it uses, and [docs/adr/](docs/adr/) records why the architecture is
shaped the way it is.

## Licence

Not chosen yet — add a `LICENSE` file before publishing this anywhere.
