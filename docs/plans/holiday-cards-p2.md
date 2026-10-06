# Holiday Cards P2 — shop editor + app entry

**Status:** plan, 2026-10-06 — hardened (3 review rounds + handoff/held-canary review, §11); not started
**Parent:** [holiday-cards.md](holiday-cards.md) · backend: [holiday-cards-p1.md](holiday-cards-p1.md)
(deployed 2026-10-06) · feature doc: [../features/holiday-cards.md](../features/holiday-cards.md)

## 1. Goal

A parent can make, edit and order a holiday card without help:

1. **App** (Keepsakes, owners/managers, behind a server switch): "Make your
   holiday card" → pick the greeting → the card is created → the shop opens
   at `shop.usemomora.com/c/<cardId>`.
2. **Shop** `/c/<cardId>`: sign in → "preparing" while generation runs (~2
   min) → the editor (front photo, layout, letter variants, click-to-edit
   text, reposition, QR on/off, film preview) → order (quantity, US/CA
   address, quote, Stripe) → back on the card page with status and tracking.
   Reorders of the same (locked) card.

Done = the owner's family goes through it on a phone and a desktop: app tile
→ greeting → shop → edit → checkout → **one real printed canary order** (the P3 gate,
§10) → status → cancel/refund handled; then P3 flips the switch (~Nov 10).

### Milestones (5-week runway)

| By | Milestone |
|---|---|
| Oct 13 | Step 1–2 backend (migration, order-path fixes) deployed; shop route + hooks on a desktop dev build against prod data |
| Oct 20 | Desktop editor + checkout end to end (free checkout → cancel) |
| Oct 27 | App tile (OTA to canary) + phone pass (sign-in, keyboard, readability) |
| ~Oct 20 | Printed canary ordered through the real flow (held → inspected → released) |
| ~Oct 30 | Canary cards delivered to Houston (also the physical 5R proof); fixes |
| ~Nov 10 | P3: switch to `all` |

**Must-haves for Nov 10:** switch, editor, CAS saving, checkout, app tile,
phone readability/keyboard. **Cut if late:** film preview player (link to
the public page instead), dev fixture, Maestro flow, reorder button (reorders
then go through support).

## 2. Owner decisions (2026-10-06)

| Area | Decision |
|---|---|
| Create flow | **In the app**: the Keepsakes tile opens a sheet to pick the greeting (fixed afterwards — baked into the film), the app calls `holiday-cards create`, then opens the shop editor. |
| Visibility | **Server switch** like the Year Film rollout (`off` / `canary` / `all` + closing date); flip to `all` on launch day without an app update. |
| Shop language | **English only** (like the Memory Book shop); card content stays in the family's language. |
| Ordered cards | Content **locks after the first paid order**; **reorders of the same card** stay allowed (owner, 2026-10-04) and print exactly what was printed the first time. |
| Sign-in handoff | **Build it, for cards AND Memory Books** (owner, 2026-10-06): app taps open the shop already signed in (§5 Step 2b). |
| Paid canary | **Printed canary** (owner, 2026-10-06): the owner orders his own card through the real app → shop → Stripe flow (20 cards to his Houston PO box); the Gelato confirm is **held** first (hold list), we inspect, then **release** it so Gelato prints and ships — proving the whole paid path (webhook, hold, release, confirm, production check of the one-PDF file, tracking, emails) AND serving as the physical 5R sample (the separate-files sample 05f43f74 was refused; a one-PDF re-sample was drafted and NOT ordered in favour of this). Real cost ≈ $21. P3 gate. |
| From P1 | US/CA only; one card per family per year; no letter rewrites or film refreshes; no illustrated front; owners/managers only; packs 1/2/3/5/10 = 10/20/30/50/100 cards at tiered per-card prices incl. shipping ($2.99 / $2.49 / $2.29 / $1.99 / $1.79 = $29.90 / $49.80 / $68.70 / $99.50 / $179.00; owner, 2026-10-06), tax added at checkout. |

## 3. What exists (verified 2026-10-06, three review rounds)

