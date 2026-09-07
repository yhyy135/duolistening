# Chunk by byte range, and let the ASR place the cuts

Status: accepted, not yet built. Supersedes [ADR 0003](0003-audio-chunking-strategy.md).

Under the transcription endpoint's 25MB request limit — 26 minutes at 128kbps, which covers most episodes — the episode URL goes to the endpoint directly and nothing is downloaded, decoded or uploaded by anyone. Over it, the browser asks the proxy for byte ranges and hands those URLs over instead. Audio is never decoded, and ffmpeg is not involved at any size.

Cut points come from the previous chunk's own transcript: the end of its last complete segment, converted to a byte offset by the bytes-per-second the response itself reports, with the truncated trailing segment discarded. ADR 0003 searched for silence instead. That needed the whole file decoded to PCM, and an RMS threshold is an acoustic test where a segment boundary is a semantic one — it misses a speaker who runs two sentences together without pausing, and it false-fires under background music. The ASR already knows where the sentences are and says so in every reply.

We also considered decoding in the browser to 16kHz mono WAV, which is what the endpoint resamples to anyway. Rejected on arithmetic: 16kHz mono 16-bit is 32KB/s against roughly 16KB/s for the source mp3, so re-encoding halves how much audio fits under the same 25MB ceiling, and it costs 100–600MB of decode memory to do it. The source bytes are already the most compact form available.

Chunks are now necessarily sequential, and measurement says that costs nothing. Uploading is 75–80% of a chunk's wall time: 26MB took 23.4 seconds end to end, while the same endpoint returned 5.3 minutes of audio in 2.4 seconds when it fetched the URL itself. Parallel uploads would share one upstream pipe and finish no sooner. Serving slices through the proxy removes the upload leg altogether, which is worth more than any amount of concurrency.

Known ceiling: byte offsets assume the file does not change mid-import, and these hosts publish neither ETag nor Last-Modified, so there is no validator to hang an `If-Range` on. Each chunk re-checks the total length its own response reports against the first chunk's and fails loudly when it moves. A misaligned seam would otherwise be silent, and silently wrong here means a Line whose audio is thirty seconds away from its text.
