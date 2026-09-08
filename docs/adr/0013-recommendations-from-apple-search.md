# Recommendations from Apple's search endpoint

Status: accepted.

The Library shows a shelf of recommended podcasts in the language the reader is studying, fetched once per calendar day from `itunes.apple.com/search` and cached in `localStorage`. Nothing else on the page reaches Apple, and typing a search is the only thing that goes past the cache.

Apple's own charts were the obvious source and are unusable. `rss.marketingtools.apple.com` sends no CORS headers at all — measured from a page as `TypeError: Failed to fetch` — so the ranked list every podcast app shows cannot be read from a browser without a server in front of it. The search endpoint answers cross-origin, needs no key and no account, and hands back the `feedUrl` an import needs, which is the whole reason it can stand in for the charts at all.

For a language learner the substitution is arguably an improvement. A storefront's top chart is mostly true crime and politics in the local language; a search for that language's own learner terms in its own storefront returns shows made for exactly this purpose. The language-to-market table in `itunes.ts` is the entire configuration: a storefront country, a term written in the target language, and one learner-facing term aimed at the US storefront, which carries the richest "learn X" catalogue.

Two of Apple's own parameters do not behave as documented, and the code works around both. `genreId` is ignored — passing 1469 still returns results from other genres — so the Language Learning filter is applied here, over the `genreIds` array each result carries, and it sorts rather than filters so that a good show outside the genre is not hidden. And the endpoint is documented at roughly twenty calls a minute, which makes the day cache a correctness measure rather than a courtesy: two requests per language per day leaves the budget for searches.

Podcast Index was the alternative worth taking seriously, and it was rejected on architecture rather than on quality. Its API wants a key and a secret combined into an HMAC header, and this page has no server to hold a secret. Compiling one into the bundle would hand it to everyone who loads the page, which is the exact mistake ADR 0009 avoids for the proxy by keeping its key in each reader's own settings. Apple's endpoint needs no credential at all, so there is nothing to leak.

Known ceilings. This is the first thing in the app that talks to a third party without going through the proxy, so a reader's browser tells Apple which language they are studying, once a day. Cover art is loaded straight from Apple's CDN by an `<img>` tag, which needs neither CORS nor a key but leaves a blank square offline. And an empty answer is deliberately not cached, or one bad afternoon would blank the section until midnight.
