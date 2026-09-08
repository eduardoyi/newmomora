import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dedicated Vite config for the render worker's Docker image build
 * (memory-book-5c plan, Step 3 — `render/memory-book-renderer/Dockerfile`).
 * PII-safe BY CONSTRUCTION, same posture as `vite.web.config.ts` (see that
 * file's own header comment for the full reasoning — this is a deliberate,
 * near-identical sibling, not a shared parameterized config, for the same
 * "one wrong branch away from shipping PII" reason that file documents):
 *
 *   - `publicDir: false` — the default `vite.config.ts`'s `publicDir:
 *     'book-data'` would copy 1.9GB of real exported family books (child
 *     PII) into this build's output; this config can never do that
 *     regardless of what a future edit to the main config does. It ALSO
 *     doesn't matter here that the render worker's own Docker build context
 *     (a separate `--build-context` naming this whole `book-renderer/`
 *     directory — see `render/memory-book-renderer/Dockerfile`) already
 *     excludes `book-data/` via `.dockerignore` — this is defense in depth,
 *     not the only guard.
 *   - `rollupOptions.input` lists ONLY `print.html` — `index.html` (the
 *     interactive preview app, irrelevant to a headless render worker) is
 *     never reachable from this config.
 *   - `build.outDir: 'dist-print'` — its own directory, never `dist/` (the
 *     main config's output, which DOES contain book-data as a build
 *     artifact when run locally with a populated `book-data/`) or
 *     `dist-web/` (the other dedicated config's own output).
 *
 * `react()` stays enabled (unlike a config that only needed to ship plain
 * data) — `print.html`'s entry (`src/print/main.tsx`) renders JSX
 * (`PrintApp`), so the plugin is required for that to build at all; the web
 * app's `vite.web.config.ts` needs it for the same reason.
 */
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist-print',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        print: resolve(__dirname, 'print.html'),
      },
    },
  },
});
