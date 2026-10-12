# Birthday Cards — one-off folded card mailed to a relative (Plan)

**Status:** plan, hardened 2026-10-12 (3 review rounds: Sonnet ×2, Opus); B0 not started
**Siblings:** [holiday-cards.md](holiday-cards.md) (C0–C5 dogfood, letters, front picker) ·
[holiday-cards-p1.md](holiday-cards-p1.md) / [holiday-cards-p2.md](holiday-cards-p2.md) (backend, shop, app) ·
[stickers.md](stickers.md) (shares the Printful order layer built here) ·
feature doc to come: `docs/features/birthday-cards.md`

## 1. Outcome

A new Keepsakes product: a **birthday card for someone in the family** (Grandma,
an aunt, the other parent), made from the family's memories and **mailed
directly to the recipient** (or to the parent, to tuck into a gift).

- **Front:** preferably a real photo of the recipient **with the kids**; if
  there is no good one, an AI illustration of the kids with the recipient
  built from their portraits.
- **Inside:** a short message to the recipient **in the kids' voice**, written
  from the journal's memories with that person, signed by the kids. Editable.
- **Format:** Printful folded greeting card, 4″×6″, 350 gsm, envelope included.
  **US only.** No QR / film in v1.
- **Discovery:** Momora knows birthdays (`family_members.date_of_birth`). About
  four weeks before a birthday the Keepsakes tab surfaces it and we send one
  push. Parents can also make a card for anyone else, any time.

Done = an owner/manager in the US can, from the Keepsakes tab, make a card for
Grandma, edit it in the shop, pay, and Grandma receives it before her
birthday; and the same flow worked end to end for Eduardo's family on paper
(B4) before any product surface shipped.

## 2. Locked decisions (owner, 2026-10-12)

| Area | Decision |
|---|---|
| Format | **Folded**, Printful Greeting Card **4″×6″** (variant `14457`). 5×7 is EU-only at Printful; owner accepted 4×6. |
| Vendor | **Printful** (also used by [stickers.md](stickers.md)). Gelato rejected (folded cards bill at the 10-card tier: ~$15.70 for one US card); Prodigi Mail4Me rejected (UK-only print). |
| Regions | **US only.** No new VAT registrations (owner). Dogfood sample ships to the owner in Portugal from Printful's EU site (same variant). **Plus a US sample** (owner's Houston PO box, US facility + USPS; owner confirmed 2026-10-12), because Lisbon cannot measure US production, transit, packaging or packing slip. |
| Recipients | Any family member **except own children** (kid test = `isOnboardingKid` semantics, see §8.1) and except the buyer's own "this is me" member. Kids excluded as recipients (owner). Pets (`relationship = 'pet'`) excluded too. Note `isOwnChild` treats an **unsorted** member (no `relationship`) under 13 as an own child, so an unsorted young cousin is excluded until someone sets their role; acceptable for v1 (a young cousin is rarely a card recipient) and listed in §9. |
| When | "Coming up" birthdays highlighted, **plus** "someone else" any time (e.g. ship to yourself to add to a gift). |
| Address | Entered in the shop at checkout, **never saved for reuse** (owner). |
| Who | Owners/managers on a paid plan (`billing_write_allowed`). Viewers never see it. |
| One per occasion | One card per recipient per birthday per family. A second parent sees "{Name} started a card". Reorder of the same card to another address is allowed. |
| Reminders | One push ~4 weeks out + the needs-you line. A **family-level "don't remind me"** per person lives in a new **Keepsakes settings** screen (not the family-member edit screen). **Muted = hidden** from the product page, needs-you and push. |
| Entry points | **Keepsakes tab only**: storefront tile → native product page → shop. Push and needs-you deep-link to the product page. Nothing on family-member profiles. |
| Prices | Never in the app (Keepsakes rule); shop only. |
| Process | **Dogfood stages on the laptop first** (§7, B0–B4) on Eduardo's family, like books and holiday cards; then the product (§8). |

## 3. Provider: Printful

**Product:** Greeting Card, catalog product `568`, variant `14457` (4″×6″),
350 g/m² paperboard, toner print, complimentary envelope. Availability
(catalog API, 2026-10-12): `14457` in stock in `US`, `EU`, `EU_LV`.
Placements and print files (mockup-generator printfiles API, 2026-10-12):
`front`, `inside1`, `inside2`, `back`, each **1842×1240 px @ 300 dpi**
(≈6.14″×4.13″: the 6×4 panel plus bleed). Which physical panel each placement
is, the fold orientation (landscape panels per the file shape; portrait card
needs rotation?), bleed and safe area are **verified in B0** with Printful's
template and the mockup generator, not assumed.

