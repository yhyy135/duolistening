import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "./index.ts";

/** A fetch that records what it was asked for and answers with what it was told to. */
function fakeFetch(answer: Response): typeof globalThis.fetch & { calls: Request[] } {
  const calls: Request[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(String(input), init));
    return answer;
  }) as typeof globalThis.fetch & { calls: Request[] };
  impl.calls = calls;
  return impl;
}

const audio = (status: number, extra: Record<string, string> = {}) =>
  new Response("MP3BYTES", {
    status,
    headers: { "content-type": "audio/mpeg", ...extra },
  });

const ask = (query: string) => new Request(`https://w.example/?${query}`);

test("a byte range comes back as a whole file, not a 206", async () => {
  const upstream = fakeFetch(
    audio(206, { "content-range": "bytes 0-7/999999", "content-length": "8" }),
  );
  const response = await handle(ask("url=https://host.example/ep.mp3&start=0&end=7"), upstream);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("content-length"), "8");
  assert.equal(await response.text(), "MP3BYTES");
});

test("start and end become a Range header; no start asks for the whole file", async () => {
  const sliced = fakeFetch(audio(206));
  await handle(ask("url=https://host.example/ep.mp3&start=100&end=200"), sliced);
  assert.equal(sliced.calls[0]?.headers.get("range"), "bytes=100-200");

  const whole = fakeFetch(audio(200));
  await handle(ask("url=https://host.example/feed.xml"), whole);
  assert.equal(whole.calls[0]?.headers.get("range"), null);
});

test("an open-ended range omits the end", async () => {
  const upstream = fakeFetch(audio(206));
  await handle(ask("url=https://host.example/ep.mp3&start=100"), upstream);
  assert.equal(upstream.calls[0]?.headers.get("range"), "bytes=100-");
});

test("redirects are followed here, because Groq's url mode will not follow them", async () => {
  const upstream = fakeFetch(audio(200));
  await handle(ask("url=https://host.example/ep.mp3"), upstream);
  assert.equal(upstream.calls[0]?.redirect, "follow");
});

test("the origin always sees one User-Agent, so ad splicing cannot vary the file", async () => {
  const upstream = fakeFetch(audio(206));
  await handle(ask("url=https://host.example/ep.mp3&start=0"), upstream);
  assert.equal(upstream.calls[0]?.headers.get("user-agent"), "duolistening/1.0");
});

test("a total that no longer matches is a 409, not a misaligned seam", async () => {
  const moved = fakeFetch(audio(206, { "content-range": "bytes 26000001-44263130/44263131" }));
  const response = await handle(
    ask("url=https://host.example/ep.mp3&start=26000001&total=43421257"),
    moved,
  );
  assert.equal(response.status, 409);

  const same = fakeFetch(audio(206, { "content-range": "bytes 0-7/43421257" }));
  const ok = await handle(ask("url=https://host.example/ep.mp3&start=0&total=43421257"), same);
  assert.equal(ok.status, 200);
});

test("every answer carries CORS, errors included", async () => {
  for (const query of ["", "url=https://host.example/ep.mp3"]) {
    const response = await handle(ask(query), fakeFetch(audio(200)));
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
});

test("refuses to be a general web proxy", async () => {
  const html = fakeFetch(
    new Response("<h1>hi</h1>", { headers: { "content-type": "text/html" } }),
  );
  const response = await handle(ask("url=https://host.example/page"), html);
  assert.equal(response.status, 415);
});

test("no ALLOWED_HOSTS means no list, not an empty one", async () => {
  for (const env of [{}, { ALLOWED_HOSTS: "" }, { ALLOWED_HOSTS: "  ,  " }]) {
    const response = await handle(
      ask("url=https://anywhere.example/ep.mp3"),
      fakeFetch(audio(200)),
      env,
    );
    assert.equal(response.status, 200);
  }
});

test("ALLOWED_HOSTS covers subdomains but not lookalikes", async () => {
  const env = { ALLOWED_HOSTS: "archive.org, bbci.co.uk" };
  const pass = ["archive.org", "ia600103.us.archive.org", "podcasts.files.bbci.co.uk"];
  const fail = ["evil-archive.org", "archive.org.evil.com", "elsewhere.example"];

  for (const host of pass) {
    const response = await handle(
      ask(`url=https://${host}/ep.mp3`),
      fakeFetch(audio(200)),
      env,
    );
    assert.equal(response.status, 200, `${host} should pass`);
  }
  for (const host of fail) {
    const response = await handle(
      ask(`url=https://${host}/ep.mp3`),
      fakeFetch(audio(200)),
      env,
    );
    assert.equal(response.status, 403, `${host} should be refused`);
  }
});

test("no PROXY_KEY means no key check", async () => {
  const response = await handle(ask("url=https://host.example/ep.mp3"), fakeFetch(audio(200)));
  assert.equal(response.status, 200);
});

test("PROXY_KEY gates every request, and a wrong key never reaches the origin", async () => {
  const env = { PROXY_KEY: "s3cret" };

  const right = await handle(
    ask("url=https://host.example/ep.mp3&k=s3cret"),
    fakeFetch(audio(200)),
    env,
  );
  assert.equal(right.status, 200);

  for (const k of ["", "&k=", "&k=wrong", "&k=s3cre", "&k=s3crett", "&k=S3CRET"]) {
    const upstream = fakeFetch(audio(200));
    const response = await handle(ask(`url=https://host.example/ep.mp3${k}`), upstream, env);
    assert.equal(response.status, 403, `${k || "(no k)"} should be refused`);
    assert.equal(upstream.calls.length, 0, `${k || "(no k)"} should not be fetched`);
  }
});

test("the key is checked before the url is even parsed", async () => {
  const response = await handle(ask("url=file:///etc/passwd"), fakeFetch(audio(200)), {
    PROXY_KEY: "s3cret",
  });
  assert.equal(response.status, 403);
});

test("refuses a protocol that is not http", async () => {
  const response = await handle(ask("url=file:///etc/passwd"), fakeFetch(audio(200)));
  assert.equal(response.status, 400);
});

test("an upstream failure is a 502, not a crash", async () => {
  const response = await handle(
    ask("url=https://host.example/ep.mp3"),
    fakeFetch(new Response("nope", { status: 404, headers: { "content-type": "audio/mpeg" } })),
  );
  assert.equal(response.status, 502);
});

test("a preflight is answered without touching the origin", async () => {
  const upstream = fakeFetch(audio(200));
  const response = await handle(
    new Request("https://w.example/?url=https://host.example/ep.mp3", { method: "OPTIONS" }),
    upstream,
  );
  assert.equal(response.status, 204);
  assert.equal(upstream.calls.length, 0);
});
