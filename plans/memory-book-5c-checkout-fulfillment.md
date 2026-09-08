# Memory Book 5c — Checkout & fulfillment (render worker, orders, Stripe)

Draft 2026-09-08, pre-hardening.

## Goal

A parent viewing their edited book at shop.usemomora.com can buy it:
enter shipping address → see our price + real shipping → pay (Stripe) →
the book renders print-exact PDFs (with their edits) on a Fly.io worker
→ the order submits to Prodigi → status flows to the order page and
email until delivery. No human in the loop for the happy path; every
unhappy path alarms rather than strands a paid order.

## Context (verified against the codebase)

- **What exists (5a/5b, all live)**: `memory_books` (book_document =
  outline+manifest, preview-res asset keys + originalWidth), generation
  workflow (`cloudflare/memory-book-worker`), `memory_book_edits`
  (service-role-written, self-contained image edits incl. `file` +
  `originalFile` + measured dims), `applyPreFit`/`applyPostFit` in
  `book-renderer/src/model/edits.ts` (pure), the web app at
  shop.usemomora.com (Vite entry, `cloudflare/memory-book-web` hosts).
- **Print pipeline (proven on the V4 sample order)**:
  `book-renderer/scripts/render-pdf.mts` — Puppeteer against the built
  `print.html`, exact-trim 210×210 interiors / 448×210 covers per
  docs/plans/prodigi-order-spec.md (canonical, from Prodigi's own guide),
  front-matter blank dropped, even page counts enforced, `--spine-mm`
  required. It currently reads book-data from DISK and spawns
  `vite build` + `vite preview` per run.
- **Print needs ORIGINAL-resolution images**: production manifests'
  asset `file` = the app's ~1280px preview key. Originals live at
  `memory_media.object_key`; the manifest does NOT store that key today
  (only `originalWidth/Height`). The eval print pipeline solved this by
  downloading originals locally (`--print-assets`); production must
  solve it server-side.
- **Prodigi lessons (paid for in V4)**: separate cover+interior files by
  presigned URL; the account-wide 2h edit window must be OFF before
  launch — recorded as a PENDING owner action, not verified done
  (round-1 review): step 7 verifies it empirically before wiring
  alarms, and the state machine handles a held order gracefully either
  way (an order invisible to the Orders API after submission is treated
  as 'submitted', with the not-in-production alarm N set to 4h —
  comfortably above the 2h window — documented rationale); held orders are invisible to the Orders API; rejection
  can arrive via support email, not API status → timeout alarms are
  mandatory; `POST /v4.0/quotes` gives per-destination shipping;
  `POST /v4.0/products/spine` gives spine width per page count; asset
  presigned URLs must outlive Prodigi's download window (7-day expiry
  worked).
- **Payments**: no Stripe anywhere in the repo today (app subscriptions
  are RevenueCat; `billing-reconcile` is RevenueCat-side). Stripe
  Checkout one-time payment, separate from subscriptions (plan §Stage G).
  We are merchant of record; Prodigi bills our card. Stripe Tax for
  VAT (decided). Physical goods = exempt from app-store IAP rules
  (recorded in plan §V5).
- **Email**: `supabase/functions/_shared/bento.ts`
  `sendTransactionalEmail` exists and is production-used.
- **Fly.io decision (recorded in plan §V5)**: render worker is a
  Dockerized HTTP-triggered service, scale-to-zero (push, never poll),
  Hetzner as volume fallback. Owner will create the Fly org.
- **Order state machine (plan §Stage G)**: `draft → previewed → paid →
  submitted → in_production → shipped → delivered / failed`, webhook
  updates, tracking email.
- Repo rules: migration + types + TECH_SPEC + feature doc same change;
  Node 20 repo / Node 22 workers; deploys owner-gated; no memory content
  in logs; secrets never in repo.

## Design decisions