**Live quotes (shipping-rates API, store created 2026-10-12, USD, excl. tax):**

| To | Item | Shipping (STANDARD) | Delivery days (Printful estimate) |
|---|---|---|---|
| US (DC) | $2.50 | $4.49 | **10–11** |
| PT (Lisbon) | $2.50 | $4.29 | 4–6 |

So one US card costs us **≈ $7.00 + tax** delivered. The 10–11-day US estimate
drives the dates in §5.

**API notes (to verify in B0, not assumed):**
- Orders API: create as **draft** (`confirm=false`) and confirm later
  (draft → pending); `external_id` (unique per store; `@<external_id>` lookup)
  = our order id. Cancel is possible while draft/pending, not once "in review"
  / "in process".
- **Packing slip prices:** Printful's docs say the packing slip shows retail
  prices if items carry `retail_price`, **otherwise Printful's own prices**.
  A gift card must show **no price**. B0 must find the mechanism (packing-slip
  settings / `packing_slip` fields / `gift` message / zero retail) and B4 must
  prove it on paper. **If no price-free slip is possible, stop and re-decide
  with the owner** (it is a gift).
- Gift note: whether the order can carry "From Theo & Mia" (order `gift`
  subject/message or packing-slip message) — B0/B4.
- Webhooks (package shipped, order failed/canceled/put on hold): whether
  requests are signed is unverified. **Design assumption: a webhook is only a
  hint**; the handler re-reads the order from the Printful API by
  `@external_id` before changing state, and the sweep polls anyway. The webhook
  URL carries a secret path token as a cheap filter.
