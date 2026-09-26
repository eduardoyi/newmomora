# Copy changelog — v2 memory-first listing (WP-B)

Scope: `store-assets/listing/registry.v2.json` and its generated exports
(`store-assets/listing/out/en-US/*.txt`). Source of truth for wording:
`momora-listing-handoff-v2/approved-listing-copy.json` (schema_version 2,
brief_version 2.0-memory-first), cross-checked against
`docs/app-store-revamp/PLAN.md` §1 (verified ground truth) and §2
(corrections).

No wording was changed from the approved v2 handoff copy. This document
records (a) what changed from the superseded 2026-08 listing to v2, and
(b) the evidence review performed on the v2 copy itself, with a verdict on
each item the task asked me to check.

## 1. What changed: 2026-08 listing → v2 memory-first

The 2026-08 listing (`store-assets/manifest.json`, preserved as-is, read-only,
exempt from the stale-v1 scan by design) was **effort-first / art-first**: it
opened by promising relief from remembering ("You don't have to remember it
all."), led with the AI-illustration transformation ("Say it. Watch it become
art."), and reduced the story capture flow to a chore-removal pitch ("No blank
pages. No homework.", "Everyone becomes a character.", "Made for the 2 a.m.
scroll.", "Start where you are.").

v2 is **memory-first**: it opens with what the parent keeps (photos, stories,
their little voice — `Keep more than the photos.`), only reaches
illustration and printing after establishing digital value, and makes the
optional book explicitly optional and separately purchased rather than the
implied payoff of the whole flow. Per `MASTER-BRIEF.md`'s "Binding revision"
section, this is a deliberate supersession, not a blend: the two strategies
are not mixed in the same registry.

All six 2026-08 slide headlines plus the five `superseded_active_strings` from
the handoff registry are enforced as forbidden by `validate-copy.mjs`'s
stale-v1 scan (see §6 below for scan scope).

## 2. Evidence review of the v2 proposed copy (owner-flagged items)

### 2.1 "Review the book online, make changes and order a printed copy" (description)

**Verdict: accurate, keep as written.**

PLAN.md §1.1 confirms: "Book review/edit/order happens in an **external
system browser** at `shop.usemomora.com`, separate login — no in-app WebView,
no native editor" (`docs/features/memory-book-generation.md:60-63,601-611,
407-591`; `docs/features/memory-book-orders.md`). The description's wording
("Review the book online, make changes and order a printed copy delivered to
your door") does not claim an in-app editor or WebView — "online" correctly
signals a browser handoff. No wording in the registry implies an in-app
editor. This satisfies the task's requirement to verify and record that no
wording may imply an in-app editor — none does.

### 2.2 Gallery-import paragraph and the 512px-preview fact

> "with your permission, Momora looks through your photos, groups them into
> suggested memories and drafts captions... Your camera roll stays as it is."

**Verdict: accurate as far as it goes; recommend for owner review, not
unilaterally rewritten.**

PLAN.md §1.1 confirms both halves of this claim are TRUE by code: the
permission-based scan/clustering/caption-drafting
(`docs/features/gallery-import.md:16-24,50,61,77,138`) and the camera-roll
being left unmodified (`docs/features/gallery-import.md:10`). However, PLAN.md
§1.1 also documents a fact the description doesn't surface: "512px previews
upload to private R2 for AI **before** review; full originals only after
approval" (`docs/features/gallery-import.md:10,22-23,71-72,81`). The
description's "Your camera roll stays as it is" is true (nothing is deleted or
reorganized on-device) but a literal-minded reader could infer "nothing about
my photos leaves my phone before I approve anything," which is not accurate —
small previews do leave the phone pre-approval for AI processing.
`docs/store-submission-answers.md:75` independently confirms this and states
it "is not a basis to omit **Photos or Videos** from App Privacy."

I am **not** changing this description paragraph — MASTER-BRIEF.md's Copy and
brand rules ask for short, ordinary sentences, and the App Privacy label
(Photos/Videos, App Functionality) is the correct, more precise place for the
preview-upload disclosure rather than folding a data-flow caveat into a
one-line marketing paragraph. **Flagging for owner decision:** either (a)
confirm the App Privacy "Photos or Videos" declaration and its user-facing
detail text cover the preview-upload step explicitly, so the description's
plain-language framing isn't the only place a user could learn this, or (b) if
the owner wants the description itself to be more explicit, add a short
clause such as "small preview copies are sent for that" — a wording change I
have not made without sign-off, per the task's "recommend, do not
unilaterally rewrite" instruction.

### 2.3 "An active subscription is required to add memories and use AI features."

**Verdict: accurate, keep as written.**

PLAN.md §1.1: "Subscription gates new memory writes, engagement writes, media
changes and AI generation — **not** reading" (`docs/features/
subscriptions.md:40-43,164`), and "Lapsed owner keeps browse + export"
(`docs/features/subscriptions.md:39`, `docs/features/data-export.md:110`).
The sentence gates writes + AI and says nothing about reading, matching the
verified behavior exactly. No correction needed.

### 2.4 Keywords: `baby,book,album,journal,milestones,child,parenting,recording,print`

**Verdict: relevance hypothesis, no volume/rank claim made or implied.**

The registry carries `keywords_status: "relevance_hypothesis_no_volume_or_
ranking_data"` through unchanged (per WP-B instructions to carry through the
status qualifiers). This changelog does not assert search volume, ranking
potential, or competitive keyword data for any of these terms — none exists
in the checkout, and none was fabricated. Per `MASTER-BRIEF.md` "Store
metadata": "'Baby book' language is not banned from relevant query coverage;
it simply does not define the default offer" — consistent with keeping "baby"
and "book" in keywords while the name/subtitle/promotional text lead with
photos, stories and voices instead of the book.

