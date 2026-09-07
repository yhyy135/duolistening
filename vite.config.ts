import { defineConfig } from "vite";

// No plugin: Vite's esbuild picks up `"jsx": "react-jsx"` from tsconfig.json, which
// is all a build needs. @vitejs/plugin-react would add Fast Refresh — worth having
// only if reloading the page mid-playback starts to grate.
export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist/web", emptyOutDir: true },
  // No dev proxy any more: there is no /api or /media to reach, because ADR 0008 left
  // nothing on a server to ask.
  plugins: [
    {
      name: "kuromoji-dict-is-content-not-encoding",
      configureServer(server) {
        // The dictionary files are gzip *content* — kuromoji gunzips them itself —
        // not a gzip transfer encoding. A static server that reads `.gz` and announces
        // `Content-Encoding: gzip` makes the browser decode them first, and kuromoji
        // then hands already-plain bytes to its gunzip. That throws inside an XHR
        // onload handler, so the callback never fires and the tokenizer hangs with no
        // error anywhere — an hour to find, one header to fix.
        //
        // Whatever serves dist/web in production needs the same, which is the one
        // deployment requirement this app has beyond uploading files.
        server.middlewares.use((request, response, next) => {
          if (request.url?.startsWith("/kuromoji/dict/")) {
            const setHeader = response.setHeader.bind(response);
            response.setHeader = (name, value) =>
              /^content-encoding$/i.test(name) ? response : setHeader(name, value);
          }
          next();
        });
      },
    },
  ],
});