- Auth: private token `PRINTFUL_API_TOKEN` (local `.env.local`; later an Edge
  Function secret) + store id header `X-PF-Store-Id` (the one "Manual order
  platform / API" store).

## 4. Reuse map

From the 2026-10-12 code survey. "New" items are written as pure `_shared`
modules from B1 on (book lesson), so passing a stage means the production
logic passed.

| Need | Reuse | New |
|---|---|---|
| Recipient list + birthdays | `family_members.date_of_birth`, `relationship`, `family_side`; `isOwnChild` (`_shared/family-relationships.ts`, `src/utils/family-relationships.ts`); `family_memberships.family_member_id` ("this is me") | `_shared/birthday-card-recipients.ts`: next occasion, order-by date, eligibility, mute filter |
| Front photo pool | `memory_family_members` (memory-level tags only), `memory_media`, ranged-R2 probe (`probePhotoDimensions` in `_shared/holiday-card-generate-front.ts`), vision judge (`buildFrontJudgeSystemPrompt`, `parseFrontJudgeResponse`, `rankFrontPicks` in `_shared/holiday-card-photos.ts`) | `_shared/birthday-card-front.ts`: pool = memories tagged with **recipient + ≥1 own child**; judge prompt adds "is the recipient (reference photo) visible?" (pattern: `_shared/year-film-vision.ts` `FrameCheck` with reference photos) |
| Illustrated fallback | Memory-illustration prompt + portrait refs (`buildIllustrationPrompt`, `prepareIllustrationReferences`), portrait resolution (`resolvePortraitVersionAtDate` in `_shared/portrait-versions.ts`), the holiday C1 illustrated-scene code in `eval-holiday-card-front.ts` | Birthday scene prompt (kids + recipient, celebration, no text in image) |
| Message | Holiday letter v2 editor + writer (`_shared/holiday-card-letter-v2.ts`), pool digest (`_shared/holiday-card-digest.ts` `buildDigestFromPool`), quote check (`verifyLineOfYear`), family voice (`_shared/holiday-card-voice.ts`), language resolution (`resolveLetterLanguage` in `_shared/holiday-card-letter.ts`) | `_shared/birthday-card-message.ts`: kids'-voice message to one recipient, 3 tones, hard length cap for the 4×6 inside panel, digest scoped to memories tagged with the recipient |
| Card layout + print | `book-renderer/src/card/*` (geometry, `textFit.ts`, fonts, `fromData.ts`, `preview/`, `print/CardPrintApp.tsx`), `book-renderer/scripts/render-card-pdf.mts`, raster check | `book-renderer/src/birthday/*` templates: front, inside1, inside2, back; **PNG** per placement at exactly 1842×1240 (new output type: the existing `/render-card` path is PDF-only, `CARD_FORMAT_VALUES = ['5R','A5']`, pdf-lib split). Exact pixels via Puppeteer `page.screenshot` on a 1842×1240 viewport at DPR 1, then a raster check (size, no transparency, fonts loaded) |
| Assets for local renders | `eval-holiday-card-assets.ts` pattern → `book-renderer/card-data/<slug>/` | `eval-birthday-card-assets.ts` → `book-renderer/birthday-data/<slug>/` (gitignored) |
| Data access for evals | `year-film-eval-data.ts` (`createAuthedClient`, magic link for `EVAL_USER_EMAIL`, RLS-scoped) | — |
| Printful | Gelato client shape (`_shared/gelato.ts`: typed errors, `normalizeFulfillmentStatus`) | `_shared/printful.ts` (shared with stickers) |
| Shop editor + checkout | `book-renderer/src/web/` (router, `card/` editor, `card/checkout/`, `order/` Address/Stripe forms, `edits/`), `web-handoff` + `openShopUrl` | `/bc/<cardId>` route + editor; shared Printful checkout; a `print_orders` adapter in the shop's order history (`order/useOrders.ts`, `orderListItems.ts` `kind`, `useHasPastOrders.ts`) |
| Orders/payments | Holiday-card order shape: pay first, snapshot + `snapshotHash`, Stripe Checkout, `stripe-webhook` routing by `metadata.productType`, `confirmPaidOrder` idempotent steps, sweep passes, order-notify emails | Product-agnostic Printful order layer (§8 P1), `productType: 'birthday_card'` |
| Keepsakes surfaces | `KEEPSAKE_PRODUCTS`, `keepsakeProductRoute`, `product-page.tsx`, `FreeToMake`, `PrivacyNote`, `pickNeedsYou`, `buildShelfItems`, `keepsakes_overview` (latest: `20261012120000_keepsakes_overview_reveal_gap.sql`) | Product page, needs-you kinds, shelf kind, overview fields, Keepsakes settings screen |
| Push | `_shared/expo-push.ts` (`PushRouteData`), `src/hooks/useNotifications.ts` (`routeFromPushData`); recipients gated by `user_profiles.notify_new_memories` like `schedule-year-films` | New route value `birthday-card` (both files, kept in sync) |
| Paid gating | `billing_write_allowed`, `checkBillingFamilyWrite` (`_shared/billing.ts`) | actions `birthday_card_create` / `_edit` |
| Usage | `ai_usage_events` operation enum (+ image reservation path for the illustrated fallback) | `birthday_card_*` operations |

## 5. Dates (server-owned, adjustable without an app update)

Printful US: production (2–5 business days, verify) + **10–11 days** shipping.
Constants live server-side (in the overview/summary RPC or a settings row, like
`holiday_ship_by_note`), never in the app:

| Constant | Initial value | Meaning |
|---|---|---|
| `COMING_UP_DAYS` | 60 | birthdays listed under "Coming up" |
| `REMIND_DAYS_BEFORE` | 35 | push + needs-you start (owner said ~3 weeks; moved to 5 because of production + 10–11-day shipping, leaving a 2-week decision window) |
| `ORDER_BY_DAYS_BEFORE` | 21 | suggested last day to order: production max (~7 calendar days) + transit max (11) + pay→confirm latency and weekend buffer (~3). Shown as "order by {date} to arrive in time" — a recommendation, never a guarantee |

- Dates are computed in the **family owner's local date** (same rule as the
  year films / recaps), never the device clock.
- After `ORDER_BY` the row still allows ordering with a soft warning ("may
  arrive after the birthday" / "great if you're shipping to yourself"); the
  needs-you line and push stop.
- Feb 29 birthdays → Feb 28 in non-leap years.
- B4b (the US sample) measures the real **end-to-end** time (confirm → delivered, not only
  transit); the constants are set from it before launch, and the sweep logs
  confirm→shipped→delivered durations in production so they can be tuned.

## 6. Guardrails

- **Audience = the recipient** (family, but not the household): no health /
  medical / bath / potty / `tough-days` moments, no sad or worried moments, no
  quoted speech from people outside the family. The message may mention any
  share-safe moment (it is from the kids), weighted toward moments with the
  recipient. Reuse the holiday share-safety filters.
- **Facts from the journal only.** Never invent shared moments with the
  recipient. If there are few memories tagged with them, the message stays
  general and warm instead of fabricating ("We can't wait to see you!").
- **Age is printed only when the birth year is known** (owner, 2026-10-12);
  the parent can remove it in the editor; never guessed.
- **Address PII:** not saved for reuse. It necessarily exists on the order
  (Stripe session, Printful order) and on our order row for fulfillment and
  support; our row's address is **purged at `shipped_at` + 45 days** (absolute
  cap: created + 120 days) by the sweep (§8.1). Never logged.
- **Eval PII:** outputs only in gitignored dirs, stdout counts-only, logs ids
  and codes only (holiday-card conventions). The repo is public: no family
  data in fixtures.
