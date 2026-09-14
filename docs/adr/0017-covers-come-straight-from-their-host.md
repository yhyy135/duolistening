# Covers come straight from their host

Status: accepted.

A Resource now records its show's title and its cover's URL, both read from the feed at import. The cover comes from `<itunes:image>`, or from RSS's own `<image>` where that is missing, and an episode's own image wins where it has one. The shelf, the player and the lock screen load that URL directly, the way the recommendations already load Apple's artwork. Nothing is fetched through the proxy or kept in IndexedDB.

Two other shapes were weighed:

- **Storing the image at import.** Covers would work offline, and the browser would stop asking a podcast host for a picture every time the shelf is drawn without a cached copy. The price is a database version, a new store, and a blob URL per row to create and revoke.
- **Generated covers only.** No change to the data at all.

The direct URL was chosen as the smallest change that puts a show's own artwork on the shelf.

Its costs are accepted and bounded:

- **An image host learns an address when its cover loads.** It does not learn the page, because every cover is requested with no referrer.
- **Some episodes show a monogram instead of a cover.** That covers a Library opened offline, a cover moved or deleted upstream, and every episode imported before this change. The monogram is the show's first two characters in a script without word spaces, or its initials otherwise, on one of six tile colours fixed by the name.
- **Only http(s) URLs are taken from a feed**, because the value ends up as an `<img src>`.
