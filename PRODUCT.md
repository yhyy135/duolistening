# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Language learners who study by listening to real podcasts in the language they are learning. Japanese gets the most support (furigana, part-of-speech colouring), but the shelf holds English, Chinese, Korean, Spanish, French and German episodes too.

They use it on a phone and on a desktop about equally: the phone while moving, one-handed, with the lock screen and headphone buttons; the desktop when sitting down to study a passage with the keyboard.

The deployment is meant to be opened to the public. A first-time visitor therefore arrives with an empty Library, no API keys and no proxy configured, and has to work out from the page alone what this is and what to do first.

## Product Purpose

Import a podcast episode, transcribe it with the reader's own model keys, and study it as a lyrics-style Transcript: the current Line scrolls into view and highlights word by word as it plays, the native-language translation sits under each Line, and Japanese gets furigana and part-of-speech colouring.

Success is a listener moving between listening modes inside one episode — drilling a sentence, following along, listening blind and then checking, stopping to read or ask about a Line — without fighting the controls, on either device.

## Positioning

The Line is the unit of study, not the fifteen-second skip: previous and next Line, replay, repeat-one and seek-by-Line are the transport, on screen, on the keyboard and on the lock screen.

Everything lives in the reader's own browser — no accounts, no server, keys never leave the device — and each reader pays for their own transcription, which is what lets one public deployment serve many readers.

## Operating Context

- All four listening modes are confirmed in use:
  - **Drilling**: replay and loop one Line, step to the previous or next, read the furigana and part of speech.
  - **Following**: playback runs, eyes follow the highlight, the translation gets an occasional glance.
  - **Blind, then check**: listen first without the text or translation, then reveal it to compare.
  - **Stopping to study**: pause to read a translation, or ask the AI to explain a Line's grammar.
- Desktop shortcuts: Space, ← / →, R (replay), L (loop). Phone: touch, 44px targets, lock-screen previous/next mapped to Lines.
- An import runs for minutes, and its progress is watched from the shelf.
- The page can be installed to a home screen; on iOS that is what keeps a Library from being evicted after seven days.
- Setup is a byte proxy (a Cloudflare Worker, required to download anything) plus two optional OpenAI-compatible model slots: transcription, and text (translation and ask-AI).

## Capabilities and Constraints

- **Library**: the shelf of Resources with live import progress, resume/retry, two-click delete; the paste-a-feed box and the episode-picker dialog; backup export and restore; the day's podcast Suggestions from Apple search, with language chips and a search box.
- **Player**: the lyrics view with word/Token sweep and follow-mode scrolling; the drawn transport (scrubber, previous/play/next Line, repeat-one); rate stops and a fine rate slider; jump back to the current Line; the ask-AI popup; retry transcription where the Lines are missing; translation that arrives while listening.
- **Settings**: appearance (the look and light/dark, per device and applied at once); native and studied language; two model slots with provider presets, fetch models and a connection test; the proxy; the settings transfer string; the build version.
- Eight interface languages, and the interface language is the Native Language.
- Two looks, Standard and Station, each in light, dark and auto.
- React 19 and Vite, one hand-written stylesheet, no CSS framework or component library, inlined Reicon icons.
- The invariants in `CLAUDE.md` are binding product behaviour, not implementation detail.
- Domain vocabulary is `CONTEXT.md`'s: Resource, Library, Suggestion, Transcript, Line, Word, Token.
- Undecided: the licence.

## Brand Commitments

- The name **Duolistening** stays.
- The current icon (a blue tile with three sound bars) may be replaced.
- Not gamified. No streaks, mascots, reward animations or Duolingo-style exuberance, whatever the name suggests.
- **Two looks, and the reader chooses between them** in Settings, on each device:
  - **Standard** is the default. It is the category standard played straight, and its bar is the lyric page of NetEase Cloud Music (网易云音乐) and QQ Music.
  - **Station** is the alternative: the Transcript read as a railway timetable.
  - Both are kept at full fidelity, and neither is a reskin of the other.
- Covers are the shows' real artwork, read from the feed. A monogram cover stands in when there is none.

## Evidence on Hand

- Real Transcripts in the gitignored `data/resources/`: a LibriVox reading of 「ごん狐」 (66 Lines with Words, Tokens and Chinese translations), a ゆる言語学ラジオ episode (828 Lines, 200 translated), and a BBC Real Easy English episode (112 Lines).
- No testimonials, user counts, reviews or press exist, and none may be invented.

## Product Principles

1. **The Line is the unit.** Every control that moves playback moves it by Lines.
2. **Listening never waits on a key.** Audio plays with only a proxy and furigana needs no key; whatever is missing is explained where it would have been, with the fix beside it.
3. **The reader's data and money are theirs.** Nothing re-bills a transcription silently, nothing destructive happens in one click, and nothing leaves the browser that the reader did not send.
4. **Study, not streaks.** Calm focus over engagement mechanics.
5. **A first visit explains itself**, because the deployment is public.

## Accessibility & Inclusion

- Every control is reachable by keyboard, and icon-only controls carry names in all eight languages.
- 44px touch targets and 16px text fields under `(hover: none)`; pinch-zoom is never disabled, on a page of small foreign-language text.
- Reduced motion is honoured, and colour is never the only carrier of a state.
