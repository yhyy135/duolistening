import type { ProxySettings } from "../shared/model.ts";

/**
 * Addressing the byte proxy (ADR 0009) — the one server left, and the only thing in
 * this app a browser cannot do for itself.
 *
 * Three jobs go through it, and they are one request with different query params:
 * fetching a feed, handing a transcription endpoint a whole small episode, and
 * handing it a byte range of a large one dressed up as a whole file. So most of this
 * module is a URL builder, and the two calls it does make are the two nobody else
 * can make on its behalf.
 *
 * Nothing about the proxy is compiled in. Its base URL and key are settings the
 * reader fills in like any other, which is what makes the key a real shared secret
 * instead of a public constant, and what lets someone point the page at a proxy they
 * run themselves.
 */

/** Inclusive on both ends, the way HTTP Range means it. */
export interface ByteRange {
  startByte: number;
  endByte: number;
  /**
   * The size this import measured before it planned a single chunk. The proxy holds
   * it against what the origin reports now and answers 409 when they differ (ADR
   * 0010) — these hosts publish neither ETag nor Last-Modified, so there is no
   * validator to hang an `If-Range` on and this is the only check available. A file
   * that changed underneath an import means every offset in flight points somewhere
   * else, and a silently misaligned seam is a Line whose audio is 30 seconds away.
   */
  totalBytes?: number;
}

/**
 * Why a call failed, in terms the Settings screen can turn into a fix. Three
 * separately deployed things can be wrong here — the proxy, its configuration, and
 * the origin it was pointed at — so "it didn't work" is not a useful answer.
 *
 * `not_configured`   nothing typed in Settings yet.
 * `network`          the proxy itself never answered: wrong base URL, not deployed, offline.
 * `auth`             the key is wrong or missing.
 * `host_not_allowed` the key is fine; that origin is not on the proxy's ALLOWED_HOSTS.
 * `bad_request`      the proxy would not accept the target URL — malformed, or not http.
 * `content_type`     the origin answered with something that is not audio, video or a feed.
 * `upstream`         the proxy is fine and could not get the bytes.
 * `changed`          the episode changed size mid-import; every planned offset is now wrong.
 * `bad_response`     it answered, without the bytes or the length that were the point.
 */
export type ProxyErrorReason =
  | "not_configured"
  | "network"
  | "auth"
  | "host_not_allowed"
  | "bad_request"
  | "content_type"
  | "upstream"
  | "changed"
  | "bad_response";

export class ProxyError extends Error {
  readonly reason: ProxyErrorReason;
  constructor(reason: ProxyErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProxyError";
    this.reason = reason;
  }
}

/**
 * Big enough that bytes demonstrably crossed the wire, small enough to be free.
 * Only ever asked for during a settings check.
 */
const PROBE_BYTES = 1024;

/**
 * The URL to hand anything that fetches on our behalf — `fetch` here, or the
 * transcription endpoint, which is the caller that matters.
 *
 * Every parameter name is fixed by `worker/index.ts`. An absent `start` means the
 * whole file, which is the feed and small-episode case; `k` is the proxy's only gate.
 */
export function proxyUrl(
  proxy: ProxySettings | undefined,
  target: string,
  range?: ByteRange,
): string {
  if (!proxy?.baseUrl.trim()) {
    throw new ProxyError("not_configured", "No proxy is set. Settings has the field.");
  }

  let url: URL;
  try {
    url = new URL(proxy.baseUrl);
  } catch (cause) {
    // Otherwise this surfaces as a bare TypeError from somewhere deep in an import.
    throw new ProxyError("not_configured", `The proxy base URL is not a URL: ${proxy.baseUrl}`, {
      cause,
    });
  }

  url.searchParams.set("url", target);
  if (range) {
    url.searchParams.set("start", String(range.startByte));
    url.searchParams.set("end", String(range.endByte));
    if (range.totalBytes !== undefined) url.searchParams.set("total", String(range.totalBytes));
  }
  // Last, and only when there is one. It reaches the transcription provider's
  // request logs either way (a known ceiling, ADR 0009); an empty one would sit
  // there saying nothing and would fail a proxy that has no key set anyway.
  if (proxy.key) url.searchParams.set("k", proxy.key);

  return url.toString();
}

/**
 * `TranscribeDeps.sliceUrl` for one episode, with the size guard already applied.
 *
 * The total rides on every range and not merely the first, because the first is what
 * measured it: chunks two onward are the ones that would seam in the wrong place if
 * the file moved underneath them.
 */
export function sliceUrls(proxy: ProxySettings | undefined, target: string, totalBytes: number) {
  return (range?: { startByte: number; endByte: number }): string =>
    proxyUrl(proxy, target, range && { ...range, totalBytes });
}

