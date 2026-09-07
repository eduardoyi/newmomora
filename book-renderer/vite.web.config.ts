import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dedicated Vite config for the `book.usemomora.com` web app (memory-book-5b
 * plan, Design Decision 2 / Step 7) — PII-safe BY CONSTRUCTION, not by
 * convention. The default `vite.config.ts` sets `publicDir: 'book-data'`
 * (1.9GB of real exported family books — child PII — copied verbatim into
 * `dist/` on every build) and builds BOTH the preview (`index.html`) and
 * print (`print.html`) entries. None of that may ever reach a public bundle:
 *
 *   - `publicDir: false` — no static passthrough directory at all, so
 *     `book-data/` can never be copied into this build's output regardless
 *     of what a future edit to the main config does.
 *   - `rollupOptions.input` lists ONLY `web.html` — `index.html`/
 *     `print.html` (and anything a future third entry might add) are never
 *     reachable from this config.
 *   - `build.outDir: 'dist-web'` — its own directory, never `dist/` (the
 *     main config's output, which DOES contain book-data as a build
 *     artifact when run locally with a populated `book-data/`).
 *
 * `scripts/check-web-bundle.mjs` (`npm run build:web` runs it as a required
 * follow-up, not optional) asserts all of this held for a REAL build output,
 * not just this config's intent — see that script's own header comment for
 * why a config-level guarantee alone isn't trusted for something this
 * consequential.
 *
 * Deliberately a SEPARATE file, not a `mode`-gated branch inside
 * `vite.config.ts`: a single shared config object that conditionally adds
 * `publicDir`/`input` based on `process.env.MODE` (or similar) is exactly
 * the kind of "one wrong branch away from shipping PII" shape this step
 * exists to rule out. Two files can't accidentally merge their behavior.
 */
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // No publicDir passthrough of any kind for this entry — see header comment.
  publicDir: false,
  server: {
    fs: {
      allow: ['..', '.'],
    },
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        web: resolve(__dirname, 'web.html'),
      },
    },
  },
});