1. **Originals reach print via the manifest**: add `originalFile` (the
   original R2 object key) to every photo/video-poster asset entry in
   the PRODUCTION manifest builder (`cloudflare/memory-book-worker/src/
   manifest.ts` + the shared `buildManifestAsset` seam), populated from
   `memory_media.object_key`. Backward compatible (optional field); the
   render worker then needs NO DB access for assets — the frozen
   book_document is self-contained. CRITICAL (round-2 review): the edit
   application path must carry the field too — `substituteAsset` and
   `applyCoverImageEdit` in book-renderer/src/model/edits.ts copy
   file/aspectRatio/dims but NOT originalFile today, so every EDITED
   photo (exactly the slots a customer touched) would print at preview
   resolution; fix + test in step 1. Existing `ready` books lack the
   field → a NARROW, DETERMINISTIC in-place backfill patches
   originalFile onto the existing frozen book_document (DB lookup of
   memory_media.object_key per asset — no LLM, no re-curation; round-2
   review killed the regenerate-to-backfill idea: generation is
   non-deterministic and could silently swap a paid-for book's
   curation). Backfill runs at QUOTE time; the workflow REFUSES to
   freeze a paid snapshot missing originalFile. Note: `file` is not
   always a preview key (selectMediaAsset falls back to object_key when
   no preview exists) — backfill must be a no-op there. Video posters
   print their poster `file` (no original video in print).
