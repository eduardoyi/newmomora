# Memory Book 5b — Web preview + v1 edit surface (book.usemomora.com)

Hardened 2026-09-07: 3 adversarial review rounds (Sonnet ×2, Fable ×1);
all substantive findings incorporated.

## Goal

A parent can open book.usemomora.com, sign in with their Momora account,
see their family's generated books, page through a book rendered by the
real renderer, and make the v1 edits (text overrides, image replace,
reposition-in-crop) — with edits persisted and applied on every render.
Print (5c) later consumes the same overrides.

## Context (verified against the codebase)

- **Single-renderer rule** (docs/plans/memory-book.md §3): the book is JSON;
  `book-renderer/` React components render preview AND print. 5b must reuse
  them, never fork.
- `book-renderer/` is a Vite app with two entries: `index.html` (local
  preview app) and `print.html` (Puppeteer target). `vite.config.ts` sets
  `publicDir: 'book-data'` — **1.9GB of real exported family books (child
  PII)** that Vite copies into `dist/` on every build.
- **Production book documents**: `memory_books.book_document` =
  `{ outline, manifest }`; manifest asset `file` values are raw R2 object
  keys in the private `momora-prod` bucket. Verified on canary row
  `687bb3d1-…`: 161 memories, 234 assets, `originalWidth` on photos,
  share tokens on video memories; `fitBook` + audit pass (0 violations).
- `memory_books` RLS: family-membership SELECT, owner/manager INSERT,
  **no client UPDATE/DELETE at all** (grant-level).
- **`supabase/functions/get-media-url/` already exists in production**:
  authenticates non-anonymous users, resolves per-key family ownership
  (`resolveStorageKeyFamilyIds` handles every key shape a book manifest
  contains), batch-presigns (`createPresignedGetUrls`,
  `R2_URL_EXPIRY.download` = 3600s), CORS `*`. The mobile app consumes it
  through a 50-key coalescer with a 50-minute cache
  (`src/services/media.ts`). Family members therefore ALREADY receive 1h
  presigned URLs for these exact objects — this is the governing
  precedent for authenticated asset access, not `workers/memory-viewer`
  (which streams because its audience is anonymous bearer-link holders).
- Auth idiom: `_shared/auth.ts` `getAuthenticatedNonAnonymousUser` +
  `_shared/family-access.ts` `getCallerFamilyRole` (used by
  `generate-memory-book` and `get-media-url`). Anonymous auth sessions
  exist in this project — functions must use the NonAnonymous variant.
- Edit-surface v1 scope (plan §V5, 2026-08-31): text = dedication,
  closing lines, section titles (eyebrows overridable), cover +
  back-cover text, captions as book-local overrides; images = replace +
  reposition. Deletes/re-layout v2.
- `memory_media` stores `aspect_ratio` but NO pixel dimensions; real
  `originalWidth/Height` exist only where measured from bytes
  (worker `dimensions.ts` ranged-read pattern). Fitter trust gates
  (panorama/full-bleed minimums) fail closed on missing dimensions.
- Repo rules: schema/API change ⇒ migration + regenerated types +
  TECH_SPEC + feature doc in same change. Node 20 repo / Node 22 worker
  tooling. Deploys owner-gated. No memory content in logs (PII).
- Stale comment to fix in passing: `book-renderer/src/model/types.ts`
  ~line 10 claims layout is "never computed in the browser" — browser-side
  fitting is actual practice (preview + print entries) and 5b enshrines it.

## Design decisions

1. **App shell = third Vite entry in `book-renderer`** (`web.html` +
   `src/web/`), NOT Next.js. **Deviates from the Next.js note in
   docs/plans/memory-book.md §V5 — owner has been asked to sign off; the
   plan-doc bullet is updated in step 8.** Rationale: no SSR need,
   one framework, renderer shared by construction. Session storage:
   supabase-js localStorage (not httpOnly cookies) — acceptable for a
   first-party, no-third-party-script surface; revisit before 5c payment
   pages.
2. **Dedicated web build, PII-safe by construction**: a separate Vite
   config/mode for the web entry with **`publicDir: false`**, only the
   `web.html` input, own `outDir` (`dist-web/`). The hosting worker's
   assets directory is `dist-web/` and nothing else. This is a named
   step with a verification check (built bundle contains no book-data,
   no index.html/print.html), because the default config would ship
   1.9GB of child PII to a public URL.