- **Print verification:** only rasterized output proves print correctness;
  every placement PNG is checked as a raster at 1842×1240.

## 7. Validation plan — dogfood-first (B0–B4), then product

B-stages are eval scripts, local previews and one real order: **no
migrations, no app code, no deploys.** Results are recorded in this file as
`### B<n> results` and `### B<n> owner review round N`.

Conventions (same as `eval:holiday-card-*`):
- Deno scripts `supabase/scripts/eval-birthday-card-*.ts`, npm scripts
  `eval:birthday-card-*` with `--env-file=supabase/.env.local
  --env-file=.env.local`. Read-only through the RLS-scoped client
  (`year-film-eval-data.ts`). Exception: B4's order script writes to
  Printful, never to our DB.
- Outputs only in gitignored places: `supabase/scripts/eval-output/birthday-card/`,
  `book-renderer/birthday-data/` (add both to `.gitignore` in B0).

| Stage | Build | Review artifact | Pass question |
|---|---|---|---|
| **B0 — Audit + Printful spec** | `eval:birthday-card-audit`: every non-own-child member with a DOB: next birthday, days to it, memories tagged with them, photos tagged with them **and** ≥1 own child (count, recency, print size via ranged probe), whether they have a ready portrait, whether a reference photo exists (portrait version source photo). Plus `scripts`/notes for the Printful spec: placements ↔ panels, orientation, bleed/safe area (template + mockup generator), packing-slip/gift options, webhook signing + event list (is there a "delivered" event?), order lifecycle, `external_id` reuse after cancel/delete, file-fetch timing vs signed-URL TTL, Stripe Tax code for printed cards. Add gitignore entries. | Markdown report in `eval-output/birthday-card/` + a "Printful spec" section in this plan. | For how many relatives is a real-photo front realistic? Is a price-free packing slip possible? |
| **B1 — Front** | `_shared/birthday-card-front.ts`: pool (recipient + ≥1 own child tagged, last 24 months preferred, print class) → vision judge with the recipient's reference photo ("recipient visible, face visible", kids visible, light, sharp, crop survives 4×6). Illustrated fallback: birthday scene of the kids + recipient from portraits. `eval:birthday-card-front --member <id>` for 2–3 relatives. | HTML review page per relative: top picks with why, near-misses with why, the illustrated fallback. | Is the top pick the photo you'd mail Grandma? Is the illustration good enough as a fallback? |
| **B2 — Message** | `_shared/birthday-card-message.ts`: digest of memories tagged with the recipient (recent-weighted, share-safe) + the kids' details → 3 tones (warm / playful / short), kids' voice, family language (es/en), **hard cap fitted to the inside panel** (~60–80 words, set from B3's text-fit), quote check, signature default "Love, {kids' names}". Thin case: few/no tagged memories. `eval:birthday-card-message --member <id>`. | HTML: messages next to the memories they cite; thin-recipient variants. | Would you send it with light edits? Does it sound like the kids, not a greeting-card company? |
| **B3 — Design + print files** | `book-renderer/src/birthday/` templates: front (full-bleed or bordered photo, "Happy Birthday, {name}" in the family language), inside1 (small photo/illustration or quiet art), inside2 (message + signature), back (small Momora mark). Text auto-fit. `birthday:preview` + `birthday:png` → 4 PNGs at 1842×1240 + raster check. `eval:birthday-card-assets`. | On-screen preview + the 4 rasterized placements + Printful mockup-generator images. | Premium at 4×6? Message readable? Photo holds up? |
| **B4 — Physical samples** | `eval:birthday-card-order` (owner-run, explicit `--confirm` flag): uploads the B3 PNGs, creates a Printful **draft** with `external_id`, packing-slip/gift settings from B0, shows cost, confirms only with `--confirm`. **B4a → Lisbon** (hand-feel, fast loop). **B4b → the owner's Houston PO box** (US facility, USPS: the product as customers get it; can share one order with the S2 stickers). Logs order id only; records confirm → shipped → delivered for B4b. | Cards in hand + outer packaging + packing slip + delivery time. | Paper and colour? Packaging feels like a gift? **No price on the slip?** Gift note present? **§5 constants set from B4b's US timing.** |

**Gate:** B(n+1) waits for B(n), except B1 and B2 are independent and can
overlap, and B3 can start on placeholder content once B0's spec is in. B4
needs B3. The product plan (§8) is hardened separately **after B4 passes**.

## 8. Product outline (P0–P2; hardened as its own plan after B4)

