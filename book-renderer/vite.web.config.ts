import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dedicated Vite config for the `shop.usemomora.com` web app (memory-book-5b
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
 *
 * One narrow, DEV-SERVER-ONLY exception (owner-approved follow-up round,
 * "diagnose live"): `command === 'serve'` (i.e. `npm run dev:web` /
 * `vite dev --config vite.web.config.ts`, never `vite build`) serves
 * `book-data/` as this entry's `publicDir` too, exactly like the local
 * preview app's own `vite.config.ts` does — this is what lets the DEV-ONLY
 * `?fixture=<slug>` mode (`src/web/dev/fixture.ts`, gated behind
 * `import.meta.env.DEV`) fetch `/<slug>/manifest.json` etc. without a
 * running Supabase backend. `command === 'build'` still gets `publicDir:
 * false`, unconditionally — the PII-safety guarantee this file exists for
 * applies ONLY to the built bundle (`dist-web/`), which is what
 * `check-web-bundle.mjs` inspects; a local dev server serving a
 * gitignored, developer-machine-only data directory over `localhost` is a
 * different, already-accepted risk (the exact same one `vite.config.ts`'s
 * own dev server already carries for the preview app).
 */
export default defineConfig(({ command }) => ({
  root: __dirname,
  plugins: [react()],
  // `publicDir: false` for the build (see header comment) — dev serves
  // `book-data/` so the fixture mode can fetch a book's manifest/outline
  // locally, same as `vite.config.ts`'s preview app.
  publicDir: command === 'serve' ? 'book-data' : false,
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
}));
