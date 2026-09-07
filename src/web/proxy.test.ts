import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProxySettings } from "../shared/model.ts";
import {
  ProxyError,
  checkProxy,
  fetchTotalBytes,
  proxyUrl,
  sliceUrls,
  type ProxyErrorReason,
} from "./proxy.ts";

const proxy: ProxySettings = { baseUrl: "https://p.workers.dev/", key: "s3cret" };
const EPISODE = "https://host.example/ep.mp3";

/** Records every URL asked for and answers with what it was told to. */
function spy(...answers: Response[]) {
  const urls: string[] = [];
  let call = 0;
  const impl: typeof globalThis.fetch = async (input) => {
    urls.push(String(input));
    return answers[Math.min(call++, answers.length - 1)] ?? new Response("x");
  };
  return {
    impl,
    urls,
    params: () => new URL(urls[0] ?? "https://nothing.was.asked/").searchParams,
  };
}

const audio = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "audio/mpeg", ...headers } });

/** The reason, or "ok" — narrows the union without a cast at every call site. */
const why = (check: { ok: true } | { ok: false; reason: ProxyErrorReason }) =>
  check.ok ? "ok" : check.reason;

test("a feed and a byte range are the same URL with different params", () => {
  const whole = new URL(proxyUrl(proxy, "https://host.example/feed.xml"));
  assert.equal(`${whole.origin}${whole.pathname}`, "https://p.workers.dev/");
  assert.equal(whole.searchParams.get("url"), "https://host.example/feed.xml");
  assert.equal(whole.searchParams.has("start"), false, "no start means the whole file");
  assert.equal(whole.searchParams.get("k"), "s3cret");

  const slice = new URL(
    proxyUrl(proxy, EPISODE, { startByte: 0, endByte: 26214399, totalBytes: 43421257 }),
  );
  assert.equal(slice.searchParams.get("start"), "0");
  assert.equal(slice.searchParams.get("end"), "26214399");
  assert.equal(slice.searchParams.get("total"), "43421257");
});

test("an empty key sends no `k` at all", () => {
  // The proxy treats an unset PROXY_KEY as no check; an empty `k` would only sit in
  // a provider's request logs saying nothing.
  const url = new URL(proxyUrl({ baseUrl: "https://p.workers.dev/", key: "" }, EPISODE));
  assert.equal(url.searchParams.has("k"), false);
});

test("a target carrying its own query survives being a query parameter", () => {
  // Enclosure URLs are full of tracking parameters, and losing one fetches nothing.
  const target = "https://host.example/ep.mp3?token=a&redirect=https://x.example/y";
  assert.equal(new URL(proxyUrl(proxy, target)).searchParams.get("url"), target);
});

test("an unset or unparseable base URL says so, instead of failing mid-import", () => {
  const broken = [
    undefined,
    { baseUrl: "", key: "s3cret" },
    { baseUrl: "   ", key: "s3cret" },
    // A hostname with no scheme is the likeliest typo, and `new URL` throws a bare
    // TypeError on it from somewhere deep inside an import.
    { baseUrl: "p.workers.dev", key: "s3cret" },
  ];
  for (const settings of broken) {
    assert.throws(
      () => proxyUrl(settings, EPISODE),
      (error: ProxyError) => error.reason === "not_configured",
      `${settings?.baseUrl ?? "(unset)"} should be refused`,
    );
  }
});

test("sliceUrls puts the total on every range, not only on the first", () => {
  const url = sliceUrls(proxy, EPISODE, 43421257);

  // Chunk one is what measured the total; chunks two onward are the ones that would
  // seam in the wrong place if the file moved underneath them.
  for (const range of [
    { startByte: 0, endByte: 26214399 },
    { startByte: 26000001, endByte: 43421256 },
  ]) {
    assert.equal(new URL(url(range)).searchParams.get("total"), "43421257");
  }

  const whole = new URL(url());
  assert.equal(whole.searchParams.has("start"), false);
  assert.equal(whole.searchParams.has("total"), false, "no offsets in flight, nothing to guard");
});