**P0 — Shared Printful order layer** (also used by stickers). The holiday
flow already creates the vendor **draft before payment** and only *confirms*
it after (`docs/features/holiday-cards.md`; `confirmPaidOrder` in
`_shared/holiday-card-fulfillment.ts`), which maps 1:1 onto Printful's
draft → confirm. So P0 is a **Printful vendor adapter on the existing
pre-pay-draft structure**, not a re-derivation. Abandoned drafts (Stripe
session expired) are deleted by the sweep. P0 is hardened as **its own
product-agnostic plan** once either B4 or S2 passes; whichever product is
ready first is its first consumer.
- `_shared/printful.ts`: typed client (`createDraftOrder`, `confirmOrder`,
  `getOrder` by `@external_id`, `cancelOrder`, `shippingRates`, file upload by
  URL), error classification, status normalization, a browser-like
  `User-Agent` (Gelato lesson).
- One table **`print_orders`** for all Printful products (`product_type` in
  `birthday_card | sticker_pack`), not a per-product copy of
  `holiday_card_orders`: status machine, Stripe ids, `printful_order_id`,
  `external_id` = our id, frozen `snapshot` + `snapshot_hash`, shipping
  address (purged per §8.1), costs. RLS: owners/managers of the
  family read; writes via Edge Functions only.
- One rollout row per product (`print_product_settings`: mode off/canary/all,
  `canary_family_ids`, `orders_enabled`, `hold_confirm_family_ids`), the holiday
  pattern generalized.
- `stripe-webhook`: every `productType` switch site gets the new types, not
  only the checkout classifier: `classifyCheckoutSession`-style routing
  (`stripe-webhook/index.ts` ~L672–677, today `holiday_card` else `unknown`,
  absent = book), `checkout.session.completed` / `.expired`, and the
  refund/dispute path keyed on `{productType, orderId}` metadata (~L555–584).
  P0 starts with a grep of `productType` across `supabase/functions/` and
  lists every site in the P0 plan. A session with no productType still goes to
  books; an unknown type stays a logged no-op.
- R2 print files under a **distinct prefix** `print-orders/printful/<orderId>/`
  so the holiday sweep (which cleans `print-orders/<orderId>/`, see
  `printFilesPrefix` in `_shared/holiday-card-fulfillment.ts`) and the new
  sweep never touch each other's files.
- `supabase/config.toml` `[functions.*]` entries: `sweep-print-orders`
  (cron secret, `verify_jwt = false`) and `printful-webhook`
  (`verify_jwt = false`, secret path token), following the holiday entries.
  Cron schedule via a pg_cron migration (precedent
  `20260929120100_schedule_year_films_cron.sql`).
- Secrets: `PRINTFUL_API_TOKEN`, `PRINTFUL_STORE_ID` added to the Edge
  Function secrets and to the env docs (`AGENTS.md`/`supabase/AGENTS.md` env
  list, `.env.example` if present).
- `sweep-print-orders` (cron): confirm paid, track, age, purge addresses,
  finish refunds, release stale checkout claims.
- `printful-webhook` Edge Function: secret path token; re-reads the order
  before any state change.

**P1 — Birthday card backend:**
- Tables: `birthday_cards` (family, recipient member, `occasion_date` (the
  birthday, or null for "no birthday on file"), status, front candidates +
  choice, messages, edits, created_by, lease fields, soft delete);
  uniqueness: one live card per `(family_id, recipient_member_id,
  occasion_date)` (null-date cards: one per recipient per calendar year).
  `birthday_reminder_mutes (family_id, family_member_id, muted_by, muted_at)`.
  `birthday_card_reminders (family_id, family_member_id, occasion_date,
  sent_at)` for push idempotency.
- Generation: a new Workflow class in `cloudflare/year-film-worker/`
  (mirroring `HolidayCardWorkflow` in `src/card-workflow.ts`: front
  plan/probe/judge/store → message → finish) and bridge ops `bcard_*` in
  `supabase/functions/workflow-year-film-bridge/` (new `birthday-card-ops.ts`,
  HMAC + nonce like `card-ops.ts`, registered in `index.ts`). This couples
  birthday cards to the year-film worker's deploys, like holiday cards
  already are; accepted to reuse the bridge, binding and Sentry wiring.
  Illustrated fallback through the image reservation path (usage caps apply).
- Edge Functions `birthday-cards` (create, get, picker_pool, save_edits,
  delete) and checkout ops on the shared order function.