2. **Spine width: two-op render worker, no fitter in workerd** (round-1
   review: importing fitter.ts into a Cloudflare Workflow is unproven —
   the generation worker deliberately avoided it, and fitter's import
   graph has only ever run under Vite/Node). The render worker exposes
   `POST /fit` (Node, no Chrome: applyPreFit → fitBook → applyPostFit on
   the frozen inputs, returns THE page count in ~seconds) and
   `POST /render` (full PDFs, takes `spineMm`). "THE page count"
   defined once (round-3: 118-vs-122 straddles a spine band and
   V4's rejection came from exactly this ambiguity): the
   SUBMITTED-INTERIOR count — post front-matter-verso drop,
   even-enforced, the number render-pdf.mts ends with — feeds quote,
   spine, and Prodigi order alike; the canary (step 7) asks Prodigi
   support to confirm which count their numberOfPages wants. The QUOTE
   op also calls /fit (round-3: quotes need a page count and had no
   source; client-supplied is untrusted money) and persists it; the
   post-payment workflow re-runs /fit on the frozen snapshot and
   ALARMS on divergence from the quoted count. Flow: quote:/fit →
   Prodigi /quotes … paid:/fit → spine API → /render. Page count and rendering come
   from the SAME code in the same process — no cross-runtime fitter
   risk. The render worker never holds the Prodigi key (it can place
   orders — blast-radius control).
3. **Render worker = `render/memory-book-renderer/`** (new top-level
   dir): Docker image with Node 22 + Chrome (puppeteer base image) + the
   book-renderer `dist` BUILT AT IMAGE BUILD TIME (no vite at runtime —
   render-pdf.mts's per-run build/preview spawn is refactored into an
   importable `renderBookPdfs(inputs)` library that serves the prebuilt
   dist and drives Puppeteer). HTTP API: `POST /render` (HMAC-signed,
   same timestamp+nonce scheme as the bridges) with
   `{orderId, attemptId, bookDocument, edits, spineMm, output: {bucket
   prefix}}`; applies `applyPreFit`/`fitBook`/`applyPostFit` — NOTE
   (round-1 review): the PRINT entry does not run the edits chain today
   (only the web preview does, in useEditableBook.ts); wiring
   edits into PrintApp/print rendering is NEW WORK in step 2, not an
   extraction — then renders interior + cover PDFs, uploads to R2
   (`print-orders/<orderId>/`), returns page/cover checksums + page
   count. **Async by contract** (round-3: a 122-page print render runs
   minutes; repo workflow steps time out at 30-120s; and the recorded
   §V5 decision was callback-style, not sync): `/render` 202-accepts,
   writes an in-progress marker to the attemptId R2 prefix (409 to a
   concurrent duplicate), and the workflow polls `GET /status/<attemptId>`
   in normal short steps until done/failed; completed output is
   returned idempotently forever. Fly concurrency `hard_limit = 1`
   with machine autoscale so two renders never share 4GB.
   **Per-request data injection**
   (round-1 gap): the worker's own HTTP server serves, alongside the
   prebuilt static dist, per-attempt endpoints
   `/attempt/<attemptId>/outline.json|manifest.json|edits.json` from
   the in-flight request's payload — served on a LOOPBACK-ONLY
   listener (round-3 simplification: Puppeteer runs in-process, so the
   PII endpoints bind to 127.0.0.1 and never exist on the public
   interface; no token machinery needed; the public listener exposes
   only /fit, /render, /status, /health behind HMAC). The print entry
   gains an `?attempt=<id>&t=<token>` mode fetching those instead of
   `/${slug}/...` — the existing setAssetUrlProvider pattern covers
   image URLs. `/render` idempotency is a REAL check, not the HMAC
   window: before rendering, the worker checks R2 for existing output
   at the attemptId prefix and returns it (round-2: this worker has no
   DB to lean on for replay safety, unlike the memory-book bridge). Fly:
   scale-to-zero, 4GB, health endpoint. Asset access: the render page
   fetches images via short-lived presigned GET URLs generated by the
   worker itself from R2 credentials in its secrets (same _shared/r2.ts
   logic ported; Fly holds R2 read credentials — it must read originals
   regardless).
4. **Orders own everything else in a new Cloudflare workflow**
   (`cloudflare/memory-book-order-worker/`, mirroring the generation
   worker's dispatcher/bridge/CAS architecture):
   - Table `memory_book_orders` (plan §8): id, book_id, family_id,
     requested_by, frozen `book_document_snapshot` + `edits_snapshot`
     jsonb (edits stop mutating the order after payment), price/currency,
     shipping (address jsonb, method, quoted cost), `stripe_session_id`/
     `payment_intent`, `prodigi_order_id`, state machine
     (draft → quoted → paid → rendering → submitted → in_production →
     shipped → delivered / failed / cancelled) with CAS identity +
     recovery clocks, `failure_reason`, `refunded_at`. RLS (round-3:
     an order row carries the purchaser's home address and payment
     identifiers — family-wide SELECT would show grandma the buyer's
     street and Stripe ids): SELECT scoped to `requested_by =
     auth.uid()` (a family-visible status-only projection can come
     later if wanted); INSERT
     owner/manager (draft only) with EVERY server-computed field
     null-locked in `with check` — price, quote, stripe ids, prodigi
     id, state, clocks — mirroring memory_books' insert policy
     line-for-line (round-2: a client must not be able to seed a draft
     with a favorable price that create_checkout might trust); all
     transitions service-role.
   - Edge Function `memory-book-orders`: ops `quote` (address →
     render-worker /fit for the page count → Prodigi /quotes → our
     price + shipping back to client; persists quote+count on the
     draft order), `create_checkout` (Stripe Checkout Session with
     price + shipping + Stripe Tax; `shipping_address_collection`
     DISABLED and the pre-collected quote address pinned as the
     session's canonical shipping so Stripe Tax taxes the true
     destination — round-3: otherwise Checkout's own address can
     diverge from the quoted/shipped one and the VAT is computed
     against the wrong country on our merchant-of-record ledger),
     `status` (poll surface — or rely on RLS SELECT).
   - Edge Function `stripe-webhook` (verify_jwt=false, Stripe signature
     verified, Stripe event-id idempotency): `checkout.session.completed`
     → CAS quoted→paid, freeze snapshots (refusing if originalFile
     missing — Decision 1), dispatch the order workflow idempotently.
     Before CASing to paid, VERIFY the session's amount_total equals
     the persisted quote's total and its address matches the quote
     (round-3: defense in depth on the money path); handle
     `charge.refunded` (sets refunded_at — manual dashboard refunds
     become visible system state) and `checkout.session.expired`
     (sweep ages abandoned `quoted` orders to cancelled).
     Zero-dispatch recovery (round-2 review): mirror the
     gallery-import mark-before-dispatch + reconciliation-sweep
     pattern — a cron-secret Edge Function periodically redispatches
     any `paid` order with no live workflow past a grace window. A
     charged customer with no running workflow must be impossible to
     miss.
   - Order workflow steps (SHORT-LIVED, ends at submission — round-2
     review: no repo workflow has ever slept days, and Prodigi
     production takes 4-6 days; don't pioneer multi-day sleeping
     instances on the money path): recompute page count + spine
     (Decision 2) → render worker /fit then /render (retry/backoff;
     idempotent) → verify PDFs (HEAD R2, page count matches, size
     sanity) → presign 7-day URLs → submit Prodigi order (metadata
     carries orderId) → CAS to `submitted`, send paid-confirmation
     email → workflow ENDS.
   - Post-submission tracking = a cron-secret Edge Function sweep
     (existing pg_cron + x-cron-secret pattern, e.g.
     schedule-daily-reminders): polls Prodigi for every open order,
     advances submitted→in_production→shipped→delivered, sends
     tracking email on shipped, and raises the alarms (not
     in_production within 4h — above the 2h window; stuck >X days).
     Implementation should also check whether Prodigi offers order
     webhooks/callbacks (never investigated — round-2) and prefer them
     if real, keeping the sweep as reconciliation.
     Failure anywhere: CAS to failed with reason + ALARM email to owner
     (never strand a paid order — the V4 lesson).
5. **Web checkout UI** (shop.usemomora.com): "Order this book" from the
   book view → address form (keyboard-safe, Stripe-Tax-compatible
   fields) → quote display (our price + shipping line) → Stripe
   Checkout redirect → return URL `/order/<id>` order-status page
   (needs real deep-link routing — the SPA fallback currently redirects
   to /web losing the path; fix serve-in-place in
   `cloudflare/memory-book-web` as part of this step). Price comes from
   config (placeholder until the owner prices the physical sample —
   NOT hardcoded in code; a `memory_book_pricing` config row or worker
   env).
6. **Edits freeze at payment**: the order snapshots book_document+edits
   at `paid`; later edits affect future orders only. The web UI says so
   on the checkout screen.

## Steps

1. **Manifest `originalFile`** (Decision 1): shared
   `_shared/memory-book-manifest.ts` + generation worker manifest
   builder + tests; regenerate nothing (no schema change). The order
   workflow's "document predates originalFile → regenerate first" guard
   lands with the workflow (step 5).
2. **Render library + print-entry edits support** (book-renderer):
   (a) NEW: PrintApp/print entry learns the edits chain (applyPreFit
   before fitBook, applyPostFit after) and the `?attempt=` data source —
   today it fetches static `/${slug}/` files and never touches edits
   (round-1 verified); default slug mode stays byte-identical (raster
   regression on an unedited book).
   (b) FONTS VENDORED into the image (round-3: Google-Fonts-at-render
   -time means a transient CDN failure ships a wrong-font book to print
   with no error — the V4 silent-fallback defect class): download the
   exact Newsreader/Plus Jakarta Sans/Caveat faces at Docker build,
   serve locally, and HARD-FAIL any render where document.fonts does
   not report every expected face loaded.
   (c) extract `renderBookPdfs()` from `scripts/render-pdf.mts` — takes
   {bookDocument, edits, spineMm, assetUrlProvider}, serves the prebuilt
   dist + per-attempt data, drives Puppeteer, returns PDF
   buffers/streams + page count; CLI becomes a thin wrapper (eval
   workflow unchanged, same verification instrument).
3. **Render worker** (`render/memory-book-renderer/`): Dockerfile
   (puppeteer image + prebuilt dist + vendored fonts), HTTP server
   (HMAC auth on ALL public ops: /fit, /render, /status; /health open;
   loopback-only PII data endpoints), async 202+status contract,
   in-progress marker, R2 upload, idempotency by attemptId, structured
   logs (ids only). Local verification: docker build + run against the canary
   book's document with a real render compared page-for-page (raster
   diff on sample pages) against the CLI pipeline's output — parity
   proof. Fly deploy config committed; deploy itself owner-gated.
4. **Migration + types + docs**: `memory_book_orders` (+ pricing config
   decision), TECH_SPEC, feature doc `docs/features/memory-book-orders.md`.
5. **Order workflow + Edge Functions** (Decision 4): dispatcher/bridge
   mirroring the generation worker; `memory-book-orders` + Stripe
   webhook functions; Bento emails; alarms. Deno + vitest tests incl.
   state-machine CAS, webhook signature, idempotent redispatch,
   snapshot freezing.
6. **Web checkout UI + order routes** (Decision 5): order flow
   screens and the order-status page — including honest customer-facing
   failure copy (a failed paid order tells the CUSTOMER "something went
   wrong on our side — we're fixing it or refunding you", never a bare
   'failed'; a failure email accompanies the owner alarm). Routing
   correction (round-1 review): the hosting worker ALREADY serves deep
   paths in place (test-covered); the real gap is
   `book-renderer/src/web/router.ts`, which only knows `/` and
   `/b/<id>` — add `/order/<id>` route + screen there. No
   cloudflare/memory-book-web change needed. Fixture-mode
   support for the flow (mock quote/checkout in DEV) so it's
   interactively verifiable without spending money.
7. **End-to-end verification**: full suites; Docker render parity
   (step 3); interactive fixture walkthrough; then a REAL end-to-end
   canary — with the owner: real book, real Stripe test-mode payment
   (Stripe test keys first), real Prodigi order in the account
   (cancellable in the window if the owner re-enables it for the test,
   or a deliberately cheap single-book order treated as another
   sample) — the illustration-cutover standard: no feature is done
   until the production path has carried one real order. This canary
   also empirically verifies the edit-window setting (does the order
   land OnHold or go straight to InProgress?) before the alarm
   thresholds are considered final.

## Risks & mitigations

- **Print parity between web preview and render worker**: both run the
  identical pure chain (applyPreFit→fitBook→applyPostFit) on identical
  frozen inputs; step 3's raster-diff parity proof; the print raster
  instrument stays the acceptance tool for any render change.
- **Chrome-in-Docker rendering differences vs local**: same Puppeteer
  major, fonts fetched from Google Fonts at render time as today;
  parity raster catches drift.
- **Paid-order stranding**: every workflow failure → failed + owner
  alarm email; submitted-without-production timeout alarm; the
  reconciliation sweep catches zero-dispatch; Stripe payment exists
  before any Prodigi cost is incurred, so failure recovery is
  refund-or-retry, never silent.
- **Losing the 2h window's human QA** (round-2: that window caught two
  real print defects during dogfood): SOFT LAUNCH KEEPS THE WINDOW ON —
  at low volume, every order gets the 2h human-reviewable pause (the
  state machine models held/invisible orders already), and the
  paid-confirmation alarm email to the owner includes presigned links
  to the rendered PDFs for spot-checking. Turn the window off only when
  volume makes it impractical; revisit with an automated content check
  then. This supersedes the earlier "must be off before launch" note.
