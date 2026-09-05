# One storage seam, no relational database

All persisted state — settings, Resource metadata, Transcripts, and audio — goes through a single `Storage` interface with two adapters: local filesystem and S3. There is no database. Documents are JSON objects, the shelf listing is one `resources/index.json`, and audio is a blob alongside it.

The deciding constraint is that S3 support has to be real. If metadata lived in SQLite while only audio went to S3, an instance would still need a persistent volume and S3 mode would solve half the problem. Nothing here needs relational queries: single user, tens to hundreds of Resources, and the most complex read is "list what I have imported."

The most valuable operation on the seam is `playbackUrl(key)`. The local adapter returns a route on our own server with HTTP Range support; the S3 adapter returns a presigned URL so the browser streams straight from S3 without spending our bandwidth. Callers only know they were handed a playable URL. Delete the seam and that branch reappears in the HTTP layer, in the player, and in the frontend's URL construction — which is what makes it worth having.

Known ceiling: concurrent writes to `resources/index.json` are serialised by an in-process mutex. That holds for one process serving one user and breaks under multi-instance deployment.
