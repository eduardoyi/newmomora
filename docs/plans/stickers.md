# Face Stickers — kiss-cut stickers of family portraits (Plan)

**Status:** plan, hardened 2026-10-12 (3 review rounds: Sonnet ×2, Opus); S0/S1 not started
**Siblings:** [birthday-cards.md](birthday-cards.md) (builds the shared Printful
order layer this plan uses) · [holiday-cards.md](holiday-cards.md) (dogfood
pattern) · [../features/portrait-timeline.md](../features/portrait-timeline.md) ·
feature doc to come: `docs/features/stickers.md`

## 1. Outcome

A new Keepsakes product: **stickers of family members' faces**, cut to the
outline of the face with a white border (like a laptop sticker, not a square),
made from the family's **AI-illustrated portraits**.

- Sold in **sets of 4**: one Printful 5.5″×5.5″ kiss-cut square carrying
  **4 face stickers** (2×2, each ≈ 2.4″, each cut and peeled separately).
  The 4 spots take any mix (Theo, Mia, Mom, Grandma — or 4× Theo). An order
  holds one or more sets.
- The parent picks **which portrait version** of each person (baby Theo vs
  Theo now); latest is the default.
- Making the sticker art is **free** to the user; they pay only to print.
- **$2.99 per sticker, sold in sets of 4 ($11.96 per set), shipping
  included** (owner, 2026-10-12). Printful Kiss-Cut Stickers 5.5″×5.5″,
  shipped to **US + Canada**.

Done = an owner/manager in the US or Canada picks faces in the Keepsakes tab,
checks out in the shop and receives cleanly cut stickers; and the cut pipeline
was proven on every portrait in Eduardo's family (S1) and on paper (S2) first.

## 2. Locked decisions (owner, 2026-10-12)

| Area | Decision |
|---|---|
| Source | **AI-illustrated portraits only** (`family_member_portrait_versions` with a ready illustration). No real-photo cutouts in v1. |
| Content | **Face only** (head, incl. hair; no name text). |
| Size | **One fixed format**: a 5.5″×5.5″ kiss-cut square (variant `10165`) with **4 faces** in a 2×2 grid, each ≈ 2.4″ (owner, 2026-10-12; replaces one 3″ face per sticker). |
| Per order | **Sets of 4**, any mix of faces per set, one or more sets per order. |
| Price | **$2.99 per sticker = $11.96 per set of 4, shipping included**, tax extra (owner, 2026-10-12). Shop only. |
| Portrait choice | User picks the portrait version; default = latest ready. |
| Cost to user | Making the sticker art is **free**. |
| Vendor | **Printful** (shared with birthday cards). Gelato has no stickers; Printful die-cut is US-only. |
| Regions | **US + CA** (no new VAT registrations; CA matches holiday cards). Dogfood sample ships to the owner in Portugal (EU site). |
| Who | Owners/managers on a paid plan. |
| Entry points | **Keepsakes tab only**: storefront tile → native product page → shop. Nothing on family-member profiles (owner). |
| Prices | Never in the app; shop only. |
| Process | **Dogfood first** (§6, S0–S2), then the product (§7). |

## 3. Provider: Printful

**Product:** Kiss-Cut Stickers, catalog product `358`, variant **`10165`
(5.5″×5.5″, $2.75)**, high-opacity vinyl, glossy. Availability (catalog API,
2026-10-12): in stock in `US`, `EU`, `EU_LV`, `CA`, `UK`, `JP`, `AU` (same
regions as the 3″ `10163`, $2.50, which we no longer use). Print file:
placement `default`, **1650×1650 px @ 300 dpi**.

**Multiple stickers on one square:** Printful's file guidelines allow several
objects on one kiss-cut sticker if there is **≥ 0.25″ (75 px) between objects
that must be cut separately**; each object gets its own contour cut and white
border on the shared backing. Layout (verified in S0): 75 px outer margin +
75 px gutter → four cells of **≈ 712×712 px (≈ 2.37″)**.