3. **Asset access = the existing `get-media-url` function.** The web app
   reuses the mobile app's batched coalescer pattern (~5 calls for ~234
   keys at MAX_KEYS=50, or raise MAX_KEYS modestly), 1h expiry, 50-min
   client cache — identical exposure to what family members already have
   in the app. No new presigning surface; `workers/memory-viewer`'s
   streaming stays what it is: the anonymous-audience design. On image
   load error, re-request URLs through the coalescer (no status-code
   check — `<img>` errors don't expose one).
4. **Edits table `memory_book_edits`, written ONLY by an Edge Function**
   (service-role), client SELECT-only via family-membership RLS —
   resolving the round-3 trust contradiction: clients never write the
   jsonb directly, so server-measured dimensions and server-resolved
   keys in it are trustworthy for 5c's service-role print path.
   Columns: `book_id` PK/FK→memory_books cascade, `family_id` FK
   (denormalized for RLS SELECT), `edits jsonb not null default '{}'`,
   `updated_by`, timestamps. Concurrency: single-row last-write-wins is
   accepted for v1 (stated; per-field merge is v2).
5. **Edge Function `memory-book-edits`** (new), ops:
   - `save_edit`: auth (NonAnonymous + owner/manager role on the book's
     family), validates the target edit, and for image edits resolves
     `mediaId` server-side: verifies family ownership of the media row,
     resolves preview + original object keys, measures
     `originalWidth/Height` from the ORIGINAL via ranged GET +
     image-size (worker `dimensions.ts` semantics: absent, never
     fabricated), then merges into the edits row. The stored edit is
     self-contained: `{ slot | 'cover', mediaId, file, originalFile,
     aspectRatio, originalWidth?, originalHeight? }`.
   - `picker_pool`: paginated (cursor by date, page ≤50) in-scope photo
     list — memory id, media id, preview key, date, aspect_ratio,
     already-in-book flag. KEYS ONLY; the client presigns visible thumbs
     through the get-media-url coalescer. For `everything`-scope books
     the pagination is the boundedness guarantee.
   Deno tests per function conventions; PII rule: log ids only.
6. **Edit shapes and keying** (stable, non-positional):
   - `text`: `{ target: 'dedication' | 'closing' | 'backCover' |
     'sectionTitle:<elementId>' | 'eyebrow:<elementId>' |
     'caption:<memoryId>', value }`
   - `imageReplace` / `coverPhoto`: as stored by save_edit above; slots
     keyed `<memoryId>:<mediaId-or-assetFileKey>` — NEVER by array
     index (positional keys silently mis-target after regeneration;
     a missing stable key orphans cleanly).
   - `focalPoint`: `{ slot: '<memoryId>:<mediaFileKey>', x, y }` (0–1).
   **Eligibility, explicit**: photo slots rendered via
   `PhotoSlotContent` (PhotoTile pages, FullBleed, PanoramaSpread) +
   the cover photo (its own edit type through cover params). AI
   illustrations and illustrated portraits are NOT editable in v1.
7. **Where overrides apply — decided now, not at implementation**:
   - TEXT edits apply **post-fit** (to fitted slots/params): a caption
     typo fix can never re-paginate the book. 5c applies them at the
     same stage — parity by construction.
   - IMAGE edits (replace/cover) apply **pre-fit** (manifest/outline
     substitution): reflow is real and HONEST — the UI warns before a
     swap whose measured dimensions fall below the target slot's
     trust gate ("this photo is too small for this full-page layout —
     the page will re-arrange"); never fabricate dimensions.
   - `applyBookEdits` (`book-renderer/src/model/edits.ts`) is pure and
     runtime-agnostic (all I/O already done at save time), exposes
     `applyPreFit(outline, manifest, edits)` and
     `applyPostFit(document, edits)`, returns `skipped` orphans for UI.
8. **Pluggable asset resolution**: `assetUrl` gains a provider (default =
   current static behavior; print/preview entries untouched, snapshots
   unchanged). Module-level setter under a documented constraint: the
   web app renders ONE book's templates at a time; the book LIST uses
   plain thumbnails via the coalescer, never photo templates; provider
   swapped on book open, stale in-flight fetches guarded by book id.
9. **Focal-point template wiring**: optional focal point on
   `PhotoSlotContent`; `objectPosition` wired in PhotoTile, FullBleed,
   PanoramaSpread (+ the cover photo via its params path). Absent =
   byte-identical current behavior.

## Steps

1. **Migration + types + docs**: `memory_book_edits` per Decision 4
   (client SELECT-only; all writes service-role). Functional psql RLS
   tests (cross-family denial; client UPDATE denied at grant level).
   Regenerate `src/types/database.ts`; TECH_SPEC section; extend
   docs/features/memory-book-generation.md (edits contract, save_edit
   flow, how 5c consumes edits; stale types.ts comment fixed).
2. **Edge Function `memory-book-edits`** per Decision 5, with Deno tests
   (auth variants incl. anonymous-session rejection, cross-family
   mediaId rejection, dimension measurement fallback, pagination).
3. **Pluggable asset resolution** per Decision 8 (loader.ts + call-site
   audit); snapshot suite must not change.
4. **`applyBookEdits`** per Decision 7: pure pre-fit/post-fit split;
   unit tests incl. orphaned stable keys, idempotency, text-post-fit
   no-reflow property (same page count before/after text edits), and
   image-pre-fit substitution incl. dimension-driven demotion.
5. **Focal-point wiring** per Decision 9, with style-output unit tests.
6. **Web app** (`book-renderer/src/web/`, entry `web.html`):
   - OTP auth (supabase-js, email code), session persistence.
   - Book list via RLS (status chips; poll generating rows; plain
     thumbnails through the get-media-url coalescer).
   - Book view: book_document → `applyPreFit` → `fitBook` →
     `applyPostFit` → existing spread pager; images via provider map
     assembled from get-media-url batches (manifest keys ∪
     edit-referenced keys).
   - Edit mode: text fields for v1 targets; image tap → picker sheet
     (paginated pool, duplicate badges, too-small hint) → save_edit;
     focal-point drag → save_edit; optimistic re-render; `skipped`
     orphans surfaced quietly.
   - Mobile-responsive; keyboard-safe inputs (repo UX rule).
7. **Web build + hosting worker**: dedicated web Vite config
   (`publicDir: false`, single input, `dist-web/`) + verification that
   the bundle contains no book-data and no other entries;
   `cloudflare/memory-book-web/` static-assets Worker (SPA fallback)
   with route book.usemomora.com; only public config (Supabase URL +
   anon key) in the bundle. DNS + deploy owner-gated.
8. **Plan-doc sync**: update docs/plans/memory-book.md §V5 5b bullet
   (Vite entry decision + session note) in the same change.
9. **Verification**: renderer vitest (baseline 369 + new; snapshots
   unchanged); edge suite (baseline 1427 + new); root jest unaffected;
   PII check on `dist-web/`; real-data smoke against canary book
   `687bb3d1-…` in the browser pane (login → list → full render with
   presigned images → one edit of each type persists across reload);
   print raster of one page via print entry proving print parity
   untouched.

## Risks & mitigations

- **PII in build output**: Decision 2 + step 7's explicit bundle check.
- **Client-fabricated edit data**: impossible by construction (Decision
  4/5 — service-role writes only, server-side measurement/resolution).
- **Reflow surprises**: text post-fit (never reflows); image pre-fit
  with measured-dimension warning (Decision 7).
- **Stale/orphaned edits after regeneration**: stable keys; `skipped`
  surfacing; positional keys banned.
- **Presign exposure**: identical to the app's existing get-media-url
  posture (1h, authenticated family members, never logged/never in page
  URLs); mid-session role-revocation residual bounded by expiry + the
  50-min client cache, same as the app today.
- **everything-scope pool size**: pagination is mandatory, not optional.
- **Concurrent editors**: last-write-wins v1, stated in the feature doc.
- **Fonts**: Google Fonts already loaded by both existing entries; same
  for web.html.

## Out of scope

- App scope picker + signed-link handoff (5a.5, after this).
- Checkout/pricing/print rendering of edits (5c; `applyBookEdits`'s
  purity and the self-contained edit records are the contract it
  consumes).
- Deleting images/memories, custom-range scopes, illustration
  replacement/regeneration, per-field edit merge (v2).
- Deploys/DNS execution (owner-gated; plan ends with artifacts ready).
