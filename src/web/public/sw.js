/**
 * The whole of the offline story, and deliberately almost nothing.
 *
 * There is no precache manifest here, because the filenames a build produces are
 * hashed and this setup hands them to nobody — generating one would mean a plugin.
 * Everything below is runtime caching of what the reader has already loaded, which is
 * enough for the only case that matters: an installed app opening with no network.
 * What it then plays — the audio and the Transcripts — was never fetched over HTTP
 * anyway. It lives in IndexedDB, which no service worker sits in front of.
 *
 * Registered from index.html, and only in a production build. A worker holding a
 * stale copy of a module Vite has just rebuilt is a debugging session nobody asked
 * for.
 */

/* Bump this to evict everything the previous version cached; `activate` deletes any
   cache whose name is not this one. */
const CACHE = "duolistening-v1";

/* The app root, derived rather than configured, so a page served from a subdirectory
   gets the right answer: "/sw.js" → "/", "/app/sw.js" → "/app/". It doubles as the
   offline shell, because every route in this app is a hash and a hash never reaches
   the server — so one cached document answers "#/", "#/settings" and "#/r/<id>". */
const SHELL = location.pathname.replace(/[^/]*$/, "");

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Without this the shell would only be cached on the *second* visit, since the
  // navigation that installed the worker was not itself intercepted — and "add to
  // home screen, then get on a train" is precisely the case this is for.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.map((name) => name !== CACHE && caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  // A range request is a partial document; storing one under the whole URL would hand
  // the next reader a slice of a file and call it the file.
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  // Cross-origin is every API call, every proxy fetch and every episode download.
  // None of it is ours to touch, cache or even look at: it goes out untouched.
  if (url.origin !== location.origin) return;
  // Never the kuromoji dictionary. It is 17MB, downloaded only by someone who opened
  // a Japanese episode — and more to the point, those files are gzip *content* that
  // kuromoji gunzips itself. A layer between the browser and them is exactly what
  // cost an hour last time: the failure is an XHR callback that never fires and a
  // tokenizer that hangs with no error anywhere. This worker is not going to be the
  // second such layer.
  if (url.pathname.startsWith(SHELL + "kuromoji/")) return;

  // Only a plain, whole, same-origin 200 is worth keeping. `basic` excludes opaque
  // and CORS responses; a redirect or a 404 cached here would outlive the deploy that
  // caused it.
  const keep = (response) =>
    response.status === 200 && response.type === "basic" ? response.clone() : null;

  if (request.mode === "navigate") {
    // Network first: online, the reader always gets the shell the host is serving now,
    // and the copy below is only ever the fallback.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = keep(response);
          if (copy) event.waitUntil(caches.open(CACHE).then((c) => c.put(SHELL, copy)));
          return response;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit || Response.error())),
    );
    return;
  }

  // Everything else is stale-while-revalidate: answer from the cache when there is
  // something there, and replace it with whatever the network says in the background.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((hit) => {
        const fresh = fetch(request)
          .then((response) => {
            const copy = keep(response);
            if (copy) cache.put(request, copy);
            return response;
          })
          .catch(() => hit || Response.error());
        // The cached answer settles respondWith immediately, and the worker can be
        // killed the moment it does. This is what keeps it alive for the refill.
        event.waitUntil(fresh);
        return hit || fresh;
      }),
    ),
  );
});
