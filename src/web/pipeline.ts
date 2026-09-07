import type { Settings } from "../shared/model.ts";
import { createAnnotator } from "./annotate.ts";
import type { ImportDeps } from "./import.ts";
import { createJapaneseTokenizerOnce } from "./japanese.ts";
import { fetchTotalBytes, proxyUrl, sliceUrls } from "./proxy.ts";
import { createSpeechToText } from "./speech-to-text.ts";
import * as store from "./store.ts";
import { transcribe } from "./transcribe.ts";
import { createTextModel } from "./text-model.ts";

/**
 * The composition root, and the only file that knows how the pieces fit together —
 * what `main.ts` was for the server before ADR 0008 deleted it. Everything above this
 * deals in its own dependency shape and nothing above it builds a client.
 *
 * Rebuilt per import rather than kept: the reader may have changed a key or a model
 * between two of them, and a client holding the old one would keep using it until
 * the page reloaded.
 */

/**
 * Where the kuromoji dictionary is served from. Same-origin by necessity, not by
 * preference: the loader joins filenames on with `path.join`, which turns
 * `https://host/dict` into `https:/host/dict` and fetches nothing, so a CDN is out
 * without patching kuromoji. The twelve files behind this path are a build concern
 * and are not copied there yet.
 */
const DICT_PATH = "/kuromoji/dict";

export function buildImportDeps(settings: Settings): ImportDeps {
  const speech = createSpeechToText({ slot: settings.transcriptionModel });
  const annotator = createAnnotator({
    textModel: createTextModel({ slot: settings.textModel }),
    // A thunk, so a shelf of Spanish never pays for a Japanese dictionary — and the
    // module behind it is a dynamic import, so it is not in the bundle either.
    tokenizer: createJapaneseTokenizerOnce(DICT_PATH),
  });

  return {
    store,
    nativeLanguage: settings.nativeLanguage,
    ...(settings.targetLanguage && { targetLanguage: settings.targetLanguage }),
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),

    totalBytes: (episodeUrl) => fetchTotalBytes(settings.proxy, episodeUrl),

    transcribe: (episodeUrl, total, onProgress) =>
      transcribe({
        totalBytes: total,
        sliceUrl: sliceUrls(settings.proxy, episodeUrl, total),
        transcribeUrl: (url) => speech.transcribeUrl(url, settings.targetLanguage),
        onProgress,
      }),

    annotate: (transcript, hooks) =>
      annotator.annotate(transcript, {
        nativeLanguage: settings.nativeLanguage,
        ...(settings.targetLanguage && { targetLanguage: settings.targetLanguage }),
        onProgress: hooks.onProgress,
        onBatch: hooks.onBatch,
      }),

    /**
     * The audio itself, for playback. Through the proxy like everything else, so the
     * bytes come from the same client the transcription was cut from — a host that
     * splices advertising per fetch would otherwise hand these back a whole ad break
     * out of step with their own timestamps.
     */
    async fetchAudio(episodeUrl) {
      const response = await fetch(proxyUrl(settings.proxy, episodeUrl));
      if (!response.ok) {
        throw new Error(`Could not fetch the audio: ${response.status}`);
      }
      // Relabelled from its magic bytes on the way in, never from the extension it
      // was named with. Chrome sniffs content and would hide a wrong type; Safari
      // believes the label and refuses to play (ADR 0008).
      return store.typedAudio(await response.blob(), response.headers.get("content-type"));
    },
  };
}
