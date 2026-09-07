import { defineConfig } from "vite";

// No plugin: Vite's esbuild picks up `"jsx": "react-jsx"` from tsconfig.json, which
// is all a build needs. @vitejs/plugin-react would add Fast Refresh — worth having
// only if reloading the page mid-playback starts to grate.
export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist/web", emptyOutDir: true },
  // main.ts serves the built SPA itself; in dev the two run apart and this bridges
  // them, cookies included — /media is here so <audio> can stream through the proxy.
  //
  // Anchored patterns, not the bare prefixes: Vite matches a plain string as a prefix,
  // and the root is src/web, so "/api" also caught this app's own /api.ts module and
  // proxied it to the backend instead of serving it. The page came up blank with a
  // module MIME error, which points nowhere near this line. A leading ^ makes Vite
  // read the key as a regex, and the trailing slash is what keeps api.ts out of it.
  server: {
    proxy: { "^/api/": "http://localhost:3000", "^/media/": "http://localhost:3000" },
  },
});
