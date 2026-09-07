/**
 * The one thing a browser cannot do for itself.
 *
 * Three jobs, one handler, because they are the same request with different query
 * params: follow the redirect a podcast host answers with, add the CORS headers it
 * does not send, and — the reason this exists — hand a transcription endpoint a byte
 * range of a large file dressed up as a whole file.
 *
 * Never buffers. `upstream.body` goes straight into the Response, so the runtime
 * pipes the bytes outside this isolate: no CPU time, no memory, whatever the size.
 * `await upstream.arrayBuffer()` would undo all three of those at once.
 */

/** Only what this app actually imports. Anything else and it is a general web proxy. */
const ALLOWED_TYPE = /^(audio\/|video\/|application\/(rss|atom)?\+?xml|text\/xml)/i;

/** Fixed, so the origin's answer never depends on who is asking. See below. */
const UA = "duolistening/1.0";

export interface Env {
  /**
   * Comma-separated hosts, matched on the URL as given — subdomains included, so
   * `archive.org` covers `ia600103.us.archive.org`. Empty (the default) allows any
   * host, because for a shared deployment there is no list to write: podcast audio
   * lives on hundreds of CDNs, and one real file answered three consecutive requests
   * from `ia600103.us.archive.org` and then twice from `dn710708.ca.archive.org`.
   * Worth setting only for a personal deployment that imports from known feeds.
   *
   * Checked on the URL handed in, never on where it redirects to: `redirect: follow`
   * resolves that inside fetch, and an allowed host with an open redirect is a way
   * out of the list. That is the cost of following redirects at all, which one
   * caller needs — see above.
   */
  ALLOWED_HOSTS?: string;

  /**
   * Required in every request as `?k=`. Empty (the default) disables the check.
   *
   * A query parameter and not a header, because the caller that matters here is a
   * transcription endpoint fetching a URL: it sends nothing this Worker chooses, so
   * anything carried in a header cannot reach it.
   *
   * This is the only gate that means anything, and it means something only because
   * the page does not carry it: the reader types it into Settings beside the proxy's
   * base URL, so it is a shared secret handed out of band rather than a constant
   * compiled into a bundle anyone can read. There is deliberately no origin allowlist
   * beside it — a caller holding the key passes with or without an `Origin` header,
   * and one lacking it is refused either way, so the list would only manage to lock
   * out a reader hosting the page themselves. Set this with `wrangler secret put`,
   * never in `[vars]`: those sit in plaintext in a file that gets committed.
   */
  PROXY_KEY?: string;
}

export async function handle(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  env: Env = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  const params = new URL(request.url).searchParams;

  // Before the fetch below, so a request that fails here costs no bandwidth and
  // never touches the origin.
  if (env.PROXY_KEY && !sameKey(params.get("k") ?? "", env.PROXY_KEY)) {
    return cors(text("bad or missing ?k", 403));
  }

  const target = params.get("url");
  if (!target) return cors(text("missing ?url", 400));

  let origin: URL;
  try {
    origin = new URL(target);
  } catch {
    return cors(text("malformed ?url", 400));
  }
  // Not a general-purpose proxy: file:// and friends never make sense here, and an
  // open relay is what this would be without the check.
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    return cors(text(`refusing protocol ${origin.protocol}`, 400));
  }
  if (!hostAllowed(origin.hostname, env.ALLOWED_HOSTS)) {
    return cors(text(`host not on ALLOWED_HOSTS: ${origin.hostname}`, 403));
  }

  const start = params.get("start");
  const end = params.get("end");
  const headers = new Headers();
  // Absent start means the whole file — that is the feed and small-episode case.
  if (start !== null) headers.set("range", `bytes=${start}-${end ?? ""}`);
  // Every request the origin sees comes from here, so it sees one client and one
  // version. Podcast hosts that splice ads pick the cut by User-Agent — one real
  // feed answers curl with 43,421,257 bytes and a browser with 44,263,131, a
  // 30-second difference — and a byte offset means nothing across two versions.
  headers.set("user-agent", UA);

  let upstream: Response;
  try {
    // Following the redirect is the entire point for one of these callers: Groq's
    // url mode answers a 302 with media_fetch_failed rather than following it.
    upstream = await fetchImpl(origin.toString(), { headers, redirect: "follow" });
  } catch {
    return cors(text(`could not reach ${origin.host}`, 502));
  }

  // 206 is the success case for a range request, so it is not an error here.
  if (!upstream.ok && upstream.status !== 206) {
    return cors(text(`upstream answered ${upstream.status}`, 502));
  }

  const type = upstream.headers.get("content-type") ?? "";
  if (!ALLOWED_TYPE.test(type)) return cors(text(`refusing content-type ${type}`, 415));

  // A fixed User-Agent pins the version within one request; nothing pins it across
  // the several minutes an import takes, and these origins publish no ETag or
  // Last-Modified to hang an If-Range on. So the caller passes the total it saw on
  // the first chunk and every later chunk re-checks it. A changed total means the
  // offsets in flight now point somewhere else, and the only safe answer is to say
  // so — a silently misaligned seam is a Line whose audio is 30 seconds away.
  const expected = params.get("total");
  const actual = upstream.headers.get("content-range")?.split("/")[1];
  if (expected && actual && expected !== actual) {
    return cors(text(`file changed under us: expected ${expected} bytes, origin now ${actual}`, 409));
  }

  // The caller asked for a slice, but whoever transcribes it must see a whole file:
  // a 206 with Content-Range announces "this is part of something bigger", and an
  // endpoint that believes it may reject the request or mis-report the duration.
  const out = new Headers({ "content-type": type });
  const length = upstream.headers.get("content-length");
  if (length) out.set("content-length", length);

  return cors(new Response(upstream.body, { status: 200, headers: out }));
}

/** Empty list means no list: everything passes. A host matches itself or any parent. */
function hostAllowed(hostname: string, list?: string): boolean {
  const allowed = (list ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return true;

  const host = hostname.toLowerCase();
  // The dot matters: `evil-archive.org` must not pass a list saying `archive.org`.
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Constant-time, so the key does not leak one character at a time. The server half
 * does this with `timingSafeEqual` from node:crypto; that does not exist in this
 * runtime without a compatibility flag, so the comparison is spelled out instead.
 */
function sameKey(presented: string, expected: string): boolean {
  // Folding the lengths in first means a wrong length is a mismatch rather than an
  // early return, and the loop runs over `expected` so its own length sets the cost.
  let differences = presented.length ^ expected.length;
  for (let index = 0; index < expected.length; index++) {
    differences |= expected.charCodeAt(index) ^ (presented.charCodeAt(index) || 0);
  }
  return differences === 0;
}

function text(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

/**
 * The page calls this cross-origin, so every answer needs these — errors too, or a
 * failure reaches the page as an opaque CORS error instead of its actual message.
 * `*` for everyone: the key decides who gets served, and it decides that before any
 * of this, so narrowing by origin here would only refuse readers hosting their own copy.
 */
function cors(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,HEAD,OPTIONS");
  response.headers.set("access-control-allow-headers", "*");
  return response;
}

export default { fetch: (request: Request, env: Env) => handle(request, globalThis.fetch, env) };