- Push: a **new daily cron function** `remind-birthday-cards` (pg_cron
  migration + `config.toml` cron-secret entry) sends one push per (family,
  recipient, occasion) once the family owner's local date
  (`user_profiles.timezone` of the family owner; one owner per family) reaches
  `occasion − REMIND_DAYS_BEFORE`, to owners/managers with a push token and
  `notify_new_memories` on (the same gate `schedule-year-films` uses for film
  pushes; the closest existing "Momora made something" preference — a
  dedicated toggle is out of scope). Skips muted recipients, occasions that
  already have a card, and rollout-off families. Idempotent via
  `birthday_card_reminders` (insert-first, then send). Route `birthday-card`
  with `memberId`.
- Push route sites (all four + tests): `PushRouteData` and its doc comment in
  `_shared/expo-push.ts`; `routeFromPushData`, `RECOGNIZED_PUSH_ROUTES` and a
  `routeToBirthdayCard` handler in `src/hooks/useNotifications.ts`;
  the push-route union in `src/services/analytics.ts`;
  `src/hooks/useNotifications.test.ts`. Apps older than the OTA ignore an
  unknown route (they open the app home), which is acceptable.
- Render: new `POST /render-birthday-card` on the Fly renderer
  (`render/memory-book-renderer/src/server.ts`, HMAC like `/render-card`):
  a birthday print entry in `book-renderer` (`birthday-print.html`), the
  Dockerfile/`env.ts` build of that entry, PNG screenshots per placement +
  raster check, upload to `print-orders/printful/<orderId>/<hash16>/`, tests.

**P2 — Shop + app:**
- Shop: `/bc/<cardId>` editor (`/b/` is taken by the Memory Book:
  `BOOK_PATH_PATTERN` in `book-renderer/src/web/router.ts`; router tests) (front picker, message tones + free edit,
  signature, optional age line), checkout (US address only, Stripe), order
  status. Prices only here.
- App (Keepsakes only):
  - Storefront tile "Birthday cards" (owners/managers, paid, rollout on;
    US-only stated on the page, enforced in the shop, see §8.1): sample front, subtitle with the next birthday when
    there is one. Registry work: `KEEPSAKE_PRODUCTS` +
    `KeepsakeProductContext` (today only `{canEdit, holidayCardEnabled}`; add
    the birthday rollout/eligibility flag from the overview) in
    `src/constants/keepsake-products.ts`; `KeepsakeProduct` +
    `keepsakeProductRoute` in `src/lib/routes.ts` (+ `routes.test.ts`); the
    tile object in `make-something-row.tsx`; page registered in
    `app/(app)/_layout.tsx`. Static routes `birthday-card` and `settings` sit
    next to the dynamic `app/(app)/keepsakes/[memberId].tsx`; a route test
    locks that the static ones win.
  - Product page `app/(app)/keepsakes/birthday-card.tsx`: "Coming up" (next
    `COMING_UP_DAYS`, name, date, "order by"), "Someone else" (all other
    eligible members), "Add {name}'s birthday" inline date picker for members
    without a DOB, with the "don't know the year" option (§8.1),
    "Manage birthday reminders" link. The DOB write reuses
    `updateFamilyMember` (`src/services/family-members.ts`, `dateOfBirth`)
    and the same React Query invalidations as the member edit screen; a DB
    rejection (DOB after an existing dated portrait, see
    `docs/features/portrait-timeline.md`) shows the same error copy as the
    edit screen. Side effect noted: a DOB can change `isOwnChild` for an
    unsorted member (under 13 → treated as a child and leaves the list).
  - Needs-you kinds: `birthday_upcoming` (from `REMIND_DAYS_BEFORE` to
    `ORDER_BY`, no card yet, not muted) and `birthday_card_ready`, slotted into
    `pickNeedsYou`'s priority list.
  - Shelf kind `birthday_card` with badges (making / ready / ordered /
    shipped), type filter entry.
  - **Keepsakes settings** screen `app/(app)/keepsakes/settings.tsx`, gear in
    the Keepsakes header (owners/managers): "Birthday reminders" list with a
    switch per member with a DOB. Family-level. Also linked from Settings →
    "Your journal".
  - Push route `birthday-card` opens the product page with the member
    preselected.
- Schema changes ship with migration + regenerated `src/types/database.ts` +
  `TECH_SPEC.md` in the same change (CLAUDE.md rule).
- Docs: `docs/features/birthday-cards.md`, `keepsakes.md` (product, needs-you
  kinds, shelf kind, "Adding a product" walkthrough check), `TECH_SPEC.md`
  (tables, functions, contracts), analytics (`src/services/analytics.ts`
  `AnalyticsEventMap` + `docs/features/analytics.md`), PRD §7 out-of-scope
  check, and **Printful added as a print processor** wherever vendors are
  listed (privacy policy / processor list, TECH_SPEC). Print files containing
  family photos and children's faces go to Printful: same exposure as
  Gelato/Prodigi (signed URLs with short TTL).
