# Commercial expectation map

Follows `momora-listing-handoff-v2/COMMERCIAL-CLARITY.md` exactly. This file is **internal
only** — it is not a source for public copy, and its dollar figures must never be copied
into `docs/app-store-revamp/ASSET-CHECKLIST.md`, screenshots, the description, or any other
customer-facing text. The only two files allowed to hold the owner reference amounts are
this one and `docs/app-store-revamp/OWNER-SIGNOFF.md` (owned by a later work package, not
created in this pass).

## What membership provides without printing

(Source: `docs/features/subscriptions.md`, `docs/features/gallery-import.md`,
`docs/features/memories.md`, `docs/features/audio-memories.md`,
`docs/features/family-sharing.md`, `docs/features/data-export.md` — all doc-evidence, see
CLAIM-MATRIX.md for exact citations.)

- Camera-roll import suggestions with AI-drafted captions, reviewed via Keep / Set aside.
- Text memories, optionally with an AI illustration built from the family's character
  portraits (capped at 6 tagged members, requires a ready portrait).
- Saved-sound memories: the actual audio clip is kept and replayable, not just a transcript.
- Per-child collections, timeline, and calendar views to revisit saved memories.
- Family invitations and role-based sharing (owner / manager / viewer) within one family
  journal.
- Continued read access and owner-initiated export after the subscription lapses (see
  "What is unresolved" for the export scope caveat).

New memory writes, engagement writes (likes/comments), media changes, and AI generation
(`docs/features/subscriptions.md:39-42`) all require an active subscription. Reading does
not.

## What costs extra

- **A printed physical book.** Confirmed as a separate Stripe Checkout purchase
  (`docs/features/memory-book-orders.md:233-237`, a distinct `PRICE_USD_CENTS` env var
  described in-repo as "our flat price; owner sets once the physical sample is priced") —
  not part of the subscription price, and shipping is additional per
  `momora-listing-handoff-v2/COMMERCIAL-CLARITY.md`'s required public wording.
- No other paid add-on beyond the subscription and the optional printed book was found in
  the inspected docs.

**Owner reference amounts (internal only, per COMMERCIAL-CLARITY.md — do not propagate to
public copy or screenshots):** the owner states app membership is **$99/year** and an
optional printed book is **$99 plus shipping**, i.e. a first-year customer who orders one
book would spend **$198 plus shipping** using those reference figures. These are
owner-supplied context, not a verified live storefront price, not a tax figure, and not
permission to change any actual price. `momora-listing-handoff-v2/approved-listing-copy.json`
`commercial_context.currency_code_verified` is `false` and
`public_exact_prices` explicitly instructs: "Do not hard-code the owner reference amounts
into global App Store copy/screenshots."

## What is unresolved

| Question | Status | Where it must be answered before shipping copy |
|---|---|---|
| Is book generation and online review included in membership, or a separately gated/paid step? | **UNVERIFIED.** Neither `docs/features/memory-book-generation.md` nor `memory-book-orders.md` states this explicitly. `approved-listing-copy.json`'s own `commercial_context.book_generation_and_online_review_entitlement` field says `"verify_before_claiming_included_or_free"`. | Must be answered before any copy calls book preparation "included" or "free" — currently the v2 description's "Momora selects saved memories, groups related moments and lays out the pages" avoids the word "included," which is consistent with this being unresolved; do not strengthen that wording without an answer. |
| Exact localized annual SKU, trial eligibility, currency code | Unverified — `commercial_context.currency_code_verified: false` | Owner/App Store Connect check, not resolvable from this checkout. |
| Whether the $99 print reference is fixed or varies by page count | Unverified | Owner check against the actual Stripe price / `PRICE_USD_CENTS` value, and the render-worker `/fit` quote step (`docs/features/memory-book-orders.md:237` references a quote-time `/fit` call, implying the price may in fact vary — this is a signal worth flagging to the owner, not a confirmed answer). |
| Taxes and supported shipping territories | Unverified | Owner/checkout-surface check. |
| Post-lapse access scope beyond "browse + export" — e.g. whether shared/invited viewers retain any read access after the owner's subscription lapses | Partially documented: `docs/features/subscriptions.md:41-42` states invited viewers "cannot create engagement writes unless the family owner has active billing (or an explicitly configured grace window)" but does not fully specify viewer *read* access post-lapse in the same passage inspected this pass. | Recheck `docs/features/subscriptions.md` in full before writing any claim about what a non-owner family member can do after the owner's subscription lapses. |

No pricing, subscription, checkout, shipping, legal, product, or business-model change is
authorized by this document, matching `COMMERCIAL-CLARITY.md`'s own closing statement.
