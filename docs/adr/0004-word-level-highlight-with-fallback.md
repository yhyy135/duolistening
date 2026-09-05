# Word-level highlight, falls back to line-level

Per-word timestamps within a Line are an optional field on the transcript data model, not a requirement. When the Transcription Model returns them, playback highlights word-by-word (karaoke-style, matching the reference app). When it doesn't, playback falls back to highlighting the whole Line. This keeps the feature working across transcription providers of varying capability instead of hard-requiring word-level timestamps everywhere.

Considered requiring word-level timestamps outright (simpler code, but breaks entirely on providers that only return line-level data) and line-level-only for v1 (safest, but short of the reference app's word-by-word highlight). The fallback gets both: compatibility everywhere, richer experience where available.
