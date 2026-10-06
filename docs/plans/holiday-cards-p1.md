# Holiday Cards P1 — production backend (+ render infra)

**Status:** plan, 2026-10-06 — hardened (3 review rounds, §11); owner answered §10 the same day; not started
**Parent:** [holiday-cards.md](holiday-cards.md) (C0–C5 results, Gelato lessons) ·
siblings: [year-film-p1.md](year-film-p1.md) (on-demand films reuse its
pipeline), [memory-book-orders.md](../features/memory-book-orders.md) (orders:
Stripe + Workflow + sweep)

## 1. Goal

Everything a card needs on the server, end to end, so that P2 (shop editor +
app entry) is UI on a stable API:

- a family's owner/manager creates a **holiday card**; the server picks front
  photo candidates, renders the card's **holiday film** on demand, mints the
  **public QR link**, and writes **letters** (v2 editor + writer);
- the card's state (choices + edits) is saved server-side with trust checks;
- **ordering**: quote (Gelato) → print files rendered and Gelato draft created
  at checkout → Stripe Checkout → draft confirmed after payment →
  status/tracking until shipped;
- the C6 render-infra question is answered inside this phase (the card files
  render on the existing book render service).

Done means a **canary on production for the owner's family**: create a card
from the app's data, the film renders on demand and plays at `/f/<token>`,
letters appear, a real paid order goes to Gelato and is accepted (`passed`),
status reaches `shipped` with tracking, **delivered to a named US/CA address
where someone opens the envelope** (§9). "Canary shipped" is a **launch
gate**, not a P2 gate — P2 starts on P1's API contract as soon as Step 3
lands.

## 2. Owner decisions

