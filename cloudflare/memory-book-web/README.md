# momora-memory-book-web

Static-assets Cloudflare Worker that hosts the `shop.usemomora.com` web app
(memory-book-5b plan, Step 7 — see
[plans/memory-book-5b-web-preview.md](../../plans/memory-book-5b-web-preview.md)
and [docs/features/memory-book-generation.md](../../docs/features/memory-book-generation.md)).
The actual app — OTP sign-in, the family's book list, the book viewer/editor
— is `book-renderer/src/web/`, a third Vite entry (`web.html`) in the
`book-renderer` package (the same package that renders the app's preview and
drives print, per the single-renderer rule, plan §3). This Worker's only job
is to serve that build's static output with SPA fallback; it has no
Supabase/R2 access of its own.

## What this Worker does (and does not) do

- Serves `book-renderer/dist-web/` (built by `npm run build:web` in
  `book-renderer/`) via the `ASSETS` binding.
- SPA fallback: any request the asset store 404s on (a client-side route
  like `/b/<bookId>`, or `/` itself) re-serves `web.html` instead — see
  `src/index.ts`'s header comment for why this is explicit fallback code
  rather than Cloudflare's built-in `index.html`-only SPA convention.
- **Does not** talk to Supabase or R2. The web app's public config
  (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`) is baked into the JS bundle
  at BUILD time (`book-renderer/src/web/supabaseClient.ts`); this Worker has
  no secrets and no bindings besides `ASSETS`.
- **Does not** build the bundle itself. `dist-web/` must exist (via
  `book-renderer`'s `npm run build:web`, which also runs the PII bundle
  check — see `book-renderer/scripts/check-web-bundle.mjs`) before
  `wrangler dev`/`deploy` here can serve anything real.

## Why a separate build output matters here

`book-renderer`'s DEFAULT Vite config (`vite.config.ts`) sets
`publicDir: 'book-data'` — on a machine with the real export fixtures
present, that is ~1.9GB of actual family-book content (child PII) copied
into `dist/` on every build, plus the local preview (`index.html`) and print
(`print.html`) entries. This Worker's `wrangler.jsonc` points its `ASSETS`
directory at `dist-web/` specifically (the OUTPUT of the dedicated
`vite.web.config.ts`, `publicDir: false`, single `web.html` input) — never
`dist/`. Do not repoint this binding at `dist/` for convenience; that would
publish real family PII to a public domain.

## Local development

```bash
nvm use 22   # or any Node >=22, like the sibling Cloudflare workers in this repo
npm install
npm run typecheck   # tsc --noEmit
npm test             # vitest — fetch-passthrough + SPA fallback behavior, no network/Miniflare needed
```

To actually serve the app locally through this Worker (rather than
`book-renderer`'s own `npm run dev:web`, which is faster for UI iteration):

```bash
cd ../../book-renderer
npm run build:web    # builds dist-web/ and runs the PII bundle check
cd ../cloudflare/memory-book-web
npx wrangler dev
```

## Production deploy checklist (owner-gated — this task does not deploy)

1. Build the app first: `book-renderer/`'s `npm run build:web` (fails
   closed on any PII/wrong-entry violation via
   `scripts/check-web-bundle.mjs`).
2. From this directory, with Node ≥22:
   ```bash
   npm test
   npm run typecheck
   npm run deploy:dry-run
   ```
3. **Leave custom-domain DNS to Cloudflare.** The route is configured as
   `custom_domain: true` for `shop.usemomora.com` (`wrangler.jsonc`), same
   pattern as `workers/memory-viewer`'s `m.usemomora.com`. Do not manually
   add a CNAME first — an existing conflicting CNAME can block custom-domain
   provisioning.
4. Deploy: `npx wrangler deploy`.
5. Smoke-test in a browser: sign in (email OTP), confirm the book list
   loads, open a `ready` book, confirm it renders and pages, confirm an edit
   of each kind (text, image replace, focal point) persists across a reload.
   This full real-data smoke (against the canary book) is the coordinator's
   job per the plan (needs live Supabase credentials) — see
   `plans/memory-book-5b-web-preview.md` step 9.
