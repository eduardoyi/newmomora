# momora-memory-viewer

Cloudflare Worker that serves the QR-code memory viewer printed in Momora
books (`docs/plans/memory-book.md` §7): `GET /m/:memoryId` renders a
minimal, mobile-first page that plays the memory's video/audio or shows its
photo; `GET /media/:memoryId` streams the actual bytes from the private R2
bucket, with HTTP Range support for video scrubbing.

URL shape (owner decision, V3 Phase 2): `https://m.momora.app/m/<memoryId>`.
**Public, no PIN** — "people share the book with only people they trust."
See "Privacy model" below for what that does and doesn't mean.

## Status: not deployed

Nothing here has been deployed. This README documents the exact commands
the owner runs to do so. Everything below `## Owner deploy checklist` is
for the owner to execute — this task was scoped as code + docs only.

## How it resolves a memory id to media

1. `GET /m/:memoryId` and `GET /media/:memoryId` both call
   `resolveMedia()`, which does two concurrent Supabase REST reads using
   the service-role key (bypasses RLS — there's no end-user JWT here to
   evaluate `auth.uid()` against; see "Privacy model"):
   - `memories?id=eq.<id>&select=id,memory_type,memory_date,content`
   - `memory_media?memory_id=eq.<id>&select=object_key,content_type,duration_ms,preview_object_key&order=position.asc&limit=1`
2. `src/resolve.ts`'s `resolveViewerMedia()` (pure function, unit tested)
   combines those two rows into a `{ kind, objectKey, contentType, ... }`
   or `null`. It 404s (returns `null`) whenever:
   - the memory id doesn't exist,
   - the memory has no `memory_media` row,
   - `memory_type` is `text_illustration`/`text_only` (no QR page in the
     book pipeline for those — see memory-book.md §7, QR pages exist for
     video/audio/photo memories only),
   - the asset's `content_type` isn't one this worker knows how to render.
3. For an image whose `content_type` is HEIC/HEIF, it substitutes the
   asset's `preview_object_key` (an already-generated ≤1280px JPEG, see
   `memory_media.preview_object_key`'s schema comment in
   `docs/TECH_SPEC.md`) when one exists, because most non-Apple/non-Safari
   browsers can't decode HEIC inline. See "What's stubbed" for the residual
   case.

**One memory → one media asset, deliberately.** `memory_media` supports up
to 10 ordered assets per `media` memory (photo/video carousels), but this
worker only ever serves position 0 — the same asset `memories.media_key`
already denormalizes as "the" media for that memory. A book's QR page is
one printed photo/video/audio block per memory; there's no UI for "scan to
see asset 3 of 4". If that ever needs to change, `fetchPrimaryMediaAsset`
in `src/supabase.ts` is the one place to touch (drop `limit=1`, add an
asset index to the URL).

### Key resolution: why the DB lookup

Object keys are shaped `{userId}/memories/{memoryId}/media...` (see
`supabase/functions/_shared/storage-keys.ts`), i.e. you cannot derive the
key from `memoryId` alone — the owning `userId` isn't recoverable from the
memory id, and multi-asset memories don't have a fixed suffix either. This
worker therefore does exactly what the task brief anticipated: a
server-side Supabase REST lookup using a service-role key held as a Worker
secret, never hardcoded (see "Secrets").

### Why key conventions are copied, not imported

`src/resolve.ts`'s content-type allow-lists mirror
`supabase/functions/_shared/storage-keys.ts`'s `MEMORY_MEDIA_CONTENT_TYPES`
by value, not by import — this Worker is a separate deploy unit (Deno Edge
Function vs. Cloudflare Worker, different module resolution, different
repo-relative path conventions) and every other Worker in this repo
(`cloudflare/momora-export-worker`, `cloudflare/memory-illustration-worker`)
follows the same "copy, keep a comment pointing at the source of truth"
pattern rather than reaching across a runtime boundary.

## Why stream through the Worker (not a presigned R2 GET)

The task brief asked me to justify this. Two viable designs:

1. **Presigned S3-style GET** (what `supabase/functions/_shared/r2.ts`
   does for Supabase Edge Functions, since Deno Deploy has no native R2
   binding) — mint a temporary signed URL and redirect the browser to it.
2. **Native R2 binding, streamed through the Worker** (what
   `cloudflare/momora-export-worker` already does for its zip export) —
   the Worker itself proxies the bytes.

This worker uses (2):

