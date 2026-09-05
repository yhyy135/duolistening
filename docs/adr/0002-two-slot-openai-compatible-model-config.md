# Two model slots, both OpenAI-compatible

Model configuration is two independent slots — a **Text Model** (translation, word-class tagging, any other pure text task) and a **Transcription Model** (speech-to-text) — each configured the same way: `base_url` + `api_key` + `model`, matching the de facto OpenAI-compatible API shape (`/chat/completions` and `/audio/transcriptions`). A user can point both at the same provider or split them across two.

We considered one shared model slot (matches the original "one big model" framing) and per-provider native SDKs (OpenAI/Anthropic/Gemini adapters). Rejected one shared slot because it caps transcription to whatever text models happen to accept audio input, and those rarely return the segment-level timestamps the lyrics-sync feature depends on. Rejected per-provider SDKs because every added provider is a new code path to maintain; the OpenAI-compatible shape already covers most providers and local model servers through one integration.