/**
 * How many bytes the episode is — which `transcribe` needs before it can plan a
 * single chunk, and which there is no cheap way to ask for.
 *
 * A ranged response carries the total after the slash in `Content-Range`, and the
 * proxy strips that header deliberately: whoever transcribes a slice must see a
 * whole file, and an endpoint told "this is part of something bigger" may refuse it
 * or mis-report its duration. Restoring it would not help anyway — `Content-Range`
 * is not a CORS-safelisted response header and the proxy exposes none, so a
 * cross-origin page could not read it if it were there. `Content-Length` *is*
 * safelisted, which leaves exactly one observable number: the length of whatever was
 * actually served. Ask for the whole file and that length is the total.
 *
 * So this asks for the whole file and throws the body away without reading it. The
 * origin starts sending an episode nobody wants; cancelling as the headers land
 * stops it after a buffer or two rather than 40MB. (The 409 guard's message does
 * name the origin's current size, and reading it back would cost one byte — but that
 * means parsing an error string out of a Worker that deploys separately from this
 * page and knows nothing about it. A rewording there would break imports here.)
 *
 * The feed's own `<enclosure length>` would be free and is not usable: the reason
 * the proxy pins a User-Agent at all is that one real host answers 43,421,257 bytes
 * to one client and 44,263,131 to another for the same episode. Only a number
 * measured through the proxy describes the bytes the chunks will be cut from.
 */
export async function fetchTotalBytes(
  proxy: ProxySettings | undefined,
  target: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> {
  const response = await get(proxy, target, undefined, fetchImpl);
  await response.body?.cancel().catch(() => {});

  const total = Number(response.headers.get("content-length"));
  if (!Number.isInteger(total) || total <= 0) {
    throw new ProxyError(
      "bad_response",
      `The proxy served ${target} without a Content-Length, so its size cannot be known from here.`,
    );
  }
  return total;
}

export type ProxyCheck = { ok: true } | { ok: false; reason: ProxyErrorReason; detail: string };

/**
 * Tries the proxy the way an import will use it: pulls a byte range and confirms
 * bytes came back.
 *
 * Pinging the proxy's root would pass for a deployment that cannot fetch anything —
 * the same trap the model check avoids by calling the endpoint the pipeline calls. A
 * root ping never presents `?url`, so it exercises neither the key nor the content
 * type nor whether ranges survive the trip, and those are three of the four ways
 * this can be wrong.
 *
 * The target is the caller's, not a constant: a proxy configured with ALLOWED_HOSTS
 * serves the reader's own feeds and refuses everything else, so a hard-coded probe
 * URL would report a correctly configured proxy as broken. Hand it a feed or episode
 * URL this deployment will actually fetch.
 */
export async function checkProxy(
  proxy: ProxySettings | undefined,
  target: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProxyCheck> {
  try {
    const response = await get(
      proxy,
      target,
      { startByte: 0, endByte: PROBE_BYTES - 1 },
      fetchImpl,
    );
    if ((await firstChunkSize(response)) === 0) {
      return { ok: false, reason: "bad_response", detail: `${target} came back empty.` };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof ProxyError) {
      return { ok: false, reason: error.reason, detail: error.message };
    }
    return {
      ok: false,
      reason: "network",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function get(
  proxy: ProxySettings | undefined,
  target: string,
  range: ByteRange | undefined,
  fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
  const url = proxyUrl(proxy, target, range);

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    // A cross-origin failure reaches the page as an opaque TypeError with no detail,
    // so this one reason covers "wrong base URL", "not deployed" and "offline" alike.
    throw new ProxyError("network", `Could not reach the proxy at ${proxy?.baseUrl}`, { cause });
  }

  // The proxy turns a 206 into a 200 on the way through, so anything that is not ok
  // is a failure it is describing in the body — its own, or the origin's.
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProxyError(
      reasonFor(response.status, detail),
      `The proxy answered ${response.status}: ${detail}`,
    );
  }
  return response;
}

/**
 * Whatever arrived first, then hang up. A host that ignores `Range` answers with the
 * whole episode, and a settings check must not become a 40MB download because of it.
 */
async function firstChunkSize(response: Response): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) return 0;
  try {
    const { value } = await reader.read();
    return value?.byteLength ?? 0;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function reasonFor(status: number, detail: string): ProxyErrorReason {
  // The proxy has two 403s — it checks the key first and the host list second — and
  // only the body says which. Matching on it is a hint rather than a decision: the
  // message is shown either way, and a wrong guess names the likelier of two fixes.
  if (status === 403) return /allowed_hosts/i.test(detail) ? "host_not_allowed" : "auth";
  if (status === 409) return "changed";
  if (status === 415) return "content_type";
  // 502 is the proxy saying the origin failed; anything else in the 500s is the
  // proxy or its runtime failing, and the reader's move is the same for both.
  if (status >= 500) return "upstream";
  return "bad_request";
}