- **Range support is first-class, not bolted on.** `R2Bucket.get(key, {
  range })` accepts `{offset, length}` / `{offset}` / `{suffix}` directly
  (see `src/range.ts`'s header comment and
  <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2range>)
  and R2 does the clamping/validation against the real object size,
  reporting back the served range on `R2ObjectBody.range`. No extra
  library, no AWS SigV4 dependency, no separate HEAD-for-size round trip.
  Video scrubbing (seeking) depends on the server honoring `Range`
  correctly; a presigned GET *can* also support Range (S3-compatible APIs
  pass Range through), but the Worker would still need to inspect the
  request to decide *whether* to presign a ranged URL, and video players
  behave more predictably against a stable same-origin URL than a
  URL that changes (a fresh presigned URL, and therefore a fresh
  `<video src>`) on every page load.
- **No bucket URL ever leaves the Worker's control.** A presigned URL is
  itself a bearer credential with its own expiry — if the client shares it
  (long-press → copy link, or an aggressive CDN/proxy caching it) it works
  until expiry independent of anything else changing. Streaming through
  the Worker means the *only* thing that ever reaches the client is
  `/media/:memoryId`, which re-checks the DB (and therefore honors a
  future revocation — see "Privacy model") on every request.
- **A binding already exists for exactly this bucket.** `momora-export-worker`
  binds `MEDIA` → `momora-prod` R2 bucket and streams zip entries straight
  from `object.body`. This worker follows the identical binding name/bucket
  convention (see `wrangler.jsonc`) rather than introducing a second access
  pattern (`@aws-sdk/client-s3` + credentials) for the same bucket.

Trade-off acknowledged: every byte transits the Worker's CPU/egress instead
of a direct client→R2 connection, and Workers have a wall-clock/CPU budget
per request. For book QR pages — short clips, single photos, short voice
memos, viewed by one family member at a time, not a video-hosting product —
this is the right trade. If usage patterns ever demand it (long videos,
high concurrent viewership), presigning becomes the better choice; nothing
else in this design blocks that migration later (`resolveMedia()` already
isolates "what to serve" from "how to serve it").

## Design notes (the page itself)

- **Inline CSS, no build step, no external requests except the media
  itself.** `src/page.ts` renders complete HTML strings; `src/theme.ts`
  copies (not imports — see book-renderer/src/theme.ts's own header
  comment for the same rationale) the Momora palette as constants.
- **System fonts, not the app's Newsreader/Jakarta webfonts.** This page is
  the first thing a family member sees after scanning a printed QR code —
  often on cellular signal, sometimes a grandparent's older phone. A
  webfont round-trip is a bad trade for a page that's viewed once. See
  `src/theme.ts`'s `fonts` comment.
- **`Cache-Control: no-store` on every response.** Every response here is
  either a specific family's photo/video/caption or the generic 404 —
  never appropriate to cache at a shared/CDN layer.
- **The 404 page never distinguishes *why*.** Bad id, deleted memory,
  wrong memory type, missing R2 object — all render the same
  `renderNotFoundPage()`. See "Privacy model".

## Privacy model

Per the owner decision this task was briefed with: QR links are public, no
PIN. `memoryId` is a UUID — not brute-forceable — so "public" here means
"anyone who has the exact 36-character link can view it," the same
unguessable-link trust model `docs/plans/memory-book.md` §7 already
describes for the (differently-shaped) token design it sketched earlier.
**Open question for the owner** (flagged, not resolved, by this task): that
doc's data-model sketch (§8) proposed a dedicated `media_share_tokens`
table — `QR token → memory/media ref, book id, revocation` — specifically
so a lost/stolen book's QR pages could be revoked without touching the
underlying memory. Encoding the raw `memoryId` in the URL (this task's
brief) instead means there is **no revocation lever** short of deleting the
memory itself. If revocability matters before this ships, the fix is
small — swap `memoryId` in the URL for a dedicated token resolved through a
new `media_share_tokens`-shaped table, with `resolveMedia()` in
`src/index.ts` as the only call site that would need to change — but it is
a real product decision, not something to silently pick here.

## What's stubbed / not handled

- **HEIC/HEIF with no preview.** `memory_media.preview_object_key` is
  null for legacy assets, non-image assets, and any preview upload that
  failed (fail-open, per that column's existing convention across the
  codebase). In that case this worker serves the original HEIC bytes with
  `content-type: image/heic`, which most non-Safari/non-Apple browsers
  cannot decode inline. Fix would be either an on-the-fly transcode via a
  Cloudflare Images binding (the sibling `memory-illustration-worker`
  already uses `env.IMAGES` for a similar re-encode) or backfilling
  `preview_object_key` for older rows. Not implemented here — scope call.
