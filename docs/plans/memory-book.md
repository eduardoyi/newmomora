# Memory Book — Premium Printed Baby Book (Plan)

**Status:** Draft — for discussion
**Date:** 2026-08-17
**Owner:** Eduardo + Claude
**Feature-doc target:** `docs/features/memory-book.md` (create when implementation starts)
**PRD areas:** New premium physical product; sold via website (outside app-store billing)

## 1. Outcome

A parent turns a chosen period of their Momora memories into a premium layflat
hardcover book — auto-curated and auto-designed by Momora, reviewed and lightly
edited by the parent on the website, then printed and shipped by a print API
partner.

The product promise is **not** "a photo book editor." It is: *"we turned your
scattered year of memories into a book that makes you cry."* Curation quality
is the moat; layout, editing, and printing are commodity plumbing.

Positioning (from 2026-08-17 competitive research):

- The premium ($100+) **auto-generated, AI-illustrated** keepsake slot is
  empty. Competitors are premium-manual (Artifact Uprising, $149+ layflat,
  parent does all design work) or AI-cheap ($15–50, Lullaby/Imajinn/PastBook).
- Closest analog Qeepsake: auto-generated from journal entries, constrained
  edits, $150–300 for full hardcovers, ordering gated behind the subscription,
  minimum 20 entries.
- Price anchors: Chatbooks premium layflat $115–243; Artifact Uprising
  Signature Layflat from $149; Storyworth $99–199/yr with book bundled.
- Layflat/flush-mount is ~69% of the album market; premium buyers expect it.

## 2. Locked product decisions

1. **One SKU:** premium layflat hardcover, flat price (no per-page pricing —
   flat pricing reads premium and is simpler). Target retail **$99–149**;
   COGS ~$23–32 + shipping (Prodigi layflat from ~£17.94) leaves healthy
   margin at any point in that band.
2. **Sold on the website**, not in-app: avoids the 30% store cut, enables
   grandparent gifting, and matches established practice (Tinybeans prices
   web below in-app; Storyworth is entirely web).
3. **Unlock threshold:** book ordering unlocks at a minimum count of printable
   memories *within the selected time period* (proposal: 30). Surfaced as a
   progress mechanic ("Your Year One book is 34 pages and growing"), which
   doubles as a subscription-retention payoff. Never urgency/guilt framing.
4. **Time-period scoping:** the buyer picks which memories the book covers
   (see §4). "One book per year" is a first-class use case.
5. **Parent text is sacred:** memory text prints verbatim. AI writes only
   connective tissue — chapter titles, spread intros, dedication/closing
   copy — and every AI-written string is editable in the review flow.
6. **No layout editing.** The edit surface is: include/exclude a memory, swap
   a photo, choose among 2–3 preset layout variants per spread, edit AI text,
   regenerate an illustration. Mandatory full preview before purchase; no
   edits after order submission; no reprints for errors visible in the
   preview (universal industry policy — state it clearly at checkout).
7. **Video/audio memories appear in print** as a stills/waveform treatment
   plus a QR code to a hosted media viewer (see §7). No competitor does this.

## 3. Fulfillment & editor decisions

- **Print partner: Prodigi first** (fallback/AB: Peecho — same underlying
  190gsm E-Photo Lustre / matte-laminate layflat product, HP Indigo, 18–122
  pages, even counts). Both are self-serve, no minimums, sandboxed APIs that
  take a print-ready PDF; Prodigi exposes spine width per page count via API.
  Precedents for this exact motion: Polarsteps→Peecho, Storyworth→RPI.
- **Escalation path at volume:** RPI (Blurb's manufacturer) for linen/foil/
  custom packaging as a possible future "Heirloom Edition" or SKU upgrade.
  Not part of this plan.
- **No third-party editor.** No IMG.LY (cost), no open-source canvas editors
  (clawnify/open-design is a 13-commit Fabric.js demo; 11cafe/jaaz is an
  Electron desktop AI tool — both are the wrong abstraction). Free-form
  canvas is precisely what we exclude.
- **Single-renderer architecture (the key technical decision):** the book is
  a structured JSON document; one set of React components renders it twice —
  interactive web preview in the browser and print PDF via headless Chrome
  (Puppeteer + paged-media CSS). The preview *is* the print output, so
  approval and print can never drift, and bleed/safe-zones/fonts are enforced
  by the renderer, not by the user. Momora's design system (Newsreader /
  Plus Jakarta Sans / Caveat, lavender palette) carries into the book.