- **Dormant fitter constant** (round-2, minor): hasFaceClearance's
  hardcoded 24mm spine band is narrower than real spine widths (26-28mm
  at these page counts); harmless while FACE_DATA_AVAILABLE=false —
  add a TODO tying it to spine data before anyone enables it.
- **Duplicate orders/webhook replays**: Stripe event id idempotency +
  CAS state machine; workflow dispatch idempotent on instance id.
- **Render worker compromise blast radius**: no DB creds, no Prodigi
  key, R2 scoped creds only; HMAC-gated; PDFs land in a dedicated
  prefix.
- **Price not yet decided**: config-driven; test-mode Stripe until the
  owner sets it; nothing hardcodes a price.
- **Presign lifetimes**: 7-day for Prodigi fetches (proven), short for
  render-time image loads.

## Resolved owner decisions (2026-09-08)

- **Currency: USD** — Stripe Checkout Sessions and the quote passthrough
  price in USD (matches Prodigi's billing currency; no fx spread to
  manage). Stripe localizes the display for EU customers.
- Fly org: created. Deploys stay owner-run (commands handed over), with
  a scoped deploy token as the fallback if iteration demands it.
- Still pending: the PRICE itself (awaits the physical sample).

## Out of scope

- In-app scope picker (5a.5 — after 5c, per owner sequencing).
- Multi-copy orders, gifting, reorders UI (post-launch; the schema's
  one-row-per-order shape doesn't preclude them).
- Peecho, RPI/Heirloom editions; production Stripe go-live and real
  pricing (owner decisions at soft launch).
- Editor v2 backlog (unchanged).