### 2.5 What's New

**Verdict: unresolved release gate, not a ready-to-paste field.**

`whats_new_status: "use_only_if_these_changes_belong_to_target_release"` is
carried through unchanged. The proposed text announces gallery import
("Start with the photos already on your phone...") and the book flow
("You can also turn saved memories into a baby book...") as new. PLAN.md
§1.1 records gallery import as "enabled in the **production** build profile"
already (`eas.json:49`; flag at `src/utils/gallery-import-flags.ts:7`) — i.e.
it may already be live in a prior production release, which would make
re-announcing it as "new" in a future, unrelated release inaccurate under
Apple's own guidance and under this task's explicit instruction not to
announce already-released features as new in an unrelated version. PLAN.md
§4 also records gallery import's **server-side admission gate** as an open
owner gate (item 1), independent of the client flag. **This field must not be
pasted into App Store Connect until the actual release notes for the specific
build being submitted are confirmed against what shipped in the previous
release.** No text was invented or altered to work around this; the
unresolved state is recorded here and in `registry.v2.json`'s
`whats_new_status`.

## 3. Field-limit and validator results (evidence, not just claim)

Ground truth for limits: PLAN.md §2.2, cross-checked against
`momora-listing-handoff-v2/tools/validate_handoff.py`'s baseline. All limits
were re-verified by `store-assets/listing/validate-copy.mjs` against the
files actually written to disk by `build-copy.mjs`, not the in-memory
registry:

| Field | Limit | Measured (exported file) |
|---|---|---|
| name | ≤30 chars | 23 |
| subtitle | ≤30 chars | 30 |
| promotional_text | ≤170 chars | 132 |
| description | ≤4000 chars | 2067 |
| whats_new | ≤4000 chars | 377 |
| keywords | ≤100 UTF-8 bytes | 66 |

No field exceeded its limit; no copy was trimmed or rewritten to fit. See the
"Real validator output" in the WP-B completion report for the full run.

## 4. Required-links gate

Verified in this checkout (do not treat as a live-console confirmation):

| Link | Value | Source |
|---|---|---|
| Privacy Policy URL | `https://usemomora.com/privacy-policy/` | `docs/store-submission-answers.md:35` |
| Terms of Service URL | `https://usemomora.com/terms-of-service/` | `app/(app)/(tabs)/settings.tsx:56`, `app/(auth)/signup.tsx:93`, `app/(onboarding)/paywall.tsx:552` (constant used app-wide) |
| Account/data deletion (User Privacy Choices) URL | `https://usemomora.com/delete-account/` | `docs/store-submission-answers.md:23,36,98` |
| Support contact | `hello@usemomora.com` | `docs/store-submission-answers.md:99,348` |

**Owner must confirm — not invented, not verified here:**

- **Marketing URL** for App Store Connect. No file in this checkout labels a
  URL specifically as "the Marketing URL." The only root marketing domain
  found is `usemomora.com` itself (distinct from `shop.usemomora.com`, which
  is the memory-book web app per `cloudflare/memory-book-web/README.md` and
  `plans/memory-book-5b-web-preview.md`, not a general marketing site). Do not
  submit a Marketing URL without the owner confirming which of these — or
  another page — is intended.
- Whether the support/privacy/terms pages above are still live and unchanged
  at submission time (this review reads repository references, not the
  production site).
- Any locale-specific link variants beyond en-US (out of scope for this pass
  per the task's "en-US only" instruction).

No URL was invented. Required subscription wording in the description
("An active subscription is required to add memories and use AI features. A
printed book is not included in the subscription. Book prices and shipping
charges are shown at checkout.") matches `COMMERCIAL-CLARITY.md`'s "Public
wording" section verbatim.

## 5. Files

- `store-assets/listing/registry.v2.json` — canonical registry (created)
- `store-assets/listing/build-copy.mjs` — generator (created)
- `store-assets/listing/validate-copy.mjs` — validator (created)
- `store-assets/listing/out/en-US/{name,subtitle,promotional-text,description,keywords,whats-new,screenshot-copy}.txt` — generated (created by build-copy.mjs)
- `store-assets/listing/out/COPY-VALIDATION.json` — generated (created by validate-copy.mjs)
- `docs/app-store-revamp/COPY-CHANGELOG.md` — this file
