# TypeScript everywhere — Node backend, React SPA

Backend and frontend are both TypeScript: a Node server (Hono) plus a Vite + React SPA that the same Node process serves as static files in production — one process, one port, one container.

The deciding factor is the shared data contract. Transcript / Line / Word / Token is the only contract that really matters between the two halves, and it is also the most volatile part of the model. One language means one definition of it; any other split means maintaining two by hand forever.

Considered Python (yt-dlp is Python and could be imported rather than shelled out) and Go (single static binary). Both were rejected on the same observation: yt-dlp and ffmpeg are external binaries invoked as subprocesses in _every_ option, so no language gets a real advantage in driving them — which neutralises Python's apparent edge and dilutes Go's single-binary story, since the image has to ship those binaries regardless. TypeScript also keeps the Japanese analyzer cheap to deploy (kuromoji.js ships its own dictionary through npm; Python's fugashi needs MeCab/unidic installed on the host).

Also rejected: an SSR meta-framework (Next.js/Remix). Importing a Resource is a long-running job — minutes for a full episode — that wants a resident process, a queue, and progress streaming; that is a poor fit for a request-handler-shaped runtime.