- Tests: units for recipients/dates/mutes, RPC pgTAP (RLS, uniqueness,
  mutes), Edge Function tests (billing, idempotency, webhook re-read), screen
  tests for the product page + settings, Maestro: Keepsakes → birthday card
  page → shop handoff.

### 8.1 Failure-mode requirements (review round 2; binding on the P0–P2 plans)

**Before payment**
- **Validate the address and price the order before Stripe.** The checkout op
  calls Printful shipping rates (and/or creates the draft) with the entered
  address *before* creating the Stripe session; undeliverable / non-US / PO-box
  rejections are shown in the shop, never discovered after payment. A margin
  guard (like holiday `maxCostCents` / `MIN_MARGIN`) refuses a checkout whose
  live cost exceeds the cap (AK/HI etc.).
- **Freeze before payment.** Snapshot + render the PNGs + copy them under
  `print-orders/printful/<orderId>/` at checkout creation (or at least
  snapshot with immutable copies of every source asset), so a deletion between
  pay and confirm cannot break a paid order.
- **One live checkout per card** (port `claim_holiday_card_checkout` /
  `release_holiday_card_checkout` with a TTL). A second paid order for the
  same occasion requires an explicit "order another copy" confirm in the shop,
  which shows "already ordered by {name} on {date}".
- **US-only is said up front.** No family-country field exists (holiday cards
  gate by the shipping address, `regionForCountry`), so the tile is gated by
  the rollout row only; the product page and shop say "We mail to US
  addresses only" before anything is made; the shop rejects non-US
  destinations before payment.

**After payment**
- **Files verified before confirm:** re-read the Printful order and require
  every file to be fetched/ok before `confirmOrder`; signed-URL TTL longer than
  Printful's fetch/retry window (verify in B0); a failed file = content
  failure → refund path.
- **Automatic refunds for our failures** (undeliverable after all, file
  failure, Printful cancel/fail before production): full Stripe refund +
  email, not the holiday "owner refunds by hand" rule. `package_returned` →
  owner alert (manual reship/refund).
- **`external_id` reuse:** B0 checks whether a cancelled/deleted order's
  `external_id` can be reused; if not, `external_id = <orderId>-<attempt>`.
- **Deploy order:** `stripe-webhook` (new productTypes, `handleChargeRefunded`
  lookup in `print_orders`) ships **before** any function that creates
  `print_orders` sessions, all behind the rollout row (today an unknown
  productType is a 200 no-op, so the reverse order would silently drop paid
  sessions). Chargebacks/disputes: no handler exists for any product today;
  out of scope, owner alert only.
- **Tax:** Stripe Tax code for printed greeting cards set in B0 (holiday
  passes `HOLIDAY_CARD_TAX_CODE`); Printful `costs.tax` read from the draft.

**Deletion and retention**
- `hard-delete-expired-accounts` (`collectFamilyStorageKeys`, today only
  `holiday_card_orders` + `print-orders/<id>/`) and `delete-family-member`
  learn `print_orders` + `print-orders/printful/<id>/`; `print_orders`
  cascades from `families`; pgTAP + Deno tests.
- **Address purge** keyed on a signal we actually get: `shipped_at + 45 days`
  (Printful may not send "delivered"; B0 checks), plus an absolute cap
  (created + 120 days) for orders that never ship. Printful-held copies follow
  Printful's retention (documented in the processor list).

**Surprise protection (the recipient may use the app)**
- The other parent is a headline recipient and is usually an owner/manager.
  Every surface is **per-viewer**: the overview RPC (Coming up, needs-you,
  shelf), push recipients, `birthday_cards` and birthday `print_orders` RLS,
  and order emails exclude any user whose `family_memberships.family_member_id`
  is the card's recipient. Order emails go to the buyer only. Residual gap: a
  co-parent who never set "this is me" can't be detected (copy on the product
  page: "Make sure everyone has set 'This is me' so surprises stay secret").
  pgTAP: the recipient-user sees no row.

**Kids, signers, and members without data**
- Kid test = **`isOnboardingKid` semantics** (`src/utils/family-relationships.ts`
  L174–188: an unsorted member with no DOB still counts as a kid), not plain
  `isOwnChild` (which returns false without a DOB). Used for recipient
  exclusion, the signer set ("Love, {kids}") and the front pool's
  "≥1 kid" test; parity across the TS copies and a SQL counterpart.
- **No portrait and no reference photo** for the recipient (a typical
  grandma): B0 counts this bucket; B1 defines the default front for it — the
  best kids-only photo, or a typographic "Happy Birthday, {name}" front — and
  the shop copy explaining it.
