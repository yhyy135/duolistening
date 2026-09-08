# Listening does not wait for an API key

Status: accepted.

An import no longer requires a Transcription Model. When that slot is empty `buildImportDeps` omits `transcribe` entirely, rather than handing over a client that will fail on its first call, and the import reads the absence as "keep the audio and stop". The Resource rests in a new phase, `untranscribed`: it plays, it sits on the shelf like any other, and the Resume that was already there finishes it whenever a model is filled in. Because the audio is stored before transcription is attempted (ADR 0010), that later run pays for the transcription and nothing else.

The two model slots and the byte proxy used to be one gate, and they are three different things. Downloading an episode needs the proxy and only the proxy; making Lines needs somebody's API key; translating them needs a second one. Anyone who had just found the page had to obtain two API keys before hearing a single episode, which is a long way to walk before finding out whether the tool is any good.

The proxy's half of that is not negotiable, and the measurement is worth keeping rather than the argument. Six real podcasts, fetched from a page by a real browser: four were refused by CORS, including all three of the Japanese-learning shows the recommendations surface. There is no pattern to lean on — anchor.fm serves its feed cross-origin and its audio not, NPR the other way round — so the page cannot decide per host, and every byte keeps going through the Worker.

We considered marking such an import `ready` and letting the reader delete and re-import once they had a key. Rejected: `ready` is precisely what stops a retry from discarding a Transcript that cost money, and an episode with no Transcript has nothing to protect. It needs the opposite — an obvious way to finish. A resting phase that a Resume already aims at is both the smaller change and the honest one.

`hasAudio` came out of the same work and is the part most likely to be missed later. `failed` says an import stopped, not where it stopped, and the common failure is now a download that worked followed by a transcription that did not — which leaves a perfectly playable episode. The shelf used to read the phase, and refused to open bytes it already held.

Where the Lines would be, the player says what is missing and offers the fix: Settings when no model is configured, and a retry when one is. That retry runs the import from the player, which is the one place a Resource is written from two directions at once, so it re-reads the Resource before starting and writes the playback position back afterwards — `store.save` puts the whole row, and the reader is very likely still listening while it runs.

Known ceiling: a `failed` Resource that has audio shows a red failure on the shelf even though it plays. That is accurate rather than pretty. The alternative is a phase meaning "playable but broken", which is a distinction nobody would keep correct.