**How the cut works (Printful's sticker guidelines, to verify in S0):** upload
a PNG with a **transparent background**; Printful cuts around the opaque shape
and **adds a white border** itself; leave at least **0.25″** between the art
and the file edge for that border; no stray semi-transparent pixels outside
the outline. There is no separate cut-line file. The sticker material is white,
so transparency prints as white border/backing, never clear.

**Live quotes (shipping-rates API, 2026-10-12, USD, excl. tax):**

| To | 1 set (4 stickers) | 2 sets | 3 sets | Delivery days |
|---|---|---|---|---|
| US | $2.75 + $4.49 = $7.24 | $5.50 + $4.54 = $10.04 | $8.25 + $4.59 = $12.84 | 4–6 |
| CA | $2.75 + $5.19 = $7.94 | — | — | 3–6 |

**Margin at $11.96/set** (after Stripe 2.9% + 30¢, before tax; Printful
sales tax on wholesale unless we file a resale certificate):

| Order | Customer pays | We keep (US) |
|---|---|---|
| 1 set | $11.96 | ≈ $4.07 (34%) |
| 2 sets | $23.92 | ≈ $12.89 (54%) |
| 3 sets | $35.88 | ≈ $21.70 (60%) |

CA keeps ≈ $0.70 less per order. The shared `MIN_MARGIN` guard is checked
against these numbers in P0.

## 4. The sticker-art pipeline

Input: one ready portrait version (`illustrated_profile_key`, 1024×1024 webp
today, "clean simple background", **not transparent**: `buildPortraitPrompt` in
`_shared/prompts.ts`; the worker call in
`cloudflare/memory-illustration-worker/src/openai.ts` sets no transparent
background).

Steps:
1. **Isolate the person** (background → transparent). Two candidate methods,
   compared in S1:
   - **A — segmentation, free:** a background-removal model (e.g. BiRefNet /
     U²-Net class, ONNX) on the existing portrait. Zero marginal cost per
     sticker. **Where it runs in production is an S1 decision, not assumed**
     (see "Runtime" below).
   - **B — AI redraw, ≈$0.07:** an image edit with the portrait as the only
     reference, `background: transparent`, prompt "same character, head only,
     sticker-ready, no background". Paid by us; capped per family.
   - **C — Cloudflare Images binding, likely free:** the
     `memory-illustration-worker` already binds `env.IMAGES`
     (`wrangler.jsonc`) and uses it to transform (`src/image-output.ts`,
     `src/portrait-references.ts`). If the binding's foreground segmentation
     (`segment: 'foreground'`) + PNG output is available on our plan (verify
     in S0), isolation runs on existing infrastructure: no new Fly app, no
     ONNX packaging, no cold start.
   **Preference order: C, then A, then B.** B only for versions the others fail
   on — but note B redraws the head across the whole 1024 canvas, so it also
   fixes the resolution problem below.
2. **Face only:** crop away shoulders/torso so the sticker is the head + hair
   (+ a little neck). S1 tests a vision-model chin line vs. a fixed crop
   ratio on the segmented mask, and shows the "bust" (head + shoulders) for
   comparison so the owner can confirm "face only" on real output.
3. **Clean the mask:** hard alpha threshold (no semi-transparent fringe),
   remove islands, morphological close (fills tiny gaps between hair
   strands), smooth the contour so no spike is thinner than the cutter can
   follow (target min feature ≈ 1.5 mm at print scale; verified in S2).
4. **Fit** each face into its ≈ 712×712 px cell, then **compose the set**:
   four cells on the 1650×1650 canvas with ≥ 75 px outer margin and ≥ 75 px
   between faces (more if S0 shows Printful's border needs it).
   **Resolution check:** portraits are 1024×1024 webp (re-encoded q85); a
   head-only crop is ~450–600 px tall, so filling a 712 px cell upscales
   ~1.2–1.6× (~190–250 effective dpi) with webp artifacts on the cut edge —
   only slightly better than the 3″ format. S1 records the head bounding box
   and effective dpi per portrait and flags < 250 dpi; those go to method B
   (or an upscaler) in production.
5. **Preview** (per face, and the composed set) = the art + a simulated white border (dilate the mask by the
   border width measured in S0/S2) + a drop shadow. The same function makes the
   in-app/shop preview, so what the user sees is what Printful cuts.

**Runtime (decided in S1, with numbers).** Today nothing in the Node
renderer imports `supabase/functions/_shared/`, no package has an image
library (no sharp/jimp/canvas/pngjs), and the eval scripts run under Deno with
`--node-modules-dir=none`, where a native addon like `onnxruntime-node` is
unlikely to load. The Fly renderer (`render/memory-book-renderer`) is a
Puppeteer pool on `shared-cpu-2x`, 4 GB, `hard_limit = 1`, with a 45 s cold
start: a poor fit for interactive work. So:
- The pixel pipeline is a **Node package** `render/sticker-art/` (pure,
  testable functions: mask cleanup, crop, fit, preview border; ONNX
  inference; `sharp` for decode/encode). The S1 eval is a **Node/vite-node**
  script (`npm run eval:sticker-art`) importing the same package, with Deno
  only for the RLS-scoped data fetch (or a Node port of
  `year-film-eval-data.ts`'s magic-link client).
- S1 records per-image CPU time, peak memory, model size and cold start on a
  Fly `shared-cpu-2x`. Then pick: **(i)** a small separate Fly app
  `momora-sticker-art` (scale-to-zero, own concurrency), or **(ii)** a route on
  the existing renderer if the numbers are small. Default (i) to keep book/card
  rendering unaffected.
- Generation is **asynchronous** either way: `ensure` creates pending rows and
  returns; the app/shop poll status (preview appears in seconds when warm).
- If method B wins in S1, it runs on the existing Cloudflare image path
  instead (no new runtime), and the pixel cleanup still runs in the Node
  package.

## 5. Guardrails

- **Free but bounded:** method A costs nothing; method B (if used) goes
  through the image reservation path (`ai_image_generation_request`, usage
  limits doc) with an operation `sticker_art` and is generated **only when a
  version is picked**, cached forever per portrait version.
- **Deletion:** sticker art lives **under the portrait version's own R2
  prefix** (`portraits/{versionId}/sticker/...`), and
  `delete-portrait-version` already deletes every key under that prefix, so
  no new R2 hook is needed there. Still required: `sticker_art.portrait_version_id`
  FK `on delete cascade`; check the other hard-delete paths
  (`delete-family-member`, `hard-delete-expired-accounts`,
  `delete-storage-object`) cover the new keys; add the sticker keys to the
  key-ownership validators in `_shared/storage-keys.ts` (e.g. next to
  `isPortraitVersionPhotoKey`) and the app mirror `src/utils/storage-keys.ts`.
  Art frozen into a **paid order** is a copy under the order prefix
  (`print-orders/printful/<orderId>/`) and follows the order's retention, like
  book and card print files.
- **PII:** child faces. Eval outputs only in gitignored dirs; stdout
  counts-only; no faces in the public repo (fixtures use synthetic art).
- **Print verification:** raster check of the final 1650×1650 set PNG (alpha
  binary, outer margin, gutters between faces, size) before any order.

## 6. Validation plan — dogfood-first (S0–S2)

S-stages: eval scripts, local previews, one real order. **No migrations, no
app code, no deploys.** Results recorded here as `### S<n> results`.
Conventions as in [birthday-cards.md](birthday-cards.md) §7; outputs in
`supabase/scripts/eval-output/stickers/` (gitignored, add in S0).

| Stage | Build | Review artifact | Pass question |
|---|---|---|---|
| **S0 — Printful spec** | Reuse birthday B0's packing-slip / webhook / `external_id` findings. Verify the kiss-cut contract on variant `10165` with Printful's guidelines, template + the **mockup generator** (`/mockup-generator/create-task/358`) on 2–3 synthetic 4-face PNGs: does each of the 4 transparent-separated faces get its own contour cut? border width? minimum gutter? how are thin details and holes handled? | Mockups + a "Printful spec" section in this plan. | Are 4 faces cut separately on one square? What border width and gutter do we use? |
| **S1 — Cutouts** | `eval:sticker-art --all-members` (RLS-scoped, `year-film-eval-data.ts`): for **every ready portrait version** in the family, method A (and B for a subset, then for A's failures), the face-only crop, mask cleanup, fit, preview. Can start before S0 finishes (simulated border is a parameter). | HTML contact sheet: original portrait, A result, B result, preview with border, flags (fringe, islands, thin spikes, cropped hair). | Do ≥ 90% of portraits come out clean with A? Is "face only" right, or is the bust nicer? |
| **S2 — Physical samples** | `eval:sticker-order --confirm`: one set of 4 faces (two children, one adult, one hard case: curly hair / hat / glasses) as one Printful draft → confirm. S2a → Lisbon; S2b → the owner's Houston PO box (US facility; can share an order with birthday B4b). | Stickers in hand + packaging + packing slip. | Each face cut separately and following its outline? Border width? Faces big enough at ~2.4″? Colours? Fine hair survived? Peel/stick quality? **No price on the slip?** |

**Gate:** S2 needs S1 (and S0's border number). The product phase starts
after S2 passes and the shared Printful order layer (P0, hardened as its own
plan) exists. **Stickers are not gated on birthday cards:** if S2 passes
first, stickers are P0's first consumer.

## 7. Product outline (hardened as its own plan after S2)

**Backend:**
- `sticker_art` table: `portrait_version_id` (unique), `family_id`,
  `family_member_id`, `method` (`segment | redraw`), `status`
  (`pending | ready | failed`), `art_key`, `preview_key`, attempt/lease
  fields; RLS: family members read their family's rows; writes via Edge
  Function/worker only. Storage keys next to the portrait version:
  `<version prefix>/sticker/{attemptId}.png` (+ `preview.png`), where the
  version prefix is **derived from the version's `profile_picture_key`**
  (minus `photo.jpg`), never from the calling user's id — so a
  manager-triggered job still lands under the prefix `delete-portrait-version`
  purges. Added to `_shared/storage-keys.ts` and its app mirror; test with a
  manager-triggered job on another user's version.
- `sticker-art` Edge Function: `ensure(versionIds[])` → returns ready rows,
  creates pending ones and dispatches generation (renderer endpoint
  `/sticker-art` for method A; image path for B). Idempotent per version.
- Orders on the shared **`print_orders`** (`product_type = 'sticker_pack'`):
  snapshot = list of sets, each `{ slots: [{ portraitVersionId, artKey }] ×4,
  quantity }`; the composed set PNG is rendered and frozen under the order
  prefix **at checkout creation** (§7.1). Printful order: one line per
  distinct set (`variant_id 10165`, `quantity`, `files: [{ type: 'default',
  url }]`).
- Limits: ≤ 6 sets per order (identical sets collapse into a quantity);
  revisit after launch.
- Deletion: FK cascade + the delete paths and validators listed in §5.
- Schema changes ship with migration + regenerated `src/types/database.ts` +
  `TECH_SPEC.md` in the same change.

**Shop:** `/s/<draftId>` sticker order page (router test against the
existing `/b/`, `/c/`, `/order/` patterns; a `print_orders` adapter in
`order/useOrders.ts` / `orderListItems.ts` so sticker orders appear in order
history): the set builder (4 spots per set showing the composed preview;
picking a 5th face starts a second set and prompts "add 3 more" or "fill with
repeats"; an unfilled spot is never printed blank — checkout requires full
sets), quantity per set, US/CA address, Stripe, order status. Prices only
here ("$2.99 per sticker, sets of 4").

**App (Keepsakes only):**
- Storefront tile "Stickers" (owners/managers, paid, rollout on via
  `print_product_settings`; no family-country field exists, so "US + Canada
  addresses only" is stated on the page and enforced in the shop before
  payment): a fan of the family's
  actual sticker previews (or portraits with a simulated border until
  previews exist). Registry work as in birthday-cards §8 P2:
  `KEEPSAKE_PRODUCTS` + `KeepsakeProductContext`, `src/lib/routes.ts`
  (+ test), `make-something-row.tsx`, `app/(app)/_layout.tsx`.
- Product page `app/(app)/keepsakes/stickers.tsx`: grid of family members;
  members without a ready portrait greyed with "needs a portrait" (the only
  link out, to create one). Tap a member → their portrait versions as sticker
  previews (age label from `reference_date`), latest preselected → "Add".
  Selected faces tray (shows "sets of 4") → "Continue to order" → `openShopUrl` with the
  selection (draft created server-side so the shop gets an id, not a list in
  the URL).
- Shelf kind `sticker_order` with badges; type filter entry.
- Analytics: `keepsakes_product_opened` product union in
  `src/services/analytics.ts` + `docs/features/analytics.md`.

**Docs/tests:** `docs/features/stickers.md`, `keepsakes.md`, `TECH_SPEC.md`;
units for mask cleanup/fit (synthetic masks), renderer endpoint test, RLS
pgTAP, screen tests for the product page, Maestro: Keepsakes → stickers page →
shop handoff.

### 7.1 Failure-mode requirements (review round 2; binding on the product plan)

- **Cache key = the source illustration, not the version.** A portrait version
  can be **regenerated** (new `illustrated_profile_key` attempt under the same
  version), so `sticker_art` stores `source_illustrated_key` and is unique on
  `(portrait_version_id, source_illustrated_key)`; `ensure` treats a mismatch
  as stale and makes new art. Test: regenerate → ensure → new art.
- **Freeze at checkout creation (pre-pay):** render each composed set PNG to
  `print-orders/printful/<orderId>/` and snapshot the sets' slots
  (`portraitVersionId`, `artKey`) before the Stripe session, so deleting a portrait between
  pay and confirm cannot fail a paid order. The frozen copy follows order
  retention and the account/family hard-delete paths.
- **Shared order-layer requirements** from birthday-cards §8.1 apply as-is:
  address validation + live price before Stripe (US/CA; CA cost/duties
  checked in S0), files verified before confirm, automatic refunds for our
  failures, webhook-before-checkout deploy order, `external_id` attempts,
  hard-delete coverage of `print_orders`, address purge from `shipped_at`.
- **Packing slip:** stickers ship to the buyer, so the slip may show **our**
  price (`retail_price` = what they paid) or none — **never Printful's
  wholesale cost**. S2's pass question checks exactly that; the stricter
  "no price at all" gift rule is birthday-only.
- **Previews are method A only.** Browsing versions never triggers method B;
  B runs only on an explicit pick (and only if S1 chose it). `ensure` caps:
  ≤ 3 attempts per source key, ≤ 40 new art jobs per family per day,
  ≤ 12 version ids per call.
- **Deletion race:** the art job re-checks the portrait version (exists, not
  deleting, same `source_illustrated_key`) **after** uploading and deletes its
  own upload if not; `delete-portrait-version`'s prefix purge gets a delayed
  re-purge (holiday `repurgedAt` pattern) to catch a late write.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Segmentation fails on stylized hair / soft backgrounds | S1 measures it; method B fallback per version; worst case flag the version "not sticker-ready". |
| Printful's automatic cut ≠ our preview | S0 mockups + S2 paper set the simulated border; preview uses the same mask Printful sees. |
| Thin hair spikes / holes tear or get skipped | Mask close + contour smoothing + min feature size; S2 includes a hard case. |
| "Face only" crop cuts hair or looks odd | S1 shows face-only vs bust on every portrait before locking. |
| Cost creep from method B | Only on pick, cached per version, image usage caps, `sticker_art` usage telemetry. |
| Deleted portrait still printable | Art keys checked live at checkout; deletion hook; frozen copies only for paid orders. |
| Child images on a vendor | Same exposure as books/cards (print files by signed URL with short TTL; Printful retention per their terms). |

## 9. Out of scope (v1)

Real-photo cutouts; names/text on stickers; other sizes/formats (single 3″
stickers, the 5.83″×8.27″ sticker sheet with ~6 faces); partial sets;
holographic/die-cut variants; EU/UK/AU (VAT); stickers of pets unless they
have an illustrated portrait (they then work like anyone else); ordering from
family-member profiles.

## 10. Owner decisions log (2026-10-12) and open questions

Decided: US sample (S2b) alongside Lisbon; **4 faces per 5.5″ kiss-cut
square, $2.99 per sticker, sold in sets of 4 ($11.96/set), shipping
included**. Earlier rejected pricing: $5.99 + $2.99/extra 3″ sticker (lost
money on 1–3 stickers); $9.99 first + $3.49 extra (works, but a high
single-sticker price).

Open: none (≤ 6 sets per order is a default, revisit after launch).