- **Birth year unknown (owner, 2026-10-12):** `date_of_birth` is a full date
  today, so a parent who only knows "March 4" must invent a year, which breaks
  age labels and (if recent) the kid test. Add a **"don't know the year"**
  option to the family-member birthday field (P1 schema change: e.g.
  `birth_year_known boolean not null default true`, the stored date keeps a
  placeholder year that every age computation ignores when false; exact shape
  decided in the P1 plan, with parity in `_shared/age.ts`, the app age utils,
  `isOwnChild`/kid tests and the portrait-date constraint). Birthday
  reminders and cards use month/day either way. **Age on the card:** printed
  ("Happy 70th, Grandma!") only when the year is known; the parent can remove
  it in the editor; never shown when the year is unknown. B0 measures how
  often adults have a DOB.
- **DOB coverage across families:** before hardening P1, an aggregate-only
  count (no names, counts only, owner-approved script) of adult-relative DOB
  coverage in production. If low, v1 = "make a card for anyone" + "Coming up",
  and push / mutes / settings become a fast-follow.

**Reminders**
- Uniqueness: partial unique index on `(family_id, recipient_member_id,
  occasion_date) where deleted_at is null and occasion_date is not null`, and
  one on `(family_id, recipient_member_id, occasion_year) where occasion_date
  is null`. A DOB edit **does not re-key** an existing card (the card keeps its
  `occasion_date`); a later "add birthday" on a null-date card leaves that card
  as is. pgTAP cases for both.
- Push data carries `familyId` + `memberId`; the handler reuses the
  family-switch logic of `routeToMemoryDetail` (`useNotifications.ts`). Test
  for a non-active family.
- The reminder cron's rollout flag turns on only after the OTA carrying the
  product page is adopted (older apps open home).
- **Deceased-relative safety:** besides the settings screen, the needs-you
  line and each "Coming up" row get a quiet "Don't remind me about {name}"
  action that writes the same family-level mute (still no buttons on member
  profiles; owner confirmed 2026-10-12). The first push copy stays neutral
  ("{Name}'s birthday is on {date}").
- Own-child rule has three copies (`_shared/family-relationships.ts`,
  `src/utils/family-relationships.ts`, SQL `year_film_is_own_child`); the
  overview RPC uses the SQL one; parity tests across all three.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Packing slip shows a price (Printful default) | B0 finds the setting; B4 proves it on paper; **stop and re-decide** if impossible. |
| Recipient rarely appears in photos with the kids (lives far away) | B0 measures it; illustrated fallback; the parent can pick any photo. |
| Tag says Grandma but she took the photo (memory-level tags, no face identity) | Judge with the recipient's reference photo (portrait source photo); unknown → not a top pick. |
| Message invents closeness | Digest only from memories tagged with the recipient; thin case is short and general; quote check. |
| Push to a family whose relative has died | Family-level mute; push only for members with a DOB and not muted; one push per occasion; copy is gentle ("Grandma's birthday is coming up"). |
| Two parents order twice | One live card per occasion; second parent sees "{Name} started a card" and opens the same card. |
| US delivery slower than estimated | Server-side constants, set from B4; soft warning after order-by. |
| Address retention | Purge at shipped + 45 d (cap created + 120 d); never logged; not reused. |
| Printful webhook spoofing | Webhook = hint; state only changes after an API re-read. |
| Unsorted young relative treated as own child by `isOwnChild` (DOB < 13, no role) and hidden | Accepted for v1; the product page footnote "Missing someone? Set their role in Family" (text only, no profile button). |
| Shared order table couples two products | `product_type` discriminator, product-specific snapshot builders; books and holiday cards keep their own tables untouched. |

## 10. Out of scope (v1)

QR / birthday film inside the card; cards for own children; non-US shipping
(EU/UK need VAT registration; Canada: Printful card not stocked there);
saved addresses / address book; scheduled send dates (order now, ships now);
multiple recipients per order; handwriting fonts from the parent; physical
signatures; Mother's/Father's Day cards (possible later on the same pipeline).

## 11. Owner decisions log (2026-10-12) and open questions

Decided: US sample to Houston in addition to Lisbon (B4b); second mute place
on needs-you / "Coming up" rows; "don't know the year" birthday option; age
on the card only when the year is known (removable).

**Price (owner, 2026-10-12): $11.99 shipped, tax extra.** Cost $2.50 card +
$4.49 US shipping + ~$0.65 Stripe → ≈ **$4.35 per card (~36%)**. Printful may
also charge us sales tax on the wholesale cost unless we file a resale
certificate with them (P0 checklist).

Open: none.
