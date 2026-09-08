# The home screen is how a Library survives

Status: accepted.

The page ships a web app manifest, an icon set and a small service worker, so it can be added to a phone's home screen and opened without browser chrome. The reason is storage, not the icon.

ADR 0008 put everything in the reader's browser and recorded the cost: `navigator.storage.persist()` was refused by every engine measured, so nothing stops a browser evicting a Library under disk pressure, and the export file is the only copy that survives it. On iOS the ceiling is sharper than that. WebKit deletes all of a site's script-writable storage — IndexedDB included — after seven days of Safari use without interaction with the site. A shelf of Transcripts that cost real money to make is exactly what that rule throws away, and someone who studies in bursts is exactly who it catches.

A home-screen web app is exempt. WebKit skips the first-party domain of an installed web app in its data-removal algorithm, and such an app counts its own days of use rather than Safari's. Installing is therefore not a convenience here, it is the difference between a Library that persists and one that does not. Chrome arrives at the same place by a different road: being installed is one of the signals that gets `persist()` granted rather than refused.

Installability itself is cheap. Chrome dropped the service-worker requirement for installing from the menu in version 108 on mobile and 112 on desktop, so a manifest with a name, a start URL, `display: standalone` and 192/512 icons is enough on its own. The worker is here for opening offline rather than for the install prompt, and it is deliberately small: runtime caching of what has already been loaded, no build-time precache manifest — which would need a plugin to learn the hashed filenames — and a hard exclusion of `/kuromoji/`, because those files are gzip _content_ and a caching layer in front of them is the second way to reproduce the hour-long hang recorded in CLAUDE.md.

The icons are generated rather than committed, by a hand-written PNG encoder over `node:zlib` supersampled four times, in the same spirit as the probe clip the Settings check uses. PNG rather than SVG for two reasons: iOS will not take an SVG for `apple-touch-icon`, and between two things that look identical the raster is the one the browser does not have to rasterise.

The known cost is real and, here, unverified. Standalone web apps on iOS have a long history of losing audio when the app is minimised or the screen locks, and of lock-screen controls that appear only sometimes; the reports span several iOS versions. It is recorded against this app as something to test on a device before recommending installation to anyone. For a tool where the transcript is on screen while you listen this matters less than it would for a podcast app — but less is not the same as not at all.
