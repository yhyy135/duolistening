import { slotConfigured, type Settings } from "../shared/model.ts";
import { createAnnotator } from "./annotate.ts";
import type { ImportDeps } from "./import.ts";
import { createJapaneseTokenizerOnce } from "./japanese.ts";
import { proxyDetail, proxyUrl, sliceUrls } from "./proxy.ts";
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

/**
 * Translation, built for the player rather than for the import: it happens a window at
 * a time while someone is listening (ADR 0011).
 */
export function buildAnnotator(settings: Settings) {
  return createAnnotator({ textModel: createTextModel({ slot: settings.textModel }) });
}

/**
 * The Japanese tokenizer, on its own and beside the Annotator rather than inside it
 * (ADR 0015). kuromoji is local: it needs no key, no network and nothing from
 * Settings, so it is not built per screen the way a model client is — one thunk for
 * the page, and the dictionary is read at most once however many episodes are opened.
 *
 * Still a thunk, and still behind a dynamic import inside `japanese.ts`. A shelf of
 * Spanish must not pay for a Japanese dictionary, and only the Transcript knows
 * whether this one is worth downloading — which is `wantsJapanese`'s question.
 */
export const japaneseTokenizer = createJapaneseTokenizerOnce(DICT_PATH);

export function buildImportDeps(settings: Settings): ImportDeps {
  const speech = createSpeechToText({ slot: settings.transcriptionModel });

  return {
    store,
    nativeLanguage: settings.nativeLanguage,
    ...(settings.targetLanguage && { targetLanguage: settings.targetLanguage }),
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),

    // Omitted entirely when the slot is empty, rather than handed over to fail on the
    // first call. The import reads its absence as "keep the audio and stop", which is
    // how an episode can be downloaded and listened to before anybody has an API key
    // — the proxy is what a download needs, and that is a different setting.
    ...(slotConfigured(settings.transcriptionModel) && {
      transcribe: (episodeUrl: string, audio: Blob, onProgress: (n: number) => void) =>
        transcribe({
          audio,
          transcribeBlob: (blob) => speech.transcribeBlob(blob, settings.targetLanguage),
          // Only reached for an episode over the request limit, which is still chunked
          // by asking the proxy for ranges. `sliceUrls` wants a total; the Blob's own
          // size is the honest one, since it describes the bytes that were kept.
          sliceUrl: sliceUrls(settings.proxy, episodeUrl, audio.size),
          transcribeUrl: (url) => speech.transcribeUrl(url, settings.targetLanguage),
          onProgress,
        }),
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
        // Same reason as the feed listing: the host that refuses the feed refuses the
        // audio too, and "502" alone does not say that it was the origin refusing.
        const detail = await proxyDetail(response);
        throw new Error(
          `Could not fetch the audio: ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      // Relabelled from its magic bytes on the way in, never from the extension it
      // was named with. Chrome sniffs content and would hide a wrong type; Safari
      // believes the label and refuses to play (ADR 0008).
      return store.typedAudio(await response.blob(), response.headers.get("content-type"));
    },
  };
}
