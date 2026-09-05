# Japanese tagging via a dedicated morphological analyzer, not the LLM

Part-of-speech and furigana readings for Japanese come from a dedicated Japanese morphological analyzer (kuromoji-family tooling; exact library picked during implementation), not from the configured Text Model. It runs as a step in the same backend pipeline that produces the Transcript, alongside translation, and its output (per-Token part-of-speech and reading) is stored on each Line at transcription time — computed once for every Line, not on demand for whichever one is currently playing. Which Line's tags are actually shown (only the currently-playing one, per the reference app) is a rendering choice, unrelated to when the data is produced.

A Token carries no timestamp and is independent of a Line's Word-level timing data (ADR 0004) — the two can disagree on boundaries entirely, which matters for Japanese since ASR word segmentation without spaces is unreliable to begin with.

Considered asking the Text Model to tag words while translating (no new dependency) — rejected because linguistic tagging isn't an LLM strength (heteronyms like 今日's きょう/こんにち reading, inconsistent tokenization across calls) and would add a model call, cost, and failure mode to every Line.