| Area | Decision |
|---|---|
| Who | **Owners and managers** create, edit and order (like books); viewers don't see cards (2026-10-06). |
| Markets | **US/CA only, 5×7 (`5R`), USD** (2026-10-06: no EU VAT registration, no Europe for now — books exclude the EU for the same reason, `SHIPS_TO_COUNTRY_CODES` in `memory-book-orders/index.ts:106-132`). The product map stays data-driven so Europe (A5, one 2-page PDF, EUR) can be added later; the renderer already supports A5. |
| Price | **Tiered, shipping included** (owner, 2026-10-06; was a flat $2.49): packs of 10; 10 cards $29.90, 20 $49.80, 30 $68.70, 50 $99.50, 100 $179.00. One Stripe line item (no separate shipping line). |
| Limits | **One card per family per year** (deleting it doesn't free the slot — delete + create would be a free rewrite). **No letter rewrites and no film refreshes**: parents edit the letter text themselves; the film is the one made at creation (2026-10-06). |
| Film | Rendered **at card creation** (parents preview before paying); **card-only** — never in Keepsakes/Timeline (the app keeps filtering `family_holiday`). Re-rendered only by the existing invalidation (deletions/reports). Below the floor (20 moments / 12 visuals) → no film, no QR (no retry). **Once the film has published, re-renders waive the floor** (a single deletion on a borderline family must not kill a printed QR). |
| Greeting / signature | The greeting is chosen **at creation** and fixed (it is baked into the film's end card and there are no refreshes); the card row is its single source and the editor shows it read-only. The film's "from" line is the family name (`familyDisplayName`); the card's signature is card-only and edits freely. |
| Illustrated front | **Cut from v1** (2026-10-06). The illustration pipeline is memory-keyed (`memory_illustration_jobs.memory_id NOT NULL`, `target_kind ∈ memory/portrait_version`). |
| Letters | v2 pipeline (`_shared/holiday-card-letter-v2.ts`): classic + warm plain, playful charming. Written **from the pool digest during generation**, not after the film renders (owner OK 2026-10-06). |

## 3. What exists (C0–C5, verified 2026-10-05/06)

- **Shared pure modules**: `holiday-card-photos.ts` (front candidates + vision
  judge + ranking), `holiday-card-illustration.ts`, `holiday-card-digest.ts`
  (script and pool paths build the same profiles; the film only decides
  `filmPresent` and the line of the year — `:9-13`), `holiday-card-details.ts`,
  `holiday-card-voice.ts`, `holiday-card-letter.ts` (v1 + hard checks),
  `holiday-card-letter-v2.ts` (editor + writer). They are prompt builders /
  parsers / rankers; the **orchestration** (loading rows, R2 reads, OpenAI
  calls, quote verification, assembling `card.json`) lives in the eval
  scripts `supabase/scripts/eval-holiday-card-{assets,front,letters,audit}.ts`
  (~3,400 lines) and must be ported (Step 4a).
- **Film**: kind `family_holiday` in SQL (migration `20261005120000`) and the
  shared code (`buildHolidayScript`, strict public frame check, holiday theme,
  relaxed bursts, end card); the worker (`8a4a007f`) + image (`b73621518323`)
  handle the kind. **Missing**:
  - on-demand dispatch — only the hourly cron claims films
    (`schedule-year-films` → `claim_year_film_dispatch`, which claims forced
    rows too and gates on `year_film_family_enabled`);
  - the greeting never reaches the film — `stages.ts` `load()` /
    `FilmRowForPlan` carry no `edits`, so `buildHolidayScript` falls back to
    `DEFAULT_HOLIDAY_GREETING = 'holidays'`;
  - `HolidayInput.preferredCloseMedia` (closing shots = the card's top picks)
    is never passed by `planFilm`;
  - every re-render re-applies the floors (`year-film-context.ts:343-345`) and
    a below-floor cycle ends `skipped`, deleting the video;
    `year_film_recheck_skipped` excludes forced rows, so it never comes back;
  - forced rows are hidden from members and `get-year-film-url` rejects
    `forced` in single and batch mode;
  - `save_year_film_edits` (`20260930150000:211-299`) has no `forced` check.
- **`cloudflare/year-film-worker`** already binds R2 (`momora-prod`),
  `OPENAI_API_KEY`, the bridge HMAC, Sentry and `YEAR_FILM_WORKFLOW`.
- **Public page**: `film_share_tokens` + `workers/memory-viewer` `/f/:token`
  (live; a row without `video_key` already shows "updating", revoked → 410;
  two uncached Supabase lookups per request). **The owner's dogfood film row
  (`601f9af7…`) and the printed sample's token must never be revoked or
  cleaned up by P1 tooling.**
- **Card rendering**: `book-renderer/src/card/*` (fronts, back, fit, QR,
  portraits, formats `5R`/`A5`), `card:pdf` (2-page PDF + `-front`/`-back`
  singles), editor preview, `CardEdits` shape. Local only: `renderCardPdf`
  reads `card-data/<slug>/…` from disk, `CardPrintApp` resolves assets as
  `/${slug}/${file}` and throws (`data-print-error`) when the letter doesn't
  fit or margins break; the render image's Dockerfile builds only
  `vite.print.config.ts` (`dist-print`), not `vite.card.config.ts`; the image
  has no poppler (`card:pdf` shells out to `pdftoppm`/`pdffonts`);
  `.dockerignore` excludes `book-data/` only. Fly: one request per machine,
  scale-to-zero, 15–20 s cold start.
- **Orders (books)**: `memory_book_orders` (SELECT buyer-only; client draft
  INSERT with server fields null-locked), `memory-book-orders` Edge Function,
  `stripe-webhook` (three handlers, all `memory_book_orders`-only; metadata
  `{orderId}`; refunds looked up by `stripe_payment_intent_id`),
  `_shared/stripe.ts` `createCheckoutSession` (book-hardcoded name, tax code,
  shipping line), `cloudflare/memory-book-order-worker` (a Workflow because
  book renders take minutes; duplicate instance ids accepted as success),
  `sweep-memory-book-orders` (dispatch reconcile, tracking, 48h quoted aging;
  **never sets `delivered`**).
- **Usage limits**: image generations only (reservation protocol v2); no
  per-card counters. `ai_usage_events.operation` is an enumerated CHECK.
- **RLS helpers**: `is_family_member(fam)`, `has_family_role(fam, roles[])`.
- **Export**: `momora-export-worker/src/plan.ts:98-101` already exports every
  `year_films` row with a video, `family_holiday` included.
- **Gelato facts** (plan §C5): product UIDs per region; **US 5R = separate
  `default` + `back` files** (never produced yet — both 5R attempts were
  refused for PT); EU A5 = one 2-page PDF (produced, order 6234f0a9); no
  TrimBox; curl-like User-Agent; company info done; a quote is a
  deliverability signal only when shipment methods carry real prices; drafts
  are not produced or charged; draft → `PATCH {orderType:'order'}`.

## 4. Data model (one migration)

**`holiday_cards`**:
- `id`, `family_id` (cascade), `created_by`, `year`, `status`
  (`generating | ready | failed`), `language`, `locale`,
- `film_id` (→ `year_films`, set null), `share_token` (minted at film-row
  insert), `greeting` (`christmas | holidays | new-year`; single source) —
  `film_state` is **derived on read** (join `year_films`), never stored,
- `front_candidates jsonb` (ranked media ids + verdict summary, no text),
- `letters jsonb` (variants: tone + text + soft flags), `qr_caption`,
  `signature`, `editor_facts jsonb` (facts + evidence ids),
- `edits jsonb` (`CardEdits`) + `edits_version int` (new optimistic-concurrency
  CAS; `memory_book_edits` is last-write-wins),
- `generation_attempts` (system retries, capped),
- a unique index on `(family_id, year)` including soft-deleted rows (one
  card per family per year; a double tap returns the existing card),
- generation lease columns (`workflow_instance_id`, `attempt_id`,
  `heartbeat_at`), `created_at`, `updated_at`, `deleted_at`.
- **Column grants**: `revoke all` + column-level `grant select (...)`
  excluding `editor_facts` and lease columns (the `year_films` pattern); RLS
  select via `has_family_role(family_id, array['owner','manager'])`; no
  client writes.

**`holiday_card_orders`** (separate table; the live book flow stays
untouched):
- `id`, `card_id` (→ `holiday_cards` **on delete set null**), `family_id`
  (cascade), `requested_by`, `status` (`draft → quoted → checkout → paid →
  submitted → in_production → shipped`, `failed`, `cancelled`),
- `region`, `format`, `product_uid`, `file_layout`, `packs`, `currency`,
  `price_cents`, `gelato_cost_cents` (internal), `shipping_address jsonb`,
- `card_snapshot jsonb` + `snapshot_hash` (frozen at `create_checkout`),
  `print_files jsonb` (keys + sha256), `gelato_order_id` (the draft, created
  at checkout), `gelato_status`, tracking, `shipped_at`,
- Stripe ids (session, payment intent), `refunded_at`, `failure_reason`,
  timestamps.
- **RLS like books**: SELECT buyer-only; INSERT a bare draft by an
  owner/manager claiming themselves as buyer; server fields null-locked.
  Other managers learn about an open checkout only through the card's
  `has_open_checkout` flag (Step 3 `get`).

**`year_films`** additions: card films stay `forced`; a new SELECT branch lets
owners/managers read a film **referenced by a non-deleted
`holiday_cards.film_id` of their family**. The app keeps filtering
`family_holiday` out (`YEAR_FILM_KINDS` in `src/services/year-films.ts`) until
a later decision (card-only for v1).

**Other SQL**:
- `create_holiday_card_film(card_id, scope, greeting, close_media)` — **one
  transaction**: lock the card, no-op if `film_id` is set, insert the forced
  `family_holiday` row (greeting + `preferredCloseMedia` in `edits`), mint the
  token, set `film_id`/`share_token`. Retries and the stuck-generation sweep
  can never create a second film or change a token.
- Film floor waiver: `planFilm` skips `evaluateHolidayFilm` for a
  `family_holiday` row that has published before (`ready_at` set); an empty
  pool is still a hard skip.
- A terminal **`ended`** state, used only when a card is deleted: skipped by
  `claim_year_film_dispatch`, `year_film_promote_requeues`, recover and
  `year_film_invalidate`; clears `attempt_id` (an in-flight render is
  superseded, its publish CAS fails) and nulls `video_key`/`poster_key` so the
  existing cleanup releases the artifacts.
- `save_year_film_edits` gains `and not v_film.forced`; audit the other
  client-callable film RPCs for the same gap.
- `ai_usage_events_operation_check` **replaced** with all existing operations
  + `holiday_card_front_judge`, `holiday_card_voice`, `holiday_card_details`,
  `holiday_card_editor`, `holiday_card_writer`, `holiday_card_quote_check`.
- `claim_family_deletion_fence`: copied from the live definition
  (`pg_get_functiondef` — drift risk), extended to refuse while card
  generation holds a fresh heartbeat **or a card order is `paid`/`submitted`
  and Gelato hasn't reported `passed`** (files not yet fetched).
  `in_production`/`shipped` don't block deletion (nothing ever sets
  `delivered`).
- New bridge ops on `workflow-year-film-bridge` (existing nonce table).
- pg_cron schedule for the new sweep.
- A down-script restoring every replaced function / policy / CHECK.

## 5. Steps

### Step 1 — Migration + pgTAP + types + TECH_SPEC
Everything in §4. pgTAP: RLS (owner/manager vs member vs viewer vs anon,
buyer-only orders, column grants hide `editor_facts`); `create_holiday_card_film`
idempotency; `ended` skipped by
claim/promote/invalidate and releases artifacts; `save_year_film_edits`
refuses a forced film; the card-film SELECT branch; the fence (blocks on an
unfetched paid order, not on `shipped`); family deletion with a card + order;
one card per family-year under concurrent calls. Regenerate types, TECH_SPEC §2,
`usage-limits.md`.

### Step 2 — Shared pure modules
- `_shared/holiday-card-products.ts`: region map (`region → product_uid,
  format, file_layout, currency, price`), `regionForCountry(iso)`, the
  **enabled-countries list** (US, CA), `regionGuessForTimezone(tz)`, quote
  deliverability rule, max-cost guard, pack sizes, a card tax code.
- `_shared/gelato.ts`: quote, create draft, patch to order, get order, cancel
  (draft delete); User-Agent rule; strict parsers; no secrets logged.
- `_shared/holiday-card-snapshot.ts`: **DB rows → `CardData` + asset list**
  (the production port of `eval-holiday-card-assets.ts`: portraits at date,
  front photo **original** key for print + preview key for the editor,
  letters, QR url).
- Deno tests for all three.

### Step 3 — Edge Function `holiday-cards` (JWT, owner/manager, billing write)
Ops:
- `create(greeting)` — warns/refuses when the timezone-based region guess is
  outside the enabled countries (before any AI or film spend); atomic
  per-family-year guard; dispatches generation.
- `get` — card + derived film state + signed thumbnails + `has_open_checkout`.
- `picker_pool` — family-scoped photos, Dec 1 → today, cursor (the book's
  shape).
- `save_edits` — version CAS + **server-side trust checks** like
  `memory-book-edits` (media ownership, original dimensions by ranged GET,
  client keys ignored). Refused only while a Stripe Checkout session is open
  (`checkout` status) — the snapshot is frozen there, so edits after a quote
  can't change what prints.
- No `regenerate_letters`, `refresh_film` or `set_greeting` (owner,
  2026-10-06): letters are edited by hand; greeting and film are fixed at
  creation.
- `delete` (soft delete, revoke token, film `ended`; the year's slot stays
  used).
- **Once any order is `paid` or later, `delete` refuses** — the QR is on
  paper. An owner-only `disable_link`
  (explicit confirmation) is the only way to revoke an ordered card's token.
- Never touches the dogfood row/token.

### Step 4a — Port the orchestration (own step, budgeted)
Move the eval-script orchestration into Worker-ready modules: front
candidates (ranged dimension probe, vision judge batches), voice card +
details + quote verification + editor + writers (v2), the pool digest. Evals
keep using the same modules afterwards.

### Step 4b — Generation Workflow in `cloudflare/year-film-worker`
A second Workflow class (`HolidayCardWorkflow`) in the existing worker (it
already has R2, OpenAI, the bridge HMAC, Sentry, and starts
`YEAR_FILM_WORKFLOW` directly — no new worker, bridge, nonce table or
dispatch secret). New card ops on `workflow-year-film-bridge`. One instance
per generation:
1. **Front picks** → `front_candidates` (first, so the film can close on
   them).
2. **Film**: plan (floors); if eligible, `create_holiday_card_film` (card
   greeting + top picks as `preferredCloseMedia`), `claim_year_film_by_id`
   (zero rows = the cron got it = success) + start the film Workflow; on
   failure `year_film_end_cycle(..., 'aborted', 'DISPATCH_FAILED')`. Below
   the floor → no film row.
3. **Letters** from the pool digest (`filmPresent` = film eligible; line of
   the year via the ported quote verifier). No wait on the film.
4. `status = ready` (≈1–2 min). The film keeps rendering independently.
Every step idempotent; logs carry ids/codes only; AI usage recorded with the
new operations.

The film side also changes in this worker: `stages.ts` `load()` reads
`edits.greeting` / `edits.preferredCloseMedia` into `planFilm`, and the
floor waiver for published card films. **This redeploys the live film
worker** (§6).

### Step 5 — Render service: `/render-card` (C6)
- Dockerfile: also build `vite.card.config.ts` (`dist-card`); `env.ts` path.
- `book-renderer/.dockerignore`: exclude **`card-data/`** (real family data).
- Assets from presigned R2 URLs (like the book's attempt mode) or downloaded
  to `<tmp>/<orderId>/`.
- `POST /render-card` (HMAC): snapshot + format + file layout → PDFs
  uploaded to `print-orders/<orderId>/` (`front.pdf` + `back.pdf` for 5R),
  returns keys + sha256. Card-specific status/response shape. Verify page
  size per format, fonts embedded, no TrimBox, with pdf-lib (no poppler in
  the image). Fit/margin/image errors return a typed 422 the shop can show
  ("the letter is too long for this size").
- Capacity: size the December checkout burst against Fly machine limits in
  the benchmark (each checkout = one render).
- Benchmark on Fly with a **synthetic fixture card** (no family data).

### Step 6 — Orders (no order Workflow)
A card renders in seconds, and Gelato drafts aren't charged, so the print
files and the draft are made **before payment**; after payment the only
action is one PATCH.
1. `_shared/stripe.ts`: generalise `createCheckoutSession` (product name, tax
   code, line items, currency) without changing the book's call.
2. `holiday-card-orders` Edge Function:
   - `create_draft(cardId)`;
   - `quote(orderId, address, packs)` — country → region, **reject countries
     not enabled**, Gelato quote with the deliverability rule and the
     **max-cost guard** (product + cheapest real shipping under the price
     minus a margin floor; AK/HI/PR/APO can blow a shipping-included price);
   - `create_checkout` — freeze `card_snapshot` + hash; **precondition**:
     film `ready` and not blocked, or the QR explicitly off; call
     `/render-card` (real format) → print files; create the Gelato draft
     (`orderReferenceId = orderId`) and persist its id; then the Stripe
     session (`metadata` and **`payment_intent_data.metadata`** both carry
     `{productType:'holiday_card', orderId, snapshotHash}`); status
     `checkout`. A render failure here is a normal error, no money taken.
3. `stripe-webhook`: route checkout events by `metadata.productType`,
   **defaulting to books when absent** (legacy sessions). `charge.refunded`
   looks the payment intent up in **both** order tables. Card handlers
   verify `amount_subtotal === price_cents`, currency, address, snapshot
   hash; CAS `checkout → paid`; then (via `waitUntil`, sweep as fallback)
   PATCH the Gelato draft **only if Gelato still reports it as a draft** →
   CAS `submitted` → email. Expired → `cancelled` + delete the draft and the
   print files. Refund → `refunded_at`; if `submitted`/`in_production`,
   cancel at Gelato if still cancellable, else owner alert. A test proves a
   session without `productType` still hits the book path.
4. `sweep-holiday-card-orders` (pg_cron):
   - `paid` orders not yet confirmed → PATCH-if-draft (idempotent);
   - poll Gelato for `submitted` (`passed`/printing → `in_production`;
     shipped + tracking → `shipped` + `shipped_at` + email; refused/held →
     `failed` + owner alert);
   - age `quoted`/`checkout` orders (48h) and delete their drafts/files;
   - **recover cards stuck in `generating`** (stale heartbeat → requeue,
     capped by `generation_attempts`);
   - **ordered card films**: a re-render that ends `failed` → owner alert.
   Gelato webhooks only as a "poll now" hint unless they can be
   authenticated. Fulfillment ignores `families.deleted_at` for paid orders.
5. `supabase/config.toml`: `verify_jwt = false` for the sweep (the bridge
   entry exists).

### Step 7 — Film visibility, deletion, retention
- `get-year-film-url`: serve a card film when the caller is owner/manager of
  a card that references it (keyed to the card).
- Deletion: `hard-delete-expired-accounts` `collectFamilyStorageKeys` adds
  `print-orders/<orderId>/…` for card orders.
- Retention (before mid-December): print files deleted 30 days after
  `shipped_at` (or `failed`/`cancelled`).
- Export: already covered by `plan.ts`; verify that an `ended` film and
  viewers' own exports behave.

### Step 8 — Docs + canary
`docs/features/holiday-cards.md` (new), TECH_SPEC, the canary (§1).

### Step 9 — Tests
pgTAP (Step 1); Deno: products, gelato, snapshot, both Edge Functions,
webhook routing (books unchanged, no-productType default, refund lookup in
both tables, snapshot-hash mismatch, PATCH only from draft), sweep, on-demand
dispatch (failure + "cron won the claim"); Worker vitest (generation
Workflow, greeting/close media/floor waiver in `planFilm`); render service
(`/render-card` 200 + 422, page sizes, file layout); app `YEAR_FILM_KINDS`
filter test.

### After launch (deliberately deferred)
A per-token cache in `workers/memory-viewer` (two uncached lookups per
request; fine at launch volume, revisit when card QR traffic grows);
an operator script. Not planned for v1: Europe, the illustrated front.

## 6. Rollout

1. Migration (owner runs `supabase db push`); pgTAP passes in CI first.
   Rollback = the down-script.
2. Edge Functions + secrets (`GELATO_API_KEY`; Stripe existing) + config.
   The stripe-webhook change ships behind the `productType` default so live
   book orders keep their path; the previous version is redeployable.
3. Render service redeploy (Fly) after the `/render-card` benchmark.
4. **`year-film-worker` redeploy** (new Workflow class + `load()` changes;
   it serves live films): pre-deploy one forced recap render on a Fly bench;
   rollback `npx wrangler rollback 8a4a007f…` (the current version; record
   the new id when deployed).
5. Canary on the owner's family (§1) to a named US/CA address.
6. P2 (shop editor + app entry) in parallel from Step 3; launch ~Nov 10
   (P3), gated on the canary delivery and the 5R sample (§9).

## 7. Risks

- **The US product has never been printed**: 5R two-file was refused twice
  for PT; only EU A5 has been produced. A separate 5R sample now (§9).
- **Gelato routing/format surprises**: data-driven product map; every order
  status-polled; refusal/hold → `failed` + owner alert.
- **EU tax**: no EU sales (owner: no VAT registration for now).
- **Printed QR durability**: ordered cards can't be deleted;
  published card films waive the floor on re-render; failed re-renders
  alert; tokens revocable only by explicit owner action.
- **December capacity**: card films share render slots with the Dec 1 recap
  and Dec 28 year-end films (`max_concurrent_renders` 12); each checkout is a
  Fly render.
- **Money path**: nothing is rendered or created after payment except one
  idempotent PATCH; amount/currency/address/hash verification; CAS
  everywhere; legacy book sessions unaffected.
- **PII in print files**: deletion + retention (Step 7); `card-data/`
  excluded from images.

## 8. Out of scope (P2/P3)

The shop UI (`/c/<id>` editor, checkout screens), the app's Keepsakes entry,
mailing to recipients, "write it in English instead", reorders UI (the model
allows them), express shipping, the illustrated front (cut from v1), Europe
(no EU VAT registration), letter rewrites and film refreshes.

## 9. Owner tasks

- Gelato API key as a Supabase secret; Stripe tax settings for the card tax
  code.
- 5R US sample: owner's Houston PO box (2026-10-06, 1 pack) — see the parent
  plan's C5 log. The P1 canary ships to the same address.

## 10. Owner answers (2026-10-06)

1. **EU VAT**: no registration for now → US/CA only.
2. Europe: not for now.
3. Limits: one card per family per year; no letter rewrites, no film
   refreshes.
4. The card's film stays card-only.
5. Illustrated front: cut from v1.
6. Letters from the pool, no film wait: OK.

## 11. Review log

**Round 1 (Sonnet 5.5, completeness & correctness)** — 9 findings, all
accepted and applied: EU/EUR is a VAT boundary books deliberately avoid (now
gated, Q1); RLS helper is `has_family_role`, orders are buyer-only like books,
column grants hide `editor_facts`; Stripe layer is book-hardcoded (generalise,
route all three events, default legacy sessions to books, amount formula);
the greeting never reached the film, token minted at insert, film state
derived on read, `refresh_film` op; `/render-card` needs the card build in the
image, `.dockerignore` for `card-data/`, an asset loader, card status shape;
eval orchestration must be ported (Step 4a); usage caps and `ai_usage_events`
operations are new; `card_id` SET NULL (RESTRICT would trip family deletion),
deletion fence + print-file deletion/retention + export as real steps;
missing config.toml entries, nonce tables, sweep cron, stuck-generation
recovery, dispatch-failure path; smaller: LWW wording, `save_edits` trust
checks, checkout precondition, soft delete ends the film, app kind filter,
card-keyed `get-year-film-url`, protect the dogfood row/token, missing tests.

**Round 2 (Sonnet 5.5, failure modes & risks)** — 12 findings, all accepted
(verified in code: `save_year_film_edits` lacks a forced check;
`memory_illustration_jobs.memory_id NOT NULL` + `target_kind` CHECK; refunds
keyed by payment intent; the order worker accepts duplicate instance ids as
success). Applied: Gelato idempotency (draft id persisted before the PATCH,
PATCH only from draft); render validation before payment; snapshot frozen at
checkout with a hash; ordered cards can't be deleted/refreshed
(`disable_link` only), failed re-renders of ordered films alert; terminal
`ended` state and an atomic `create_holiday_card_film`, "cron won the claim"
= success; `save_year_film_edits` refuses forced films; **illustrated front
out of P1**; atomic caps + one card per family/year + counters; refund
routing via both tables + Gelato cancel/alert; fence copied from the live
definition, fulfillment ignores `deleted_at`; max-cost guard (AK/HI/PR);
Fly capacity; no poppler in the image; rollback down-script + CI pgTAP.
Superseded by round 3: the order Workflow/attempt-CAS redispatch, the
greeting+signature match rule, edits locked from `quote`, the 20-min letter
wait.

**Round 3 (Opus 5.5, holistic)** — 12 findings, all accepted (verified:
the book sweep never sets `delivered`; re-renders re-apply the floor and
forced rows are never rechecked; the end card's "from" is the family name;
the digest's film path only adds the line of the year; `year-film-worker`
already has R2/OpenAI/HMAC/Workflow bindings). Applied: fence waits only
until Gelato `passed`, retention from `shipped_at` (round 2's version would
have blocked family deletion forever); **floor waiver for published card
films**; edits locked only while a Checkout session is open +
`has_open_checkout`; signature out of the film contract, card row is the
single greeting source (`set_greeting` refreshes the film), front picks
first so the film closes on them (`preferredCloseMedia`); **letters from the
pool, no film wait** (Q6); **print files + Gelato draft made at checkout, no
order Workflow/worker/bridge** — nothing but an idempotent PATCH after
payment; **generation Workflow hosted in `year-film-worker`** and its live
redeploy + rollback named; a US 5R sample now and a named canary address,
canary = launch gate, P2 starts from Step 3; `create` gated by the timezone
region guess, EU/EUR/A5 order path deferred until Q1; `refresh_film` in place
(same token), `ended` only for deletion and it clears `attempt_id` + nulls
video keys; memory-viewer cache, operator script deferred, export already
covered; illustrated front is an explicit owner decision (Q5). Rejected:
none. The Gelato "look up by reference before create" from round 2 is
dropped as unneeded (drafts are free; the id is persisted at checkout).

## 12. Deploy + canary (2026-10-06)

- Prod `claim_family_deletion_fence` matched the migration's copy (md5 of
  `prosrc` 57a110ee…, 5588 chars) → owner ran `supabase db push`
  (20261006120000).
- `GELATO_API_KEY` secret set; Edge Functions deployed (owner, `--use-api`):
  holiday-cards, holiday-card-orders, sweep-holiday-card-orders,
  stripe-webhook, get-year-film-url, hard-delete-expired-accounts,
  schedule-year-films, workflow-year-film-bridge.
- `momora-year-film-worker` version `dae3f266` (both Workflows), deployed with
  `--env="" --var FILM_RENDERER_IMAGE:…:b73621518323` (the config only holds a
  placeholder — a plain deploy would break live films). Rollback target
  `8a4a007f`.
- Render service image `registry.fly.io/momora-memory-book-renderer:9d1d05e`
  (PII image test 6/6); previous image `:v1` is the rollback.
- **Canary, owner's family (free dry run, owner's call — no paid order):**
  - `create` (Europe/Lisbon → `regionWarning`, not blocked) → card ready on
    attempt 1 in ~2 min: 12 front candidates (#1 the whole family, 4032×3024),
    three es-CO letters with no flags, signature from the family name, QR
    caption; film `0fa942b8` published 15 min later; `/f/<token>` page 200 +
    video 206.
  - `create_draft` → `quote` (Houston, 2 packs: deliverable, Gelato cost
    $18.71 vs $49.80) → `create_checkout` in 33 s incl. Fly cold start: print
    files under `print-orders/<order>/<hash16>/`, Gelato draft with the right
    product, qty 2, `default` + `back`, address and reference; live Stripe
    session. PDFs 185.9 × 135.1 mm, fonts embedded, QR = the card's live link.
  - `cancel_checkout` → order `cancelled`, Gelato draft gone (404), print files
    deleted.
  - Not exercised in prod: the paid path (webhook → confirm → tracking). It
    runs first on the first real order; the sweep alerts at 30 min if a paid
    order isn't submitted. The US 5R print itself is proven by sample
    05f43f74.
- Follow-ups: HEIC → JPEG print path (gallery-import originals are excluded
  from the front today); watch the first paid order.
