# Chunk long audio at max size, cut on silence, hard-cut fallback

Status: superseded by [ADR 0010](0010-byte-range-chunks-asr-placed-cuts.md), which cuts on
byte ranges and takes the seam from the ASR's own segments instead of from silence.

For audio longer than the transcription endpoint's request limit, we split into as few chunks as possible: target each chunk near the endpoint's size/duration ceiling, then find the actual cut point by searching for the nearest silence around that target (via silence detection) instead of cutting exactly at it — this keeps sentences intact at the seams in the common case. If no silence falls within the search window (continuous speech), fall back to a hard cut at the target point so chunking always terminates. Each chunk is transcribed independently; its segment timestamps are then offset by the chunk's start time in the original file and concatenated into one continuous timeline.

Considered small fixed-size windows (simpler, but more API calls and more seams) and pure silence-based splitting with no size ceiling (risks oversized chunks with no pause to split on, and no guaranteed upper bound). This hybrid minimizes chunk count while still guaranteeing every chunk stays under the limit.
