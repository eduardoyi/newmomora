# Owner sign-off checklist — v2 memory-first listing

Internal document. May contain the owner's own reference dollar amounts — never copy any
figure from this file into public copy, screenshots, or App Store Connect fields. This
checklist does not authorize any pricing, subscription, checkout, shipping, legal, or
business-model change; it only records what an owner decision is needed on before this
listing can ship.

Each item is a checkbox for the owner (or whoever has the relevant access) to resolve.
None are pre-checked by this pass — nothing here has been confirmed live.

## Production feature status

- [ ] **Gallery-import server-side admission gate.** The client build flag is confirmed
      `true` in production (`eas.json:49`), but `docs/features/gallery-import.md:151`
      documents a separate database singleton `enabled` field that gates server admission.
      Frames 01/02, the subtitle, promotional text, and the description all lead with
      gallery import. If the server gate is off in production today, this copy and imagery
      misrepresent the shipped product — a review-guideline risk, not just an accuracy
      nitpick. **Needed:** owner or operator with production Supabase access states the
      current value of that singleton's `enabled` field.

- [ ] **Book generation / online-review entitlement.** Neither
      `docs/features/memory-book-generation.md` nor `memory-book-orders.md` states whether
      generating a book outline and reviewing it online at `shop.usemomora.com` requires an
      active subscription, or is available to a lapsed/free account. The registry's own
      `commercial_context.book_generation_and_online_review_entitlement` field is literally
      set to `"verify_before_claiming_included_or_free"`. **Needed:** owner states whether
      generation/review requires an active membership, and if so, exactly what is gated
      (starting the request? viewing the preview? both?).

## Pricing and offer

- [ ] **Exact annual SKU/offer identifier and eligible trial.** Owner reference: app
      membership **$99/year**. Not yet mapped to an actual App Store Connect subscription
      product ID, and trial eligibility (is there a free trial? how long?) is unconfirmed.

- [ ] **Currency code and localization.** `approved-listing-copy.json`'s own
      `commercial_context.currency_code_verified` is `false`. The $99 figures are USD
      reference amounts only; other locales/currencies are unconfirmed.

- [ ] **Print price: fixed or variable.** Owner reference: printed book **$99 plus
      shipping**. `docs/features/memory-book-orders.md:233-237` describes a single
      `PRICE_USD_CENTS` env var described in-repo as "our flat price; owner sets once the
      physical sample is priced" — suggesting a flat price, but this has not been confirmed
      as final, and whether it varies by page count/book size is unconfirmed.

- [ ] **Taxes.** Whether the $99 print reference and the $99/year membership reference
      amounts are tax-inclusive or tax-exclusive, and in which jurisdictions, is
      unconfirmed.

- [ ] **Supported shipping territories.** Which countries/regions the printed book can
      currently ship to is unconfirmed from this checkout.

- [ ] **First-year combined spend framing.** If both a membership and one printed book are
      purchased in the same year, the owner's reference arithmetic is membership $99 + book
      $99 + shipping = **$198 plus shipping**. This is owner-supplied context for internal
      planning only (e.g., for expectation-risk conversations with the owner) — it must
      never appear in public copy per `COMMERCIAL-CLARITY.md`.

## Rights and marketing use

- [ ] **Approval to use `enzo-*`/`mara-*` book data in marketing.** These book slugs use
      the owner's own family photographs (distinct from the fully fictional `sample` slug
      and the fictional Kim-Ortiz demo household used everywhere else in this listing pass).
      Committed real cover PDFs exist at
      `book-renderer/book-data/{enzo-year-three,mara-year-one}/print/cover.pdf`. **No asset
      in this pass uses them** — the `sample` slug's placeholder-art pages were rejected
      instead (see `ASSET-MANIFEST.json`). If the owner wants a genuinely photographic book
      spread/cover for frame 5 (recommended — the current `sample` output is SVG placeholder
      art, not presentable), this explicit approval is required first, plus care that no
      other family member's face/name is exposed without their own consent.

## The audio-QR question

- [ ] **Is the `momora.co/e/<token>` redirect live and stable in production today, or still
      pending (`fitter.ts`'s own comment calls it "phase 2")?**
- [ ] **For real (non-sample) books like `enzo-year-one`/`mara-year-one`, do their
      manifests actually carry minted `shareToken` values today, or would a render right
      now still fall back to the fabricated-placeholder short code?**
- [ ] **If the redirect is live and tokens are real: may marketing copy and a frame-05
      asset claim "scan the code to hear the recording" as a book benefit?** This would
      need its own cleared real book/token example, verified to resolve — not the `sample`
      slug, which uses a fabricated placeholder code (`book-renderer/src/model/
      fitter.ts:1180`, `placeholderShortCode()`). See `ASSET-MANIFEST.json`'s
      `audioQrFinding` for the full technical explanation: the underlying scan-mark feature
      is real and shipped, but the specific asset rejected in this pass could not honestly
      claim it.

## Missing marketing information

- [ ] **Marketing/landing-page URL**, if one is required for the App Store Connect listing
      and not already on file — not resolved in this pass.

## Final visual approval

- [ ] **Owner reviews and approves the single genuinely-ready image**
      (`store-assets/out/v2/ipad/07-look-back.png`, sha256
      `458730c1fc48c390f389e89ddff665b6f54ecd1d2b2e544a0ccb4aecba520b5d`) before any upload.
- [ ] **Owner decides which opener to ship** once a genuine frame-1 capture exists for
      each concept: the default "Keep more than the photos.", `existing-photo-first`
      ("Your camera roll. Their stories."), or `voice-first` ("Their little voice. Yours
      to hear again."). This pass does not recommend one over another — no test has been
      run.
- [ ] **Owner arranges the missing native captures** listed in
      `docs/app-store-revamp/CAPTURE-REQUESTS.md` (gallery-import deck, saved-sound player,
      composer input, in-app book shelf + browser review, and the actual sharing/invite/
      role screens) using the seeded Kim-Ortiz demo account, so the remaining 27 default
      frame×bucket slots and both opener challengers can be produced and re-QA'd.
- [ ] **Owner approves the description and screenshot copy text as final**, distinct from
      "approved direction" — this pass found the wording internally consistent with the
      shipped code, but individual line-by-line legal/marketing sign-off has not happened.
