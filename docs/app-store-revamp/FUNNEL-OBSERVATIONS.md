# Funnel observations — v2 memory-first listing

Product-funnel observations only, from reviewing the copy, code-evidence docs, and the
commercial-clarity brief in this pass. No redesign proposed here; that is out of this task's
scope.

## Access to the promised digital features

- The listing's opening claims (photo import, unphotographed-story capture with optional
  illustration, saved-voice replay, per-child revisiting, family sharing) are all
  code/doc-confirmed as real, shipped behavior (`CLAIM-MATRIX.md`). The gap is not in the
  feature set — it is in **whether every promised entry point is reachable by every
  production user at the moment they read the listing**. Specifically:
  - Gallery import has two independent gates: a client build flag (confirmed on) and a
    server-side admission flag (status unconfirmed from this checkout). If a user
    downloads the app on the strength of the subtitle/promo text ("Start with the photos
    you have") and their account is not server-admitted, the very first promised value
    moment is unavailable to them with no visible explanation in the listing about that
    possibility.
  - Whether book generation/review requires an active subscription is unconfirmed. If it
    does and a lapsed user tries it expecting their archived, read-only access to cover it,
    that is a second point where the promised behavior and the actual gate could diverge.

## The separate print charge

- The description and frame 5's disclosure are both explicit that printing is optional and
  separately charged, with shipping extra — this is good, deliberate work, and is
  consistent throughout every copy file this pass reviewed.
- The observation worth naming: the *app's own name and subtitle* ("Momora: Family
  Memories" / "Photos, stories & their voices") no longer reference printing at all,
  which is the intended v2 correction — but it also means a user who only reads the
  name/subtitle before downloading has zero print-cost signal until they reach the
  description's fifth paragraph or see screenshot 5. This is consistent with Apple's own
  guidance against leading with price, but it is worth the owner's awareness: the
  "$99 app, then another $99 book" concern this whole revamp exists to address is not
  something a skimming user will encounter until fairly deep into the listing.

## Expectation risk

- The single most concrete, checkable expectation-risk signal recommended in this pass's
  `EXPERIMENT-PLAN.md` is a direct one: support tickets or refund requests whose stated
  reason references the book (e.g., "I thought it was included"). This pass did not have
  access to support-ticket data and could not check whether this has already happened
  historically under the pre-v2 (book-led) positioning — that comparison, if the data
  exists, would be a strong prior for whether the v2 rewrite actually reduces the risk it
  targets.
- The commercial-expectation gap that remains genuinely open (not a copy problem, a fact
  problem) is the book-generation/review entitlement question. Until it is answered, the
  listing cannot say with confidence whether a subscriber who never intends to print still
  gets to *see* what a book of their memories would look like for free, or whether that
  preview itself is gated — which materially changes how "optional" print actually feels
  in practice, independent of what the copy says.

No other funnel gaps were identified from the code-evidence documents reviewed in this
pass.