- **Shop** (`shop.usemomora.com`): Worker `cloudflare/memory-book-web` serves
  `book-renderer/dist-web`; unknown paths fall back to `web.html`, so `/c/<id>`
  reaches the SPA. Router `src/web/router.ts`. Auth: email-code sign-in
  (`auth/LoginScreen.tsx` — step kept only in component state). No app→web
  handoff. `raceInvokeTimeout` (45 s, module-private in `order/ordersApi.ts`);
  `describeFunctionError` drops status/code. Address: `AddressStep` →
  `StripeAddressForm` (Stripe Address Element: city required, 2-letter US/CA
  states) / `AddressForm`; both hardcode the book country list. Status UI is
  typed to book statuses. Fixture mode `?fixture=` (book slugs; DEV-gated;
  bundle check fails on "fixture" strings). `web.html` loads Google's variable
  Newsreader/Jakarta/Caveat on every route; print uses static vendored faces.
  Tests: node-env vitest, `tsc`, `build:web`.
- **Card editor from dogfooding** (`book-renderer/src/card/`): reusable pure
  layer (`types.ts`, `edits.ts`, `fromData.ts` — `resolveFront` falls back to
  the default when an id is missing, `document.ts` — `CARD_STYLE.fonts` used
  for measuring AND the print DOM, `textFit.ts`, `geometry.ts`,
  `greetings.ts`, `measure.ts`), components (`CardSheet`, `EditableSheet` —
  fixed-bottom text popover, `CardPhotoPicker` behind `FrontPhotoProvider`).
  Local-only: `preview/App.tsx` (zoom ≈ 1.76 px/mm at 375 px → the letter
  renders at ~6–7 px on a phone), `preview/useCardEdits.ts`, `preview.css`
  (global `body`/`html` rules), local photo provider, `card.html`.
