# duolistening

Listening practice. Paste a podcast feed, pick an episode, and it transcribes that
episode with your own LLM keys and gives you back a lyrics-style transcript: the
current line scrolls into view and lights up word by word as it plays, your own
language sits underneath, and Japanese gets furigana and part-of-speech colouring.

**Everything stays in your browser.** Your API keys, your shelf, your transcripts and
the audio itself live in your browser's storage and never reach a machine anyone else
runs. There are no accounts and no password, because there is nothing on a server to
put one in front of — which is also what lets several people share one deployment,
each paying for their own transcription with their own keys.

## What you need

- **An OpenAI-compatible chat endpoint and an OpenAI-compatible transcription
  endpoint.** They can be the same provider or two different ones. See below.
- **A byte proxy** — a small Cloudflare Worker, included in `worker/`. It exists
  because a browser genuinely cannot do three things for itself: follow the redirect
  a podcast host answers with, reach a host that sends no CORS headers, and hand a
  transcription endpoint a slice of a large file. It stores nothing.
- **Node 22.18 or newer**, but only to build. There is nothing to run afterwards.

No ffmpeg, no yt-dlp, no Docker, no database.

## Running it

```bash
npm ci
npm run dev:web   # http://localhost:5173
```

That is the whole of local development. Note that the transcription provider cannot
reach `localhost`, so importing a real episode needs a deployed page — see below.

## Deploying

Two halves that know nothing about each other.

**The page** is static. `npm run build` writes `dist/web`; put it on any static host.
It carries no configuration at all — not even the proxy's address, which is a setting
each reader fills in.

One requirement: whatever serves it **must not send `Content-Encoding: gzip` for
`/kuromoji/dict/*`**. Those files are gzipped content that the Japanese tokenizer
unpacks itself, not a transfer encoding, and a server that decodes them first leaves
the tokenizer hanging with no error to read.

**The proxy** is `worker/`:

```bash
cd worker
wrangler secret put PROXY_KEY   # not [vars] — that file is committed
wrangler deploy
```

`PROXY_KEY` is a shared secret you hand to the people you want using it. It is a real
secret rather than a public constant precisely because it lives in each reader's
settings instead of in the page everyone downloads. Cloudflare's own rate limiting is
the backstop against someone who obtains it; there is no code here that can be.

## Pointing it at models

Nothing works until you open **Settings**. Three things to fill in.

The two model slots are separate because the jobs are different: transcription has to
return per-segment timestamps, which most chat models cannot do.

| Slot                    | Endpoint used                     | What it does                      |
| ----------------------- | --------------------------------- | --------------------------------- |
| **Text Model**          | `{base URL}/chat/completions`     | Translation, and the ask-AI popup |
| **Transcription Model** | `{base URL}/audio/transcriptions` | Speech to text                    |

Each takes a base URL, an API key and a model name. Some combinations:

- **Groq for transcription** — `https://api.groq.com/openai/v1` with
  `whisper-large-v3-turbo`. This is the one verified against a real episode.
- **One provider for both** — `https://api.openai.com/v1`, with a chat model such as
  `gpt-4o-mini` and `whisper-1`.
- **Something local** — anything serving the same two paths works, though a local
  server the transcription provider cannot reach will not be able to fetch audio.

The transcription provider must support the `url` parameter, because that is how
every import hands over audio: the endpoint fetches slices from the proxy rather than
having them uploaded to it, which is most of why an import is fast. **Test
connection** checks this specifically, and says so when a provider can transcribe an
uploaded clip but cannot fetch one.

The third slot is the **byte proxy** — the address you deployed above, and its key.

Word-by-word highlighting needs word-level timestamps. duolistening asks for them and
quietly falls back to highlighting the whole line when a provider will not give them.

Set your **Native Language** here too — it is what everything is translated into, and
the interface follows it. The language you are studying is optional: leave it on
auto-detect and each import works out what it is hearing, which is what makes a shelf
of Japanese, Spanish and English episodes work without changing this first. Both are
recorded on each import, so changing them later never mislabels transcripts you
already have.

## Importing

Paste a podcast RSS feed into the one box on the library screen and pick an episode.
It takes minutes, and the shelf shows the phase as it goes.

Keep the tab open. The import runs in the page, so closing it abandons the import —
the entry stays on the shelf and **Resume** picks up from whatever survived. The same
button appears after a failure, with the reason beside it, and it never starts over:
a failed download does not mean paying to transcribe the episode again.

An import stops at the transcript. **Translation happens while you listen**: opening an
episode translates the lines around where you are, a few minutes' worth at a time, and
they appear under the lines as they arrive. Resuming at twenty minutes translates
twenty minutes in, not the beginning — and an episode you give up on five minutes into
only costs five minutes of translation. Nothing to press; it follows playback.

## Export your library

**Do this.** Browsers evict storage under disk pressure, and `navigator.storage.persist()`
was refused by every browser tested — so an export is the only copy of a transcript
that survives a browser deciding it needs the room. **Export** on the library screen
writes one JSON file.

It holds your transcripts, your shelf and your playback positions — including whatever
has been translated so far, so a library you have listened to travels with its
translations. It does not hold audio, which is around forty-five times larger and can
be fetched again, and it does not hold your API keys. Importing one only ever adds: an
episode already on the shelf is left exactly as it is.

## Development

```bash
npm test          # node:test, no framework
npm run typecheck
npm run format
npm run build     # → dist/web
npm run dev:web   # :5173
```

[CLAUDE.md](CLAUDE.md) is the map of the codebase, [CONTEXT.md](CONTEXT.md) defines
the vocabulary it uses, and [docs/adr/](docs/adr/) records why the architecture is
shaped the way it is.

## Known limits

- A library belongs to one browser. A phone and a laptop are two libraries, and the
  export is the only bridge between them.
- The ask-AI popup asks one fixed question about one line and keeps no history, so
  re-opening it gives the same answer.
- Nothing has yet been run end to end on this architecture: every part is tested, but
  the deployed page and the deployed proxy have not imported a real episode together.

## Licence

Not chosen yet — add a `LICENSE` file before publishing this anywhere.