## 4. Book scope (time-period picker)

The order flow starts with **who** (child / family) and **when**:

| Scope | Definition | Notes |
|---|---|---|
| Age year | birth → 1st birthday, 1st → 2nd, … | The hero option for baby books ("Year One"); derived from `family_members.date_of_birth` |
| Calendar year | Jan 1 – Dec 31 | "One book per year" use case |
| Everything | full archive | Cap total pages (see below) |
| Custom range | arbitrary start/end dates | Power users, gifts |

Rules:

- Threshold (§2.3) is evaluated against the selected scope, not the whole
  archive.
- Layflat physical limits: 18–122 pages, even counts. The curation engine
  targets a page budget derived from memory count (proposal: soft target
  ~40–60 pages; hard cap 122). When a scope has more material than the
  budget, curation gets *more selective* rather than the book getting
  longer — selection density is a quality feature, not a loss.
- A family can order any number of books over time; scopes may overlap.
  Each order snapshots its own book document (§8).

## 5. Pipeline architecture

```mermaid
flowchart LR
  E[Enrichment: topics + emotion] --> C[Curation: outline]
  C --> L[Layout: book JSON]
  L --> T[AI connective text]
  T --> R[Render: web preview]
  R --> REV[Review & edit flow]
  REV --> PDF[Print PDF via same renderer]
  PDF --> O[Checkout + Prodigi order]
  O --> W[Webhooks: status/tracking]
```

### Stage A — Enrichment (`analyze-memory`)

Extend the existing `analyze-emotion` pass into a single multimodal
`analyze-memory` pass. **Always text+vision combined** (decided 2026-08-17):
caption/memory text when present, photo preview images (≤512px previews are
sufficient and cheap), video **poster frames** (already backfilled), and —
once audio memories ship — the invisible transcript. Every call also receives
**structured context**: memory date, tagged members with their ages on that
date, days-to-birthday for each tagged member, and proximity to major
holidays.

Output per memory (one call, several axes):

1. **`emotion`** — existing axis, now also emitted for videos (poster +
   caption), closing the "video media has no emotion in MVP" gap.
2. **`topics[]`** — the controlled **book vocabulary** (versioned via
   `topics_version`), 0–3 tags, precision-first: no confident tag → no tag.
   Tags are page titles, not image labels ("could it headline a spread?").
   The vocabulary is **derived bottom-up, not hand-guessed** (decided
   2026-08-17): V1 first runs an open-tagging discovery pass over the real
   archive, then normalizes the emergent tags into the controlled set —
   likely more than 30 entries; the archive decides.
3. **`labels[]`** — open-vocabulary descriptive labels (objects, scenes,
   actions) for future in-app search. Not used by book curation; captured now
   because the marginal cost inside the same call is ~zero.
4. **`description`** — one dense, neutral sentence for future semantic
   search (embedding source). Stored invisibly, search-only — same pattern as
   the audio-memories transcript decision. Never rendered.