- **P1 backend** (live): `holiday-cards` (`create`, `get` — no editor view or
  portraits, nulls `qrUrl` when revoked; `picker_pool` oldest-first raw
  offsets; `save_edits` CAS + 423 while a checkout is open; `delete`;
  `disable_link`), `holiday-card-orders` (`create_draft`, `quote`,
  `create_checkout` — loads the card **before** its order-level claim,
  snapshots that in-memory row, idempotency key from (order, hash, price,
  packs, currency, address), resumable, ≈33 s cold; `cancel_checkout`,
  `status` — buyer-only). No guard against two open checkouts per card.
  Reorders would rebuild the snapshot from live data (portraits fall back to
  the member's current profile; a deleted front fails). `checkFilmGate` prints
  no QR when the token is revoked. Billing gate on create/save/orders.
  Stripe returns to `…/c/<cardId>?order=<orderId>&checkout=success|cancelled`.
- **App**: Keepsakes `renderTab()` → `KeepsakeYearSection` (null for an empty
  year); books open the shop with `Linking.openURL`; roles via
  `canEditFamilyContent`; gate pattern `year_film_family_enabled` (service) +
  `year_films_enabled` (caller, with `billing_write_allowed`). Sign-in is
  email OTP only (accounts match the shop's). Release: EAS Update to 1.4.3
  and 1.4.2.

## 4. Data model (one migration + down-script)

- `holiday_card_settings` (single row): `mode off|canary|all` (default
  `off`), `canary_family_ids uuid[]`, `closes_on date` (UTC; null = open),
  `orders_enabled boolean default true` (ordering kill switch),
  `ship_by_note text` (optional checkout note, e.g. "Order by Dec 10 for
  Christmas delivery in the US"), `updated_at`. RLS on, no client grants.
- `holiday_card_family_enabled(p_family_id)` (service role): live family AND
  (`all` OR canary) AND (closes_on null OR UTC today ≤ closes_on).
- `holiday_card_summary(p_family_id)` (`authenticated`, owner/manager only):
  `{ enabled (switch AND billing_write_allowed), card_id, year, status,
  last_failure_code, ordered (any order in paid|submitted|in_production|
  shipped), language (en|es, same mapping as cardLanguageFor) }` for the
  newest non-deleted card of any year.
- **Card-level checkout claim**: `holiday_cards.checkout_order_id uuid`,
  `checkout_claimed_at timestamptz`; RPC `claim_holiday_card_checkout(
  p_order_id, p_expected_version) → card row` (service role): locks the card
  row; refuses `CARD_CHANGED` (version), `CHECKOUT_OPEN_ELSEWHERE` (another
  order in `checkout` or a fresh claim < 10 min), `card_ordered` only for the
  edit path (see below); sets the claim. `release_holiday_card_checkout(
  p_order_id)` clears it. Partial unique index `holiday_card_orders(card_id)
  where status = 'checkout'` as a backstop.
- `save_holiday_card_edits` (replaced): under its existing card-row lock,
  also refuses while `checkout_order_id` holds a fresh claim (423) and once
  any order is `paid|submitted|in_production|shipped` (409 `card_ordered`;
  explicit list — `failed`/`cancelled` never lock).
- `holiday_card_settings.hold_confirm_family_ids uuid[] default '{}'` —
  held canary: paid orders of these families are never confirmed at Gelato.
- `web_handoff_codes` (sign-in handoff): `code_hash text primary key`
  (sha256 of a 32-byte random code, **base64url**), `user_id uuid` (→
  auth.users, cascade), `created_at`, `expires_at` (created + 2 min),
  `used_at`. `enable row level security` + `revoke all … from anon,
  authenticated`. RPCs (service role): `create_web_handoff(p_user_id,
  p_code_hash)` (rate limit ≤ 10 per user per 10 min, deletes expired rows),
  `claim_web_handoff(p_code_hash) → user_id` (single winner: `update … where
  used_at is null and expires_at > now() returning user_id` — DB clock).
- Down-script `supabase/rollbacks/<ts>_holiday_cards_p2_down.sql`.

## 5. Steps

### Step 1 — Migration + pgTAP + types + TECH_SPEC
§4. pgTAP: switch modes/closes_on; summary per role, `ordered` across
buyers; claim RPC (version mismatch, second order, stale claim, release);
save refused under claim and after paid, not after cancelled. Regenerate
types.

### Step 2 — Backend changes (fix live P1 order-path gaps; deploy first)
- `create`: after the existing-card lookup, refuse a NEW card with 403
  `HOLIDAY_CARDS_DISABLED` when the switch is off for the family.
- `get` gains `editorView` from a new pure `buildEditorView`
  (`_shared/holiday-card-snapshot.ts`, sharing helpers with
  `buildCardSnapshot`): all ranked candidates as `frontOptions` plus the saved
  `frontImage` if it isn't a candidate; raw edits; portraits re-resolved per
  `get` (no R2 probes — portraits are square; photo sizes come from
  `front_candidates` / `memory_media.aspect_ratio`); **the chosen front signed
  from its original** (sharp preview; others from previews); one shared
  default-front resolver with `loadCardSnapshot`; `frontMissing` flag;
  `qrState` computed by the same logic as `checkFilmGate` + film state:
  `on` (published), `waiting_film` (rendering, the default before publish),
  `off` (chosen off, or token revoked — with a note), `unavailable` (no film:
  below floors, blocked, or render gave up); assets `file → signed URL` (1 h).
  Absent while `generating`.
- **Ordered cards read from the first paid order's frozen `card_snapshot`**:
  `get`'s view for an ordered card and every reorder use it (asset keys
  signed, same hash) — a reorder prints exactly what was printed; the QR gate
  still runs (revoked/blocked → refuse with a clear code, never a silently
  different card).
- `create_checkout`: takes `expectedEditsVersion`; takes the card-level claim
  via `claim_holiday_card_checkout` **before** loading, then snapshots the
  re-read card; releases on every failure path; a 23505 at the final CAS →
  `CHECKOUT_OPEN_ELSEWHERE` (and expires the Stripe session). Stripe
  `expires_at` = claim time + 35 min, **included in the idempotency key**
  (deterministic retries; test that a retry sends an identical body).
- `create_draft` / `quote` / `create_checkout`: 403
  `HOLIDAY_CARD_ORDERS_PAUSED` when `orders_enabled` is false.
- Sweep: age `checkout` orders 1 h after their session expiry (backstop; the
  webhook's `expired` handler is primary) and clear stale card claims.
- **Held canary** (`_shared/holiday-card-fulfillment.ts` `confirmPaidOrder`),
  **first, before any Stripe or Gelato call, failing closed**: read the
  order's `family_id` + the hold list (a read error → `'retry'`); if listed,
  `update … set failure_reason = 'HELD_FOR_CANARY' where id = … and status =
  'paid' and failure_reason is null and refunded_at is null returning id` —
  alert once only when a row returns; no row → `'blocked'`; never continue to
  the PATCH. Paid orders with a reason are skipped by the sweep's confirm
  pass and excluded from the deletion fence; the refund path (webhook
  `charge.refunded` → draft delete → `cancelled`; `finishRefunds` backstop)
  handles a held order; `finishRefunds`' `REFUND_NOT_CANCELLED` flag also
  matches `HELD_FOR_CANARY`. "Ordered" (lock + frozen snapshot) is defined
  only over `paid|submitted|in_production|shipped`, so a refunded/cancelled
  canary unlocks the card. Tests: concurrent webhook + sweep → one alert,
  zero PATCHes; settings read error → no PATCH; refund of a held order →
  draft deleted, cancelled, card editable again; unlisted families
  unaffected. **Runbook** (feature doc): add the family to the list → pay →
  inspect → **release to print** (below) or, to abort, refund the FULL amount
  in Stripe (before any family deletion) → verify cancelled + draft gone +
  files deleted. Empty the hold list before launch.
  **Release a held order** (owner runs, SQL editor): (1) `update
  holiday_card_settings set hold_confirm_family_ids =
  array_remove(hold_confirm_family_ids, '<family_id>');` (2) `update
  holiday_card_orders set failure_reason = null where id = '<order_id>' and
  status = 'paid' and failure_reason = 'HELD_FOR_CANARY';` — the update bumps
  `updated_at`, so the sweep's 6 h confirm timeout restarts; the next sweep
  tick (≤ 10 min, after the 2-min grace) confirms at Gelato (the PaymentIntent
  refund check runs first) → `submitted` → tracking. Order matters: removing
  the family first, or the order is held again.
- `picker_pool`: newest first, no empty pages (fill to `limit`), returns
  `aspectRatio` (null → square placeholder; `save_edits` probes on pick).
- Tests (Deno, fictional data) for each bullet.

### Step 2b — Sign-in handoff (cards and Memory Books)
- Edge Function `web-handoff` (`verify_jwt = false`, own checks):
  - `create` (JWT, permanent accounts only — not anonymous): mints a random
    32-byte code, stores its sha256 with the caller's `user_id` and a 2-min
    expiry, returns `{ code, expiresAt }`; rate limit 10 per user per 10 min.
  - `redeem` (no JWT; body `{ code }`): `claim_web_handoff`; on success
    `auth.admin.generateLink({ type: 'magiclink', email })` and returns only
    `{ tokenHash, maskedEmail, userId }` (`Cache-Control: no-store`) — **the
    browser calls `supabase.auth.verifyOtp({ token_hash, type:
    'magiclink' })` itself** (GoTrue's per-IP verify limit applies to the
    user's IP, not the shared Edge egress; no tokens in our response; no
    session on a server client). Any failure → 400 `handoff_invalid` (no
    oracle). Never logs the code, token or email. Note: `generateLink`
    replaces a pending emailed sign-in code — the fallback login handles the
    "wait N seconds" rate-limit message with friendly copy.
- App: `src/services/web-handoff.ts` `openShopUrl(url)`: only for
  `https://shop.usemomora.com/…` (anything else → plain open, no code);
  `create` with a 3 s timeout → opens `url#h=<code>`; on any failure opens
  the plain URL (today's behaviour); double-tap guard. Used by the book tile
  (`memory-books-body.tsx` `handleTilePress`) and the holiday card
  tile/sheet.
- Shop: read and strip `#h=` at **module top level in `main.tsx`** (before
  `createRoot`; also on `hashchange`), one memoized redeem promise
  (StrictMode-safe), render "Signing you in…" until it settles (no screen
  mounts for the old account meanwhile). **Redeem first**; if a different
  account is signed in, ask "Continue as j•••@gmail.com?" (masked email from
  `redeem`) before switching; only then `verifyOtp`, and revoke the old
  session with `signOut({ scope: 'local' })`. A same-user handoff also
  revokes the previous session locally (no orphan refresh tokens). After a
  handoff, a "Signed in as … · Not you?" chip. On failure: the normal login
  ("the sign-in link expired — enter your email"). Works for `/b/:id` and
  `/c/:id`. **Fix the existing shop "Sign out" to `scope: 'local'`**
  (today it signs the user out of every device, the app included).
- Security notes: the code travels only in the fragment (never sent to the
  shop Worker, Cloudflare logs or Referer; no browser analytics/Sentry in the
  shop), is single-use, 2-min, hashed at rest; sessions are the user's own.
  Accepted: a leaked 1-h access token can mint a web session (rate-limited);
  pre-Android-12 unverified apps could claim shop links (accept).
- Tests: Deno (create/redeem, expiry, reuse, anon refused, rate limit, no
  secrets in logs, no-store), pgTAP (grants, claim single winner, DB-clock
  expiry), shop vitest (hash parsing/strip incl. `-`/`_`, memoized redeem,
  account-switch prompt, local sign-out, fallback), app Jest (shop-origin
  guard, timeout fallback, double tap, tile opens `…#h=<code>`).

### Step 3 — Shop: route, API client, edit queue
- `router.ts`: `/c/:id` → a **lazy** card route chunk (its CSS/fonts load
  only there).
- `card/web/cardApi.ts`: typed clients; `raceInvokeTimeout` exported and
  parameterized (90 s for `create_checkout`); `CardApiError {status, code,
  currentVersion?}`.
- `card/web/useHolidayCard.ts`: `get`, polling 5 s while generating / 30 s
  while the film renders; server state separate from local edits; refetch on
  visibility and on image errors (expired URLs).
- `card/web/CardEditsProvider.tsx`: **one save queue per card above the
  route** (survives editor ↔ checkout); pending changes as rebased updater
  functions; serialized debounced `save_edits` with a timeout (a timed-out
  save refetches before retrying); 409 version → refetch + rebase once;
  423 → checkout banner; `card_ordered` → locked; exposes `flush()` and
  `idle`.
- `card/web/pickerProvider.ts`: `FrontPhotoProvider` over `picker_pool` +
  `get-media-url` coalescer; picked photo appended locally, reverted on a
  rejected save (`front_low_resolution`, `front_unreadable`,
  `MEDIA_NOT_PRINTABLE`, `MEDIA_NOT_FOUND`).
- **Fonts**: the card components take an injected font-family map — the shop
  passes aliased families (`MomoraCard Newsreader`, …) registered by a
  card-only loader from the vendored files; the print app keeps the current
  names (print untouched, no render-service change). Test: the editor
  measures with the registered aliases. CSS ported from `preview.css` with
  class scoping only (no `body`/`html`/`:root`).
- Sign-in fallback (no or expired handoff): card-aware copy ("Sign in to
  your holiday card" with the email of the Momora account); the login step
  persisted in `sessionStorage` so returning from Mail doesn't restart it.

### Step 4 — Shop: editor screen
`card/web/CardEditorScreen.tsx`:
- states: signed-out, forbidden/not found (wrong account → sign out &
  switch), preparing (after 5 min "taking longer than usual"), failed
  (retryable → "we're retrying"; terminal → support mail), ready, locked
  (ordered: frozen snapshot, order list, "Order more cards"), checkout open
  ("a checkout is open — it expires within 35 min"; the buyer can cancel it),
  `frontMissing` → forced re-pick;
- sheet + controls (layout, letter variants — stored tones classic /
  reflective shown as "Warm" / playful, whichever exist —, QR per `qrState`,
  change photo, greeting read-only); film: rendering note / preview via
  `get-year-film-url` (cut-line: link to the public page);
- **phone**: front/back toggle; the back is readable — tap the letter to open
  a full-width reading/editing sheet (the proofreading surface) sized with
  `visualViewport` so Save stays above the keyboard; tap-to-zoom on the
  front;
- "Order cards": enabled only when `idle` (save queue flushed, no failed
  save), not generating, and `qrState` ∈ {on, off, unavailable}
  (`waiting_film` → "your film is still being made — order when it's ready, or
  turn the QR off").

### Step 5 — Shop: checkout + order status
- `card/web/CardCheckoutScreen.tsx`: `create_draft` → quantity (10/20/30/50/100,
  per-card price + "Save X%" per option, hint "Shipping included · tax added at checkout";
  table in `card/checkout/cardPricing.ts`; `ship_by_note`) → address
  (`AddressStep` gains an `allowedCountries` prop → US/CA for cards; Stripe
  element enforces city + state; the manual form relies on the server rule +
  error map) → `quote` → summary with front/back thumbnails rendered from the
  **server-confirmed edits at the pinned version** →
  `create_checkout(expectedEditsVersion)` → Stripe. Reorders start at
  quantity with the frozen card.
- Timeout: re-call `create_checkout` with backoff (`CHECKOUT_IN_PROGRESS` =
  still running; it resumes a `checkout` order; deterministic errors return
  fast). No new status fields.
- Error-code map (one tested table): `COUNTRY_NOT_SUPPORTED`,
  `NOT_DELIVERABLE`, `OVER_COST_GUARD`, `ORDER_NOT_QUOTABLE`,
  `CARD_NOT_READY`, `CHECKOUT_IN_PROGRESS`, `CHECKOUT_OPEN_ELSEWHERE`,
  `CARD_CHANGED`, `QUOTE_STALE`, `ORDER_NOT_QUOTED`, `LETTER_OVERFLOW`,
  `SAFE_MARGIN`, `IMAGE_MISSING`, `IMAGE_LOW_RES`, `FRONT_PHOTO_UNREADABLE`,
  `NO_FRONT_PHOTO`, `NO_LETTERS`, `FILM_NOT_READY`, `FILM_BLOCKED`,
  `DRAFT_REJECTED`, `RENDER_UNAVAILABLE`, `GELATO_UNAVAILABLE`,
  `STRIPE_UNAVAILABLE`, `EMAIL_REQUIRED`, `HOLIDAY_CARD_ORDERS_PAUSED`,
  `ORDER_ALREADY_PAID`, `CHECKOUT_NOT_OPEN`, `ORDER_NOT_CANCELLABLE`,
  `ORDER_NOT_FOUND`, `PACKS_INVALID`, `SUBSCRIPTION_REQUIRED`, 401.
- Return: success → status panel (poll `status`; late webhook → "confirming
  payment", never a cancel button); cancelled → `cancel_checkout` (ref-guarded
  for StrictMode; `ORDER_NOT_CANCELLABLE` on one's own order = success) →
  editor; strip the query.
- **Consistent with the Memory Book's ordering** (owner, 2026-10-06): the
  card checkout mirrors `order/CheckoutScreen.tsx` (same full-takeover
  presentation, step order, address components, quote/summary layout,
  Stripe redirect and copy voice — shared presentational pieces extracted,
  book rendering unchanged); the order status after Stripe uses the same
  layout as `OrderStatusScreen` (thanks banner, `OrderProgressStepper` with
  card statuses mapped onto its steps, tracking, failure/refund copy); card
  orders are listed in `/orders` next to book orders (parallel buyer-only
  select on `holiday_card_orders`, merged newest first), and the card page
  shows the same "orders" link as the book page.
- Card status copy for `checkout|paid|submitted|in_production|shipped|
  failed|cancelled`.
- Dev fixture `?fixture=card` (inline fictional data, wired into `App()`'s
  fixture branch, DEV-gated) — cut-line item.

### Step 6 — App entry (Keepsakes)
- `src/services/holiday-cards.ts` (`fetchHolidayCardSummary`,
  `createHolidayCard` with the device timezone, `holidayCardWebUrl`),
  `src/hooks/useHolidayCard.ts`.
- `holiday-card-tile.tsx` rendered **above the year sections** for
  `canEditFamilyContent(role)`, shown when a card exists or `enabled`: none /
  generating / ready / failed / ordered; opens the shop through the handoff
  (`openShopUrl`).
- `holiday-greeting-sheet.tsx`: three greetings in the summary's language
  (strings mirrored from `card/greetings.ts`), confirm → create → open; errors
  inline (`HOLIDAY_CARDS_DISABLED`, `holiday_card_slot_used`,
  `SUBSCRIPTION_REQUIRED`, network); `regionWarning` → "Cards ship to the US
  and Canada". No text input.

### Step 7 — Tests
Shop vitest: router, editor state reducer, edit queue (edit → immediately
Order waits for the flush; timeout; rebase), picker provider, QR-state
table, checkout machine + error map + timeout retry, `allowedCountries`
(books unchanged), status copy, font-alias measurement; `tsc`, `build:web`
bundle check; **book view smoke** (shared shell). Backend Deno + pgTAP
(Steps 1–2). App Jest (tile states, sheet → create → `openURL`, errors,
keepsakes integration). Maestro (cut-line).

### Step 8 — Docs, deploy, owner pass
Feature doc (client integration, extension guide, canary SQL), keepsakes.md,
TECH_SPEC. Deploy (owner runs): migration → `holiday-cards`,
`holiday-card-orders`, `sweep-holiday-card-orders` → shop (`build:web` +
`memory-book-web`; smoke a book too) → EAS Update (1.4.3 + 1.4.2). Owner adds
his family to the canary (and the hold list); phone + desktop pass;
**printed canary order** (P3
gate). Rollback order: app OTA → shop (`wrangler rollback`) → functions →
migration (down-script).

## 6. Rollout

Canary (owner's family) → owner pass + printed canary (held → inspected →
released → delivered) → P3: `all` ~Nov 10,
`closes_on` (proposal Dec 31), `ship_by_note` set for the Christmas cutoff.
Existing cards stay reachable after closing.

## 7. Risks

- **Web sign-in friction**: the handoff (Step 2b); fallback = email code.
- **Handoff security**: fragment-only, single-use, 2-min, hashed code; a
  leaked code is useless after first use or 2 minutes.
- **Editor/print drift**: shared builder helpers, shared default-front
  resolver, QR state from the gate logic, font aliases from the same files;
  the checkout render stays the final gate.
- **Money path**: new claim/idempotency code on top of a paid path that has
  never run with real money → printed canary before P3.
- **Phone readability/keyboard**: reading sheet + `visualViewport`.
- **Old app builds**: no tile (OTA-only feature).

## 8. Out of scope

Spanish shop UI; editing after the first paid
order; deleting a card from the UI; illustrated front; mailing to recipients.


## 9. Owner tasks

Canary + hold-list SQL; phone + desktop pass; printed canary order (pay, then
run the release SQL after inspection); P3 flip (empty the hold list).

## 10. Open questions

None — answered 2026-10-06: build the handoff (cards + books); a printed
canary (held, inspected, released) as the P3 gate and the physical sample.

## 11. Review log

**Round 1 (Sonnet 5.5, completeness & correctness)** — 8 findings, all
accepted (verified: the print builder freezes one front; the empty-year guard;
orders are buyer-only). Applied: a separate `buildEditorView` (all
candidates, preview keys, unfrozen edits, QR toggle round-trip, cached
portrait dims); service-role switch + caller-facing summary with the billing
gate, switch checked after the existing-card lookup, down-script; typed
`CardApiError`, exported `raceInvokeTimeout`, full error-code map,
`create_draft` in the sequence, checkout timeout → poll; address components
take a country list, required city + state select + client mirror of the
server rule, "plus tax", no fake delivery estimate; tile from a summary RPC
(ordered across buyers, language), shown whenever a card exists, failed
state, placed above the year sections; picker provider contract (coalescer
thumbs, aspect → size, newest-first + no empty pages server-side, local
append + revert); checkout-lock states for buyer vs other manager; ordered
cards read-only with a server guard, no reorders; URL refresh, edit/poll
separation, font-failure state, film preview via `get-year-film-url`,
inline fictional fixture, Maestro canary account.

**Round 2 (Sonnet 5.5, failure modes & risks)** — 16 findings, all accepted
(verified: no guard against two open checkouts per card). Applied: version
pin on checkout (`expectedEditsVersion` → `CARD_CHANGED`) + thumbnails in the
summary, edits refused during a fresh claim; one open checkout per card
(index + `CHECKOUT_OPEN_ELSEWHERE`); **reorders restored** (owner's 10-04
decision — round 1's "no reorders" was wrong): content locks after the first
paid order, reorders print the same card; QR tri-state (`waiting_film`
default, no surprise `FILM_NOT_READY`); chosen front always in the editor
view + shared default-front resolver + `frontMissing`; no CSS/font leakage
into the live book shop (lazy route, scoped CSS, aliased font families);
mobile keyboard full-screen editor; any manager can cancel an open checkout,
30-min Stripe sessions, 1 h aging; `status.preparing` / `lastCheckoutError`
for timeout recovery; portraits re-resolved per `get` with a dimension cache;
orders kill switch; summary = newest card regardless of year + `slot_used`;
paid canary as an open question; explicit ordered-status list; sign-in /
forbidden / 401 states, extra error codes, StrictMode-safe cancel, late
webhook copy; rollback order; save queue with timeout + rebased updaters;
retry/"taking longer" states, null-aspect picks, fixture wiring, greeting
strings in the app.

**Round 3 (Opus 5.5, holistic)** — 11 findings, all accepted. Applied:
Stripe `expires_at` derived from the claim time and included in the
idempotency key (otherwise every retry is rejected); a **card-level checkout
claim RPC** that serializes version pin, one-checkout-per-card and the edit
lock under the card-row lock (replaces round 2's order-level checks), 23505
→ `CHECKOUT_OPEN_ELSEWHERE`; ordered views and reorders come from the first
paid order's frozen snapshot (a reorder can't silently differ); one save
queue above the route, Order waits for the flush, thumbnails from the
server-confirmed version; `qrState` from the same logic as `checkFilmGate`
(revoked → off, blocked/given-up → unavailable, rendering → waiting);
injected font-family map — aliases in the shop only, print untouched (the
real drift risk is Google's variable faces on every route); sign-in handoff
raised as an owner decision (§10 Q1) + `sessionStorage` login step; phone
readability (reading/editing sheet, tap-to-zoom); `status.preparing` /
`lastCheckoutError` dropped (re-call `create_checkout`); milestones,
must-haves and cut line; paid canary as the P3 gate (§10 Q2); the chosen
front signed from its original (sharp), `ship_by_note`. Simplified: portrait
probing and `view_cache` dropped (portraits are square; sizes from stored
aspect ratios); manager-cancel of another buyer's checkout dropped (35-min
expiry + copy); address change reduced to an `allowedCountries` prop.
Superseded from round 2: order-level claim checks, `slot_used`, 30-min
`expires_at`, the new status fields, `view_cache`.

**Handoff + held canary review (Opus 5.5)** — added after the owner chose
both (2026-10-06); 11 handoff + 6 canary findings, all accepted: redeem
first, account-switch prompt with masked email, local (not global) sign-out
— also fixing the existing shop "Sign out", which signs users out of every
device; browser-side `verifyOtp` (server-side would hit GoTrue's per-IP
limit on shared egress and taint a service client); hash handled before
React mounts, memoized redeem, "Signing you in…"; base64url codes;
`openShopUrl` origin guard, timeout, double-tap guard; orphan sessions
revoked; table RLS + revokes, DB-clock claim RPC, expiry purge in `create`,
no-store; generateLink side effects noted. Held canary: fail-closed CAS hold
before any external call, refund-flag coverage, "ordered" defined over paid
statuses only (a refunded canary unlocks the card), runbook (full refund,
before family deletion, empty the list before launch).

## 12. Printed canary (2026-10-06)

Owner's family, through the real flow (app tile → greeting → "being made"
→ ready push → shop signed in via the handoff → edit → checkout → Stripe):
order `c77ae4f1…`, 10 cards, $29.90. Pay-first pipeline after payment:
one 2-page 5R PDF rendered (fonts embedded, 185.9 × 135.1 mm), Gelato draft
`7511ad5b…` (1 pack, single `default` file, product + reference + address
correct), **held** (`HELD_FOR_CANARY`) before confirm; inspected; released by
SQL at 16:31 UTC → sweep confirmed at 16:40 → Gelato `passed` at 16:41
(the US one-PDF layout clears Gelato's production check). Delivery to the
Houston PO box pending (≈ 7–9 days) = the physical 5R proof.

Fixes found during the canary walk: OTA overwritten by another thread
publishing from an older base (republished from main — publish OTAs only from
an up-to-date main); Wrangler needs Node 22 (`.nvmrc` added); autofilled
spaced ZIP+4 accepted + disabled-button hint; stray QR copy removed from the
summary; card waits for its film + ready push; stay in the app after create;
tiered pricing with a 10-card option; pay first, render after (like the book).

Remaining before P3 (~Nov 10): cards delivered + inspected; empty the hold
list; set `ship_by_note`; `mode = 'all'`, `closes_on`.