test("the total comes from a whole-file Content-Length, since Content-Range is stripped", async () => {
  const fetch = spy(audio("MP3", { "content-length": "43421257" }));
  assert.equal(await fetchTotalBytes(proxy, EPISODE, fetch.impl), 43421257);

  // A ranged request would report the slice's own length, and the header that
  // carries the total is the one the proxy deliberately removes.
  assert.equal(fetch.params().has("start"), false);
});

test("measuring the size does not download the episode", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const fetch = spy(audio(body, { "content-length": "43421257" }));

  await fetchTotalBytes(proxy, EPISODE, fetch.impl);
  assert.equal(cancelled, true, "40MB nobody wants, unless the stream is hung up on");
});

test("a length the proxy could not report is refused rather than guessed at", async () => {
  // Without it there is no chunk plan at all, and inventing one seams blind.
  const headed: Record<string, string>[] = [{}, { "content-length": "0" }, { "content-length": "lots" }];
  for (const headers of headed) {
    const fetch = spy(audio("MP3", headers));
    await assert.rejects(
      fetchTotalBytes(proxy, EPISODE, fetch.impl),
      (error: ProxyError) => error.reason === "bad_response",
      `${JSON.stringify(headers)} should be refused`,
    );
  }
});

test("the check pulls bytes through the proxy; it does not ping its root", async () => {
  const fetch = spy(audio("MP3BYTES"));
  assert.deepEqual(await checkProxy(proxy, EPISODE, fetch.impl), { ok: true });

  // A root ping presents no `?url`, so it exercises neither the key nor the content
  // type nor whether ranges survive the trip.
  const params = fetch.params();
  assert.equal(params.get("url"), EPISODE);
  assert.equal(params.get("start"), "0");
  assert.equal(params.get("end"), "1023");
  assert.equal(params.get("k"), "s3cret");
});

test("a host that ignores Range cannot turn the check into a download", async () => {
  let pulls = 0;
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetch = spy(audio(endless));

  assert.deepEqual(await checkProxy(proxy, EPISODE, fetch.impl), { ok: true });
  assert.equal(cancelled, true);
  assert.ok(pulls <= 2, `read ${pulls} chunks; one is all it takes to prove bytes flow`);
});

test("a 200 with nothing in it is not a working proxy", async () => {
  const fetch = spy(audio(""));
  assert.deepEqual(await checkProxy(proxy, EPISODE, fetch.impl), {
    ok: false,
    reason: "bad_response",
    detail: `${EPISODE} came back empty.`,
  });
});

test("the proxy's own answers become reasons the Settings screen can act on", async () => {
  // Bodies as worker/index.ts actually writes them: three separately deployed things
  // can be wrong here, and each of these has a different fix.
  const cases: [number, string, ProxyErrorReason][] = [
    [403, "bad or missing ?k", "auth"],
    [403, "host not on ALLOWED_HOSTS: host.example", "host_not_allowed"],
    [400, "malformed ?url", "bad_request"],
    [400, "refusing protocol file:", "bad_request"],
    [415, "refusing content-type text/html", "content_type"],
    [409, "file changed under us: expected 43421257 bytes, origin now 44263131", "changed"],
    [502, "could not reach host.example", "upstream"],
    [500, "worker threw", "upstream"],
  ];

  for (const [status, body, reason] of cases) {
    const result = await checkProxy(proxy, EPISODE, spy(new Response(body, { status })).impl);
    assert.equal(why(result), reason, `${status} ${body}`);
    assert.match(result.ok ? "" : result.detail, new RegExp(String(status)), "say what it answered");
  }
});

test("a proxy that is not there at all is a network failure, not a crash", async () => {
  // What a wrong base URL, an undeployed Worker and a blocked CORS request all look
  // like from in here: one opaque TypeError with nothing in it.
  const fetch: typeof globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  assert.equal(why(await checkProxy(proxy, EPISODE, fetch)), "network");
});

test("an unconfigured proxy is reported without a request going out", async () => {
  const fetch = spy(audio("MP3"));
  assert.equal(why(await checkProxy(undefined, EPISODE, fetch.impl)), "not_configured");
  assert.equal(fetch.urls.length, 0);
});