5. **`milestone`** — candidate match against a versioned, **age-banded
   milestone catalog** (draft: `docs/plans/milestone-catalog.md`).
   **Milestones are never inferred** (decided 2026-08-17): a memory qualifies
   only when its text explicitly records the milestone ("she took her first
   steps!"). A photo that happens to show early walking is *not* "first
   steps" — the parent saying so is the milestone. No text, no milestone;
   vision and dates play no detection role. The child's age band and the
   catalog act only as sanity filters and normalization targets for what the
   text already claims (multilingual text included — cues are semantic, not
   keyword-matched).

**Date-aware occasion rules (decided 2026-08-17):** seasonal tags require
calendar plausibility or explicit text evidence (a costume in March is not
`halloween`). `birthday` is an *event* tag only — **whose** birthday is
resolved deterministically by joining tagged members' DOBs (±7-day window),
never guessed by the model; outside every tagged member's window it's a party
they attended, which is exactly what the spread copy should say.

**Deterministic axes stay out of the model:** people (siblings, grandparents,
"Moments with X & Y") come from `memory_family_members` + member DOBs, whose-
birthday from the DOB join, ages from dates — the model never re-derives what
the database knows.

**Milestone resolution:** because only explicit text claims count, per-child
conflicts are rare; when two memories both explicitly claim the same
milestone, the earliest wins pending user confirmation. Eventually this feeds
a confirmation UI; for the book it powers the Firsts/milestone pages.
Milestone tagging is an app feature in its own right, not book-only — and it
is celebration of what the parent recorded, never developmental tracking: no
"missing milestone" surfaces anywhere, ever.

**Rollout order:** prompt + vocabularies iterate inside the V1 eval first
(cheap, no schema). Once the vocabulary stabilizes, **shipping production
`analyze-memory` is part of V1's exit criteria** — schema columns, the
swap-in for new-memory analysis at creation time, and the archive backfill —
so new memories are enriched from then on and V2 curation reads real columns,
not eval output. Rides the existing fire-and-forget + one-retry +
session-backfill pattern in `docs/features/memories.md`; benefits Looking
Back and future search independently of the book.

### Stage B — Curation (the moat)

Two layers, mirroring what already exists:

1. **Deterministic skeleton** (Looking Back-style recipes): cover, title +
   dedication page, "through the years" portrait spread (from
   `family_member_portrait_versions` — age-stamped portrait history is
   already built), milestone/firsts pages, a light chronological backbone so
   the book still reads as a journey through time, closing page.
2. **Themed spreads** slotted into the skeleton: cluster by topic + emotion,
   rank by engagement (likes/comments as a "the good ones" proxy), photo
   presence, and text richness; an AI pass selects and sequences memories
   into named spreads ("Fun at the beach", "The funny ones"). The model
   curates; it does not paginate — layout templates own geometry.

Curation emits a **book outline** (ordered chapters/spreads with memory refs
and rationale) that is independently reviewable before any layout exists —
this is what V2 of the validation plan (§9) inspects.

### Stage C — Layout

Outline → **book document** (JSON): pages → template id → slots → content
refs (memory text, photo asset, illustration asset, portrait, QR block).
Template library covers: full-bleed photo spread, illustration + story page,
multi-photo grid, quote/text-only page, through-the-years strip, media+QR
page. Each template defines safe zones, bleed, and its 2–3 variants (the
only "layout choice" users see).

### Stage D — Connective text

AI writes chapter titles, spread intros, dedication and closing copy — warm
editorial voice, aligned with `docs/voice-of-customer.md` language verdicts.
All strings land in the book document as editable fields. Memory text is
copied verbatim and is *not* AI-editable (typo fixes deep-link back to the
memory, Qeepsake-style, so the fix benefits the app too).

### Stage E — Render

- React renderer consumes the book document. Browser mode = review preview;
  print mode = Puppeteer PDF at 300dpi with bleed, PDF/X-compatible output,
  cover generated separately using **spine width fetched from the Prodigi
  API** for the final page count. Fonts embedded.
- **Image resolution guards:** full-page at 8.3"×300dpi needs ~2500px.
  The layout engine must demote low-resolution photos to smaller slots
  rather than print soft. AI illustrations likely need an upscaling step
  (Real-ESRGAN-class) or higher-res generation for book-bound use — audit
  first (V0), then decide.

### Stage F — Review & edit flow (website)

Next.js/web flow on the marketing site (or `app.` subdomain) using Supabase
auth: scope picker → generation progress → spread-by-spread preview with the
constrained edit surface (§2.6) → mandatory full-book preview → checkout.
Regenerating after edits re-runs only layout/text stages, not curation, unless
memories were added/removed.

### Stage G — Checkout & fulfillment

- Stripe Checkout (one-time payment; separate from RevenueCat app
  subscriptions).
- On payment: freeze book document, render final PDFs, submit Prodigi order,
  store Prodigi order id; webhook updates order status → shipped + tracking
  email. Order state machine: `draft → previewed → paid → submitted →
  in_production → shipped → delivered / failed`.
- Failure handling: Prodigi rejection (preflight) must alert us and never
  silently strand a paid order.

## 6. Book generation as a durable workflow

Generation (curation + layout + text + render) is a multi-minute, multi-model
job. Reuse the Cloudflare durable-workflow pattern from
`docs/durable-ai-generation-workflows.md` (illustrations/portraits): Supabase
owns authorization and the status row; the workflow owns steps and retries;
compare-and-set publication; client polls status. No memory content in logs
(PII rule).

## 7. Video & audio in print (QR pages)

Depends on the upcoming video/audio memory feature — design the book pipeline
against it from day one.

- **Page must stand alone without the link:** video → thumbnail(s) + caption
  + date; audio → waveform + short transcribed quote + date. If the QR is
  never scanned, the page still tells the story.
- **Permanence:** QR encodes a stable short URL on our own domain
  (`momora.com/b/<token>`) hitting a redirect layer we control forever —
  never a signed storage URL. Viewer page reuses/extends the existing
  memory-sharing web viewer.
- **Privacy (decided 2026-08-17):** public unguessable token, no PIN or
  auth — the unlisted-link trust model. Whoever holds the physical book is
  someone the family chose to share it with; a PIN adds friction (especially
  for grandparents) without a matching threat. Tokens are per-book-per-memory
  and revocable server-side if a book is ever lost/stolen, which covers the
  residual risk without any UX cost.
- **Print quality:** QR at ≥2cm with high error correction; verify
  scannability on the actual gloss-coated layflat stock (glare) in V4.
- **Honesty about longevity:** the printed page is the artifact; the QR is a
  bonus. Any "media hosted for N years" promise is a marketing/legal
  decision — do not print a promise the company can't keep.

## 8. Data model sketch (proposal — finalize at implementation)

| Table | Role |
|---|---|
| `memories.topics text[]` (or `memory_topics` join) | Controlled-vocab tags from Stage A |
| `memory_books` | One row per book project: family, child, scope, status, page budget, book document (JSONB), frozen-at-order snapshot |
| `memory_book_orders` | Stripe payment ref, Prodigi order id, state machine, shipping, tracking |
| `media_share_tokens` | QR token → memory/media ref, book id, revocation |

RLS: family-membership on book rows; orders readable by purchaser; tokens
resolved by an Edge Function (no direct table access from the public viewer).
Schema/API changes follow the standard rule: migration + regenerated types +
TECH_SPEC in the same change.

## 9. Validation plan — dogfood-first, one stage at a time

Instead of ordering a random print sample, we build the pipeline stage by
stage against **Eduardo's real account**, validating each stage's output
before building the next. Each step is an eval-style script (pattern:
`npm run eval:illustration`; DB access only through allowed eval scripts),
producing an artifact Eduardo reviews.

| Step | Build | Validation artifact | Pass question |
|---|---|---|---|
| **V0 — Data audit** | Read-only script | Report: printable memories per scope (per age-year/calendar-year), type mix, photo pixel dimensions, illustration output resolution, engagement distribution | Is there enough material? Do images survive 300dpi? Is the 30-memory threshold right? |
| **V1a — Discovery** | Open-tagging eval pass: model emits free-form topics + labels + description + emotion + explicit-text milestone claims per memory, no fixed vocabulary | Emergent-tag frequency sheet over the real archive | What themes does this family's life actually contain? |
| **V1b — Normalize** | Cluster/merge the emergent tags into the controlled vocabulary (likely >30; drop non-page-worthy, merge synonyms incl. cross-language) | Draft controlled vocabulary + mapping from raw tags | Does each surviving tag pass "could it headline a spread"? |
| **V1c — Validate** | Re-run archive against the controlled vocabulary + date-aware occasion rules + milestone catalog | Tag sheet in two views: per-tag clustering (spread viability) and per-memory (precision spot-check), with thumbnails/excerpts (own-account data, gitignored eval-output) | Do tag clusters read like a table of contents? Are milestones/occasions credible? Then: ship production `analyze-memory` + schema + backfill as V1 exit |
| **V2 — Curation** | Outline generator | Markdown/HTML outline of Eduardo's book: chapters, spreads, selected memories + rationale | Does the book feel *interesting* — would you turn the pages? This is the moat checkpoint; iterate here as long as needed. |
| **V3 — Layout + render** | Templates + React renderer + PDF | On-screen preview and print-PDF of the actual book | Does it look premium? Do illustrations hold up at size? |
| **V4 — Physical proof** | Prodigi sandbox → one real order | A printed copy of Eduardo's book, including a QR test page | Paper/binding/color verdict; QR scans on gloss; this replaces the "random sample" order. Optionally also order the Peecho twin for comparison. |
| **V5 — Product wrap** | Web review flow, Stripe, order workflow, webhooks | End-to-end self-purchase | Ship to first real customers (soft launch to existing subscribers). |

Gate: do not start V(n+1) implementation before V(n) passes. V0–V2 are cheap
and prove the thesis (curation quality) before any rendering or commerce work
exists.

### V0 results (run 2026-08-17, `npm run eval:memory-book-audit`)

Script: `supabase/scripts/eval-memory-book-audit.ts`. Full report in
`supabase/scripts/eval-output/memory-book-audit/` (gitignored). Verdict: **V0
passes** — proceed to V1. Key findings:

- 721 memories; all 5 calendar years and every child age-year (Enzo Years
  One–Four, Mara Years One–Two) clear the 30-printable threshold with wide
  margin. Threshold of 30 looks right; adult members don't clear it, which is
  fine — books are child/family-scoped.
- Photos survive print easily: 607/700 are spread-safe (≥2560px); only 1
  below quarter-page. A small 872px cluster from 2022–2023 exists — layout
  engine must demote those (as planned).
- **Illustrations are uniformly 1024px — quarter-page only.** The §5 Stage E
  upscaling question is answered: book-bound illustrations need ~2.5×
  upscaling or print-resolution regeneration before any spread larger than
  quarter-page. Decide approach before V3 (open question §10.4).
- **Engagement is too sparse to be a primary ranking signal** (2.5% of
  memories have any likes/comments on this account). Stage B must rank
  primarily on photo presence/resolution, text richness, emotion, and topic
  diversity, with engagement as a tiebreaker only.
- Caption coverage is 23% (163/721) and text-first memories only ramp up in
  2025 — early-year books will be photo-led, making AI connective text and
  topic tagging (Stage A/B) more load-bearing for 2022–2024 scopes.

## 10. Open questions

1. Final price point within $99–149 (decide after V4 sample in hand).
2. Prodigi vs Peecho (identical product on paper — decide on V4 samples,
   API ergonomics, landed cost incl. shipping).
3. Page budget policy for very large scopes ("Everything" on a 3-year
   archive): more selective vs. offer multiple volumes.
4. Illustration print strategy: upscale existing outputs vs. re-generate at
   print resolution for book-selected memories (cost model in
   `docs/COST_OPTIMIZATION.md` context).
5. Whether media hosting behind QR links gets a stated duration promise.
6. Book-scoped re-illustration or cover illustration: does the cover get a
   bespoke AI illustration (likely yes — it's the shelf moment)?
7. Gifting flow (buyer ≠ family member) — out of scope for v1, note for
   later.
8. Milestone catalog contents (~80–100 age-banded entries) — draft during
   V1; decide where it lives (constant file vs table) and how the
   per-child confirmation UI eventually looks (app feature, not book-only).
9. Semantic search embeddings (pgvector over `description` + captions) —
   the `description` field is captured by `analyze-memory` now; embedding
   infra ships with the search feature, not with the book.

## 11. Notes for future agents

- Read this plan plus `docs/features/looking-back.md` (curation recipes),
  `docs/features/portrait-timeline.md` (through-the-years assets),
  `docs/features/memories.md` (emotion pipeline the tagging pass extends),
  and `docs/durable-ai-generation-workflows.md` before extending.
- The single-renderer rule (§3) is load-bearing: never introduce a second
  layout/rendering path for print vs preview.
- Parent memory text is never AI-modified (§2.5). Do not "improve" it.
- No memory content in logs anywhere in this pipeline (child/family PII).