- **No book-scoped revocation** — see "Privacy model" above.
- **No rate limiting / bot protection** on `/m/:id` or `/media/:id`. A
  script could enumerate nothing useful (ids aren't sequential), but could
  still hammer a single known id's `/media/` route for R2 egress cost. Not
  addressed here — Cloudflare's zone-level WAF/rate-limiting rules
  (configured outside this repo, in the dashboard or `wrangler` zone
  config) are the natural place if it becomes a problem.
- **No analytics/observability beyond Cloudflare's built-in
  `observability.enabled`.** No "was this QR code ever scanned" signal is
  wired up. Worth asking the owner whether that's wanted before V4/V5.
- **Multi-asset carousels always show asset 0** — see "One memory → one
  media asset" above.

## Local development

```bash
nvm use 22   # or any Node >=22; repo root .nvmrc pins 20, this worker's package.json requires >=22 like the sibling workers
npm install
cp .dev.vars.example .dev.vars   # fill in a real SUPABASE_SERVICE_ROLE_KEY for local testing against a real project
npm test           # vitest — routing, range parsing, memory resolution, HTML rendering (49 tests, no network/Miniflare needed)
npm run typecheck  # tsc --noEmit
npx wrangler dev    # runs the worker locally against real Supabase + R2 (needs .dev.vars and network)
```

`npm test` needs no Cloudflare account, R2, or live Supabase project —
every test mocks `fetch` and the `MEDIA` R2 binding (same pattern as
`cloudflare/momora-export-worker/test/index.test.ts`).

## Secrets

| Secret | Where it's used | Notes |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | `src/supabase.ts` | Server-only. Bypasses RLS — this worker IS the authorization boundary for reads (see "Privacy model"). **Never** commit it; set via `wrangler secret put`. |

`SUPABASE_URL` is a plain `vars` entry in `wrangler.jsonc` (not secret — same
project ref already public in every other Worker's `wrangler.jsonc` in this
repo). No `SUPABASE_ANON_KEY` is needed: unlike
`cloudflare/momora-export-worker`, there is no end-user bearer token to
verify — this worker is intentionally unauthenticated.

## Owner deploy checklist

Everything below requires Cloudflare account access and is **not run by
this task**.

1. **Confirm the `momora-prod` R2 bucket is reachable from a new Worker in
   this account.** It already is (both existing Workers bind it), so this
   is just confirming the account/zone this Worker deploys into is the
   same one.

2. **Set the secret** (from `workers/memory-viewer/`):

   ```bash
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   # paste the Momora project's service_role key when prompted
   ```

3. **Dry-run to confirm the config resolves** (no deploy, no charges):

   ```bash
   npm run deploy:dry-run
   ```

4. **Deploy:**

   ```bash
   npx wrangler deploy
   ```

5. **DNS — read before step 4 if you haven't decided this yet.** This
   worker's `wrangler.jsonc` requests a Cloudflare **custom domain** route
   for `m.momora.app`. That domain does not appear anywhere else in this
   codebase — every other user-facing Momora domain in this repo is
   `usemomora.com` (see `app.json`'s `applinks:usemomora.com`,
   `docs/features/family-sharing.md`, etc.). Before `wrangler deploy` can
   attach the route:
   - `momora.app` (or at minimum the `m.momora.app` subdomain) must be
     registered and its DNS must be on this Cloudflare account/zone.
   - **Open question for the owner:** is `momora.app` an intentional new
     domain for this feature, or should the QR viewer live under
     `usemomora.com` instead (e.g. `usemomora.com/m/:memoryId`) to match
     every other public-facing link in the product? If the latter, change
     `wrangler.jsonc`'s `routes` entry accordingly — no other code changes
     needed, since the worker doesn't hardcode its own hostname.
   - If you deploy without DNS ready, `wrangler deploy` will fail at the
     route-attachment step (config itself validates fine — verified via
     `wrangler deploy --dry-run` during this task) or the Worker will
     deploy to its default `*.workers.dev` URL, whichever Wrangler prefers
     that day; either way, re-run `wrangler deploy` once DNS is in place.

6. **Staging** (`env.staging` in `wrangler.jsonc`) has placeholder values
   (`REPLACE_WITH_STAGING_...`) exactly like the sibling workers' staging
   blocks — fill those in only if a staging Supabase project / R2 bucket
   exists for this to point at; otherwise the block is inert and can stay
   as-is.

7. **Smoke test** once deployed, using a real `memoryId` for a `media` or
   `audio` memory in the target Supabase project:

   ```bash
   curl -i https://m.momora.app/m/<a-real-memory-id>
   curl -i https://m.momora.app/media/<a-real-memory-id>
   curl -i -H 'Range: bytes=0-999' https://m.momora.app/media/<a-real-memory-id>   # expect 206
   curl -i https://m.momora.app/m/00000000-0000-1000-8000-000000000000            # expect 404
   ```
