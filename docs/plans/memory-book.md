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
2. **Themed spreads** slotted into the skeleton, from THREE deterministic
   candidate generators (decided 2026-08-24 after first-outline review):
   topic clusters (threshold ≥4, ≥3 on sparse scopes), **people-pair
   spreads** from co-tag counts ("Moments with Enzo & Mara", "With abuela"
   — the Looking Back pair recipe), and **emotion spreads** ("The funny
   ones" — the Looking Back emotion recipe). An AI pass selects and
   sequences from all candidates. The model curates; it does not
   paginate — layout templates own geometry.

   **Outline-review decisions (round 2, 2026-08-25):** relationship words in
   spread titles only from tagged-member evidence (names/nicknames like
   "nonno", "abuelo" — user-authored), never from image inference; unknown →
   generic titles. Time-anchored spreads (newborn-days, seasonal date-gated
   topics) pin near their median memory date, exempt from pacing. Birth-month
   and birthday-month backbone segments get special AI-drafted titles
   ("Welcome to the world, …"). Spread titles have two modes
   (decided 2026-08-25): **quote titles** — verbatim from a member memory's
   own text, code-verified against the source (never fabricated), preferred
   for emotion/people spreads, typeset distinctly in V3 (Caveat) with source
   attribution; and **descriptive titles** — any title naming a concrete
   place/activity/object must be true of every included memory (generalize
   or drop the outlier; applies even to genuine quotes that name concrete
   things). Videos rank equal to photos in
   backbone thinning (QR pages make them first-class).

   **Outline-review decisions (2026-08-24):** the Firsts spread closes the
   book ("big and small victories this year"), not opens it; themed spreads
   are **paced** by code — no 3+ consecutive backbone month-segments when
   spreads are available to interleave, chronological affinity demoted to a
   soft preference; AI selection rationales are internal review notes only
   (never book copy), must cite concrete evidence, and are labeled as
   internal in every artifact.

**Overlap and single placement (decided 2026-08-23):** topics are
multi-label (0–3 per memory; `beach` + `grandparents`, `birthday` +
`cooking-baking`), and axes stack (topics × emotion × people × milestone).
Overlap determines *eligibility* for spreads; the printed book places each
memory on exactly one page. When a memory qualifies for several spreads it is
assigned where it is scarcest/most valuable, and the connective text may
acknowledge the overlap ("a beach day with abuela").

Curation emits a **book outline** (ordered chapters/spreads with memory refs
and rationale) that is independently reviewable before any layout exists —
this is what V2 of the validation plan (§9) inspects.

### Stage C — Layout

Outline → **book document** (JSON): pages → template id + parameters →
slots → content refs (memory text, photo asset, illustration asset,
portrait, QR block).

**V3 design decisions (discussed 2026-08-26):**

- **Parametric template system, not a template list.** Templates are
  components that take parameters (slot count, slot proportions, text block
  sizing) with aspect-ratio-aware placement rules — variation in photo
  count/orientation/caption length is absorbed by one component flexing.
  Only genuinely new *shapes* are separate templates (~6–10 kinds: flexible
  photo grid, photo + story, text-only/long-entry page, full-bleed +
  panorama spread, through-the-years strip, spread title page, anchor media
  page, two cover kinds, closing).
- **Outline → layout is DETERMINISTIC** (AI for taste, code for geometry):
  a constraint fitter filters feasible templates per page, scores fit +
  rhythm (no same template twice consecutively), picks the best; ranks 2–3
  become the user-facing layout variants for free. Layout is a pure
  function of the book document (preview = print; local refits on edit; no
  per-page model calls). Editorial emphasis (hero slots) comes from the
  outline's highlights — already decided by the reasoning model.
- **Crop safety:** conservative center-weighted crops; prefer demoting a
  photo to a smaller slot over aggressive cropping. Focal-point hints are a
  future `analyze-memory` enrichment (per-photo fact, computed once),
  consumed deterministically — never a layout-time model call.
- **Layout-gaps report:** the renderer logs every page whose best fit
  scores below threshold; rendering real books surfaces the missing-layout
  backlog from data (same dogfood pattern as V1a discovery).
- **QR treatment:** inline mini-QR (12–15mm, muted ink, caption-line
  placement with quiet microcopy) is the DEFAULT for video/audio memories —
  short redirect URLs keep QR versions low so small stays scannable. The
  dedicated media page survives only for anchor moments (outline
  highlights). QR must never be visually loud.
- **Covers — user picks one of two:** (1) minimal flat color + big title
  (lavender family, Newsreader, journal language); (2) full-bleed photo
  (nominated by the outline generator, swappable in review; spread-safe
  resolution required; gradient scrim or calm-region title placement for
  legibility).
- **Captions: always printed when present, verbatim and in full.** The
  fitter selects a template that fits the text; text is never trimmed to
  fit a template. Long entries get text-forward layouts. Caption-less
  photos get a small date only — NO AI-generated filler captions, ever.
- **Illustrations: upscale** (Real-ESRGAN-class, ~2.5×) rather than
  regenerate (decided 2026-08-26); templates cap illustration slots at
  sizes the upscale supports; V3 includes an upscale quality test on real
  illustrations.
- **Rendering runs server-side** (originals from R2, ~100–200MB per book;
  never in the user's browser — previews use lightweight copies). V3
  renders locally via the eval script; the production render-job home is a
  V5 decision. Nothing in V3 may assume browser rendering.

**Design source of truth (2026-08-27):** Claude Design handoff "Momora's
Parametric Baby Book System" — assembled real Enzo book (1a) + spec board
(1b): 6-col/27.5mm grid, 5mm baseline, 24mm no-face spine band, full
type-role scale, composition catalog with deterministic applicability
rules and fallbacks (full-bleed gated on highlight + ≥300ppi + face
clearance, max 2 consecutive / 6 per book; panorama ≥1.7:1; impossible
aspects contained on pale lavender, never cropped; audio-note inverts the
scan mark into the page image at 26mm with a single Caveat word and NO
printed transcription; antetítulo/kicker in PJS 700 small caps 6.5pt;
max one Caveat accent per spread). Handoff v2 (2026-08-27) adds: wraparound covers (photo voice wraps 34mm
into the back; mixed voice for vertical photos with stamp-scale portrait on
the back; minimal voice 0.25pt collection rule at 60mm), spine tiers
(15mm name+years / 9mm name / <8mm blank; years at 14mm from foot for
shelf alignment), a formal first-match decision table, crop boxes ±20%,
face-centroid crop rules, scan ink #4A3F35, video grouping (max 2 scan
lines/spread), and the "never" list (photos never upscaled past native
300ppi — illustrations exempt per the upscale decision). Original v2 zip
(family content — NOT committed): ~/Downloads/Momora's Parametric Baby Book
System-handoff (1).zip sha256 02605a5e8d05600780b6f3aa6a14415c3e8ec4567767c2c298474c9375ffc27d; working copy in gitignored
book-renderer/book-data/design-handoff/. Implementation must reproduce the
canvas, not reinterpret it. Ripples: outline emits `kicker` per themed
spread + persists highlights (full-bleed gate input); face rules fail
closed until focal-point enrichment exists.

**Density & quality-first decisions (2026-08-27, owner review of first
rendered books):** follow the canvas's real density — typically ONE photo
per page, max TWO with clear size hierarchy (never an even pair) for
photos from different memories; the one exception (middle path, decided
2026-08-27): a single memory carrying 3-4 photos of one moment may render
as one grid unit on its own page (5+ splits across a facing pair), since
one moment told in several frames is not clutter. Thresholds are named
constants for tuning after visual review. Longer
books are accepted up to the 122-page hard cap; quality of output comes
first, pricing adapts later (raise flat price or introduce tiers). The
outline derives its IMAGE budget from density constraints (content pages ×
~1.3 images) instead of cramming pages. Panorama spreads: 1 guaranteed +1 per ~20
pages, NO cap — but only ever as many as have qualifying photos (native
landscape, source ≥3500px wide ≈212dpi at 420mm; V4 proof must include one
to validate the dpi compromise). The outline AI nominates ALL qualifying
`panoramaCandidates` best-first (no faces near center — human-reviewed in
the editor), which bypass the face gate as an interim until focal-point
enrichment ships. Panoramas splice in as their own spread at chronological
position, promoted out of their grid/spread; no folio/index on the spread;
counts toward bleed-rhythm accounting. Crop: 2:1 center band; a vertical
crop-position slider joins the V5 edit surface (decided 2026-08-27).
V5 edit surface (decided 2026-08-28): pages holding a single PHOTO (not
video or illustrated memory) get a per-page full-bleed toggle — the user
can promote a normal solo page to full-bleed or demote a chosen full-bleed
back — paired with a drag-to-reposition control that moves the photo
within the bleed "cover" to adjust which band survives the square crop
(same interaction family as the panorama crop slider above).
Copy assignments: dedication body + back-cover colophon = AI fields in the
outline response (editable connective text); spine text = deterministic
(name + year range, never model-generated); closing line = localized
furniture template with dynamic page count.
Localization is total: furniture, dates, age labels, and milestone names
(translated catalog) all follow the journal language — no mixed-language
pages, ever. Firsts lists paginate rather than shrink type. Through-the-
years chunks into multiple spreads of 2–3 pairs when portraits exceed one
spread. Big scan marks are AUDIO-only; video is always photo-like + footer
credit. Lavender containment is for grid-slot mismatches only, never solo
pages. Back cover + spine designed as part of the wraparound cover PDF
(Prodigi covers are one back+spine+front sheet).

**Owner review round 3 decisions (2026-08-27):** outline ranks content-
neutrally (quality/relevance/theme signals — never by memory type; the
type-privileged ladder caused a 77-illustration skew); 122 pages is a
CEILING not a target — book length flows from meaningful content; panorama
gate is crop-based (landscape original ≥3500px → 2:1 center crop w/
cropBand param; native-1.7:1 purity dropped — no phone photo qualifies);
full-bleed goes through the same trusted-candidate path (heroCandidates/
highlights + original ≥2500px, face gate bypassed as human-reviewed,
fitter PREFERS full-bleed for heroes; new full-bleed single page with
credit on the facing page's index — "nunca texto encima" preserved);
captions for photo/video memories ALWAYS in the footer index (on-page
captions retired; illustrated memories remain the sole on-page-text
exception); scan-to-watch moves from footer to directly below the image
(right-aligned text+mark, top-aligned); footnotes consolidate same-date
entries ("¹ ² ³ 23 oct") with true superscripts; density rule v3: 3-4
photo grids ONLY when all aspects compose with minimal cropping, else
max-2; solo images large (150-170mm) at native aspect, lavender
containment retired outside multi-grids; split long illustrated stories
are parity-aware (text on left page, illustration on right, visible
together); Firsts renders as a normal themed section (no index-list; AI
writes warm second-person milestone lines in the journal language, e.g.
"Aprendiste a montar bicicleta sin pedales" — owner chose AI over a
deterministic table for language coverage); closing line = "Este libro
recoge [X] recuerdos…" (memory count); the AI editorial_note is INTERNAL
ONLY and must never print (leaked once); dedication body carries no
salutation (furniture owns the greeting; byline generic "Escrito con
amor, día a día"); `--exclude-memory-id` on the outline CLI for one-off
editorial exclusions (collage/comparison composites out of the dogfood
books).

**Owner review rounds 4–7 (2026-08-27, summarized):** overlap fixes +
photo-meta reserve; typed blank accounting + parity reorder ladder (6-step
fallback, generalized group splitting 2→1+1 / 3→2+1 / 4→2+2, zero
avoidable mid-book blanks enforced by audit); automated content-integrity
audit (month continuity, orphan titles, geometric overlap, blank
accounting, even count, fill-ratio, crop-loss) required to pass with 0
violations on both dogfood books after every fit; min image side 60mm +
subordinate ≥55% of dominant; fill-the-canvas solo/dominant sizing;
full-bleed crop-loss gating (≤20% non-hero / ≤30% hero) + wide heroes
(≥1.7) route to panorama; proportional full-bleed cap (~1 per 10 pages);
smart video-still selection (5 candidates, Laplacian sharpness +
brightness + midtone spread).

**Owner review round 8 decisions (2026-08-27):** pairs STAY allowed on
header pages, but never as a vertical stack when the content box is
height-squeezed — side-by-side sharing the width axis instead (the
owner-validated geometry); dominance invariant (dominant short side ≥
subordinate's, else split to solos); tall solos on header pages sit
BESIDE the header (right column, near-full height) instead of below it;
section-header reserve re-measured against real header typography;
illustrated-story width drift fixed (page-relative % applied inside an
80%-width container silently shrank illos ~20% and defeated the split
threshold); full-bleed non-hero crop-loss cap 20%→25% (a standard 4:3
photo loses exactly 25% to square — the old cap excluded the entire
phone-photo population), plus a paced soft target of ~1 full-bleed per
15 pages (rolling slot release, so early months can't consume the whole
budget) under the existing ~1-per-10 ceiling; exporter measures original
dimensions for ALL photos (previously only outline-nominated candidates —
the non-hero full-bleed path was de facto dead with 0 eligible photos in
both books); video-still scoring gains a center-weighted region term
(4×4 cell grid at 128px, subject sharpness beats background sharpness)
and 9 candidates; page photo-count rule: exactly 1, 2, or 4 photos —
NEVER 3, never >4 (3-photo groups split to pair+solo; enforced as an
audit check).

**Owner review round 9 decisions (2026-08-28):** illustrated-story pages
gain a total-stack-height constraint (deterministic caption-height model;
illustration sized to fit above an ~8mm folio clearance; the 110mm split
threshold now checks the FITTED height) — root cause of folios rendering
on top of illustrations (measured 236mm stack bottom on a 216mm page; the
nominal 160mm big illustration never fit with text above it, masked
pre-round-8 by the %-basis drift); a `parity:full-bleed` blank is never
acceptable — the parity reorder models full-bleed pacing/budget state so
a section-opening full-bleed moves later in its month, and the true last
resort DEMOTES the full-bleed to a normal page (a full-bleed must open on
an even page because its credit lives on the facing page — normal pages
have no such constraint; owner confirmed blank > full-bleed trade);
beside-header image width cap becomes title-aware (grow to 65% of safe
width when the modeled title width leaves ~10mm clearance; 50% for long
titles); solo-video scan+QR group moves beside the image's bottom corner
(internally aligned to hug the image edge, below-image strip as fallback
for wide stills), freeing the vertical meta reserve. Recurring lesson
promoted to rule: every CSS percentage must be resolved against its
element's ACTUAL containing block (two drift instances shipped in round
8 — SafeArea is 190mm, the page frame 216mm), and every new page
composition needs a matching geometric audit check in the same change.

**Owner review rounds 10–12 decisions (2026-08-28):** footer reserve
right-sized (22→15mm base; measured worst-case footer block is 7.9mm) with
a video-aware variant (24mm when a below-image scan strip renders — the
old 22mm was coincidentally tangent to the footer by 0.5mm); side-placed
scan+QR groups stack vertically and side placement is PREFERRED
(threshold 46→25mm) so solo videos render at the full 98×175mm; vertical
pair stacks require clear hierarchy (dominant ≥1.15× subordinate short
side, else side-by-side) and the pair fill gate returned to its documented
FULL-safe-box basis (~28% of the physical page, header pages included —
the content-box basis let 27%-fill header pairs through three reviews).
Illustrated-density diagnosis: Enzo's 58 illustrated memories all fall in
jul–oct 2025 (Sep: 21 illustrated vs 3 photos) — corpus seasonality, not
curation — and photo-only cap demotion amplifies the skew. Owner decision:
HYBRID fix. (b) illustrated-digest spread (owner-approved design: 4
entries/spread, 82mm zigzag illustrations, 13pt text on a narrow measure,
per-entry lavender antetítulo dates, no dividers) sweeps the tail of
illustrated-heavy months (≥6 illustrated; top-2 ranked keep full
compositions; milestone holders + quote-title sources never swept; never
two digest spreads adjacent — promote a swept memory back to full as the
separator; dissolve-not-blank parity; EVEN entry counts only — a spread
holds exactly 4, and a single-PAGE digest variant holds exactly 2 (one
column, parity-free ordinary page; a remainder of 3 renders 2-on-a-page +
1 ordinary; enforced structurally by the audit)); plus (a) as pressure
valve: when
photo demotion exhausts under the 122 cap, lowest-rank digest-eligible
illustrated become demotable too (same month floors, distinct gap
reason).

**Owner decisions (2026-08-28, round 13):** coverage diff (read-only
eval:memory-book-coverage) showed the outline layer is type-neutral (75%
text / 66% photo / 85% video kept) but the CAP layer's photos-first
demotion skews end-to-end keep-rates to ~75% text vs ~40% photo/video —
owner wants the cap layer BALANCED: demote from whichever kind currently
has the highest keep-rate (ties prefer photo/video), all protections
unchanged (month floors, milestone holders, title sources, digest-eligible
guard for illustrated). "Text is sacred" is retired as an absolute; it
survives as tie-break + protections. The outline's 19 dropped Enzo texts
were budget-model drift (pre-digest accounting), not taste — motivating
executing the fitter-as-oracle refactor (below) before generating the
next validation books (Enzo year one/two, Mara year two).

**Owner decisions (2026-08-28, rounds 17-18 — validation-trio findings):**
generated Enzo year-one/two + Mara year-two through the full pipeline.
Findings + decisions: panorama parity blanks (6 across the trio) get the
established ladder — reorder-predicted neighbor moves, then a one-page
swap (round-4's "never swaps" relaxed exactly that far), then demote to a
normal solo page, never a blank; audit tolerance removed. Language
resolution is deterministic and standalone per account: predominant
caption language account-wide → families.gallery_caption_language →
English, resolved+committed by the model as a BCP-47 `language` field in
outline.json which the asset exporter inherits (caption-less periods came
out English before). Special month titles: BOOKS ARE STANDALONE — an
age-year book flags birth month (if in window), the OPENING month
("the month you turned N-1") AND the closing run-up month ("the month
you turned N", though the birthday day itself is endExclusive). Themed-
spread membership is protagonist-gated ONLY for captioned memories: a
caption-less tagged photo is always admissible; an explicit narrative
caption centering someone else keeps the memory in its chronological
backbone. Printed parent text strips URL tokens via one shared sanitizer
(fitter decisions, templates, audit all measure the same cleaned text;
URL-only captions render as photo-only; quote titles never quote URLs) —
the app renders links as cards, a book never prints a raw URL.
The outline currently duplicates the renderer's page-yield math in its own
constants and the two drift (est 108 vs rendered 121 on Mara after several
alignment rounds). The durable fix: the outline imports and calls the
actual `fitBook` estimation (pure TS, dependency-light — Deno can import it
from book-renderer/src/model/) instead of maintaining a parallel model.
Until then, small est-vs-actual gaps surface as cap omissions listed in the
gaps panel.

**Calibration follow-up (2026-08-27):** the outline's page accounting
(3 memories/backbone page etc.) predicts ~53 pages where the implemented
design system yields ~70 — the design's richer compositions hold fewer
memories per page. Before V4 print, calibrate the outline's page-accounting
constants against the fitter's real per-composition yields (export a yield
table from book-renderer) so the page budget means what it says.

Renderer: `book-renderer/` workspace dir (React DOM + Vite + Puppeteer,
isolated from the Expo app's deps). Momora design system: Newsreader
narrative, Caveat for quote titles (per Stage B title modes), Plus Jakarta
Sans UI, lavender palette accents. Each template defines safe zones and
bleed.

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

Video/audio memories and the public QR viewer are shipped. This section
records their current contract and the constraints for the remaining book
pipeline work.

- **Page must stand alone without the link:** video → thumbnail(s) + caption
  + date; audio → waveform + short transcribed quote + date. If the QR is
  never scanned, the page still tells the story.
- **Permanence:** QR encodes the stable public Worker URL
  (`https://m.usemomora.com/m/<token>`), never a signed storage URL. The
  Worker resolves the opaque token and streams private R2 media itself; no
  bucket URL or redirect credential reaches the scanner.
- **Privacy (decided 2026-08-17):** public unguessable token, no PIN or
  auth — the unlisted-link trust model. Whoever holds the physical book is
  someone the family chose to share it with; a PIN adds friction (especially
  for grandparents) without a matching threat. The shipped schema has one
  active token per memory, which exports reuse across printed copies. It is
  revocable server-side without touching the memory, but revoking it disables
  every copy using that token; independently revocable book copies need a
  future per-book token model.
- **Shared-link preview:** the viewer page includes a date-specific title,
  caption when present, and a token-protected Open Graph poster. Videos use
  their stored JPEG first-frame poster; unsupported/legacy media uses a
  neutral Momora JPEG without family data. `no-store` and token rechecks stop
  fresh origin access after revocation, but cannot retract a WhatsApp or other
  provider preview that was already cached.
- **Print quality:** QR at ≥2cm with high error correction; verify
  scannability on the actual gloss-coated layflat stock (glare) in V4.
- **Honesty about longevity:** the printed page is the artifact; the QR is a
  bonus. Any "media hosted for N years" promise is a marketing/legal
  decision — do not print a promise the company can't keep.

## 8. Data model sketch (mixed shipped/proposed)

| Table | Role |
|---|---|
| `memories.topics text[]` (or `memory_topics` join) | Controlled-vocab tags from Stage A |
| `memory_books` | One row per book project: family, child, scope, status, page budget, book document (JSONB), frozen-at-order snapshot |
| `memory_book_orders` | Stripe payment ref, Prodigi order id, state machine, shipping, tracking |
| `media_share_tokens` | Current QR token → memory ref and revocation. No `book_id`; partial uniqueness permits one active token per memory. |

RLS: family-membership on book rows; orders readable by purchaser; tokens
resolved by the public Cloudflare Worker using its service-role boundary (no
direct table access from the public viewer).
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

### V1a results (runs 2026-08-23, `npm run eval:memory-book-tagging`)

Script: `supabase/scripts/eval-memory-book-tagging.ts` (+ tests). Two full
runs over 726 memories, 0 errors, ~$0.55 each on gpt-4o-mini:

- **Strict mode** (production-style precision-first): only 35% of memories
  got any theme; 206 distinct themes. Too conservative for discovery.
- **Discovery mode** (recall-leaning, per-theme confidence): 68% coverage,
  641 distinct raw themes (398 singletons). Concrete scene themes score high
  confidence (bath time 0.85, beach day 0.86, playground 0.78); vague
  catch-alls score low (family moments 0.53, growing up 0.54) — mean
  confidence is a usable "is this a page title?" heuristic for V1b.
- Catch-alls dominate raw counts (playtime 217, family time 89, family
  bonding/moments/togetherness) and must be dropped in V1b; the
  page-worthy clusters are birthday celebration (45), imaginative play (20),
  snack/meal time (28), newborn moments (17), playground (13), bath time
  (11), outdoor play (35 combined), cooking together (9), grandparent
  bonding (8), thanksgiving/holiday season (19), beach day (7).
- Sibling themes (~50 combined) confirm the people axis should come from
  `memory_family_members`, not the model.
- Milestones: 20 explicit text claims both runs; the code gate suppressed 24
  image-only claims in strict mode. Catalog follow-ups: add `first-potty`
  (distinct from `potty-trained`); model missed `blows-kiss` once.
- Emotion: 76% agreement with the existing classifier; 78 previously
  untagged (video) memories now have emotion.
- Birthday rules fixed: `ageTurned >= 1` (newborn-week memories are a
  separate `birthMatch`, 15 found); day offsets are spread evenly across the
  ±7 window, so the window stays ±7 — "birthday week" is the right unit.

**V1a passes.** V1b draft delivered 2026-08-23: `docs/plans/topic-vocabulary.md`
— v2.1 final: 61 tags in 8 groups (38 observed + 23 generalized for
other geographies, family structures, cultures); 61% of memories carry ≥1 tag under the
mapping (the rest is chronological backbone); 674 raw catch-all tokens
dropped (playtime, family time, …) and become negative examples in the V1c
prompt; emotion/people/milestone/season demand confirmed as separate axes.
Eduardo review applied 2026-08-23 (v2.1: cut tummy-time, errands-shopping,
caregivers, games-puzzles, home-life).

**V1c PASSED 2026-08-23** (run `2026-08-23T22-23-55-986Z`, Eduardo reviewed
review.html): 221/726 memories (30%) got 1–2 topics; zero invented ids across
726 calls; date gate caught 6 out-of-season occasion tags; detail fields
work. Known calibration item for production: the model under-tags photo-only
baby-routine memories (newborn-days 5 vs ~42 plausible, bedtime-sleep 0 vs
~20) — production prompt must state that a photo alone is sufficient evidence
for place/activity topics; expected settled coverage ~40–50%. Two fix rounds
were needed on the eval (tolerant topic parsing + moving the vocabulary
adjacent to its instruction — vocabulary at prompt end after the milestone
catalog collapsed coverage to 2%); both lessons carry into the production
prompt design.

**V1 EXIT COMPLETE 2026-08-24:** production `analyze-memory` shipped —
migration `20260824100000` applied to prod, `analyze-emotion` +
`analyze-memory` functions deployed (contract superset; no app release), and
the full archive backfilled: 727 canary (Eduardo's family, 0 errors, $0.68,
35% topic coverage — up from the eval's 30% via the photo-alone calibration;
23 milestone rows all child-resolved) + 93 remaining across 12 families
(0 errors, $0.08). Every new memory is enriched at creation. Next: V2 —
curation outline generator.

Original V1-exit spec (implemented): **ship production `analyze-memory`** — schema migration
(topics/labels/description + milestone storage + topics_version), Edge
Function replacing `analyze-emotion` at creation time, archive backfill,
prompt calibration above; migration + regenerated types + TECH_SPEC +
feature doc + tests in the same change per repo rules.


### V2 results (2026-08-24 → 08-28, `eval-memory-book-outline.ts`)

**V2 PASSED.** Outline generator built and iterated over ~20 review rounds
against five real books (Enzo years 1–3, Mara years 1–2). Structure that
survived review: chronological month backbone with editorial overtures
(through-the-years portrait page, firsts/milestones, quote collections,
illustrated digests for caption-dense stretches, panorama nominations with
vision-judged suitability, hero candidates). Approved run per book lives in
`supabase/scripts/eval-output/memory-book-outline/`; language field added in
round 18 (older runs carry none — see the assets exporter's hard error).

### V3 results (2026-08-25 → 08-29, book-renderer/)

**V3 PASSED.** Single React renderer (`book-renderer/`) drives preview and
print from one fitted document (`fitBook`) — the single-renderer rule held.
Deterministic mm geometry (`templates/mm.ts`; PageFrame base font-size is
1mm so `em` ≡ mm), pure per-template layout modules shared with a geometric
audit (`model/audit.ts`, 0 violations across all five books), Puppeteer
`page.pdf` pipeline (`scripts/render-pdf.mts`), R2-hosted share tokens for
QR pages (worker `workers/memory-viewer`, m.usemomora.com; carousel QRs
resolve to the actual video asset server-side). Print-verification lesson,
learned twice: only rasterized `page.pdf` output proves print correctness —
DOM inspection and print-media emulation both lie. Chromium print
pagination collapses in-flow children of auto-height absolute boxes
(→ explicit heights everywhere), and a print-only `line-height:0` reset
made screen QA blind to print defects (→ reset removed, every small label
now pins an explicit line-height).

### V4 status (2026-08-29, in progress — physical proof ordered)

Prodigi confirmed as V4 vendor (Peecho comparison dropped; see §10.2).
SKU `BOOK-FE-8_3-SQ-LF-G` (21×21cm layflat, gloss 190gsm, matte hard
cover), spine 28mm at 122pp via their spine API. Canonical file spec in
`docs/plans/prodigi-order-spec.md` — the authoritative rules came from
support's print guide after order 1 was rejected: exact trim sizes (210×210
interior, 448×210 cover, NO bleed — they generate it), separate cover+inner
files for API orders, their system inserts inside-cover blanks (our
front-matter-verso blank is dropped at render; counts must be even; folios
renumbered to physical pages).

Order history: ord_14448173 (rejected for bleed-inclusive files — full
refund; also carried English furniture from a silent language fallback, now
a hard error, and a broken TTY page). Two OnHold orders cancelled inside
the owner's 2h dashboard edit window as print-raster review kept finding
defects (held orders are invisible to the Orders API — dashboard-only).
**ord_71474677889453056 released to production 2026-08-29**: Enzo year 3
(122pp) + Mara year 1 (122pp) to Lisboa, $66.10 — carries all fix rounds.
Physical pass questions (§9 V4) answered when it arrives; owner tracks
delivery.

In flight (delegated, review pending): cover-suitability rules — the
full-bleed cover voice is being removed (owner decision: contained front
photo + light spine only, as on the two ordered books), outline gains
vision-judged `coverCandidates` (real photograph of the child, face
visible; no medical settings; no drawings/documents/screens), and the
fitter fallback becomes middle-of-year instead of chronologically-first
(which put a delivery-room photo on a year-one cover). Validation-book
outlines (Enzo y1/y2, Mara y2) will be re-run with the new rules once the
implementation passes review (owner approved the OpenAI spend).

Editor-era backlog from owner review of the validation books: image
reposition/replace controls, face-aware panorama crop guard.


### V5 scope (discussed & agreed 2026-08-31)

Sequenced as three independently shippable slices:

- **5a — Durable generation workflow.** `memory_books` schema + status row;
  outline generation ported from the eval script into the Cloudflare
  durable-workflow pattern (docs/durable-ai-generation-workflows.md);
  preview asset prep from app-resolution assets. Preview is CHEAP — no
  Puppeteer, no print assets. Outline cost is now logged per run (tokens +
  USD; price table in eval-memory-book-outline.ts).
- **5b — Web preview + v1 edit surface.** Next.js + Supabase auth; the
  book-renderer components render the preview (single-renderer rule).
  Decided 2026-09-01: lives at **book.usemomora.com** — a package in the
  main Momora repo sharing book-renderer (never in the marketing repo),
  own deploy, auth cookies scoped to the subdomain. The journey STARTS IN
  THE APP: the app creates the memory_books row (scope picker in-app,
  where family/children/subscription state already live) and hands off
  `book.usemomora.com/b/<id>`; web does preview -> edit -> checkout. 5b
  seam to design: login-free handoff via one-time signed link from the
  app session.
  v1 edits, decided from validation-book feedback:
  - Text: dedication, closing-page lines, section titles (eyebrows
    derived-but-overridable), cover + back-cover text, photo captions as
    BOOK-LOCAL overrides (fixing a print typo never rewrites the app
    memory; §2.5 protects against AI edits, not the parent's own).
  - Images: replace ANY image in the book (picker badges assets already
    used in the book to signal duplicates), reposition-within-crop
    (per-slot focal point stored in the book document).
  - Explicitly v2: deleting images/memories (forces re-layout).
- **5c — Checkout + fulfillment.**
  - Stripe Checkout, our own price (decided when the V4 sample arrives)
    + shipping computed live per address via Prodigi `POST /v4.0/quotes`
    (passed through or marked up). We are merchant of record; Prodigi
    bills our card. Launch geography: everywhere the SKU ships
    (`shipsTo` from the product API). VAT/sales tax via Stripe Tax.
  - Print render happens POST-PAYMENT on a **Fly.io render worker**
    (decided 2026-08-31): Dockerized Node + headless Chrome running the
    render-pdf pipeline, HTTP-TRIGGERED (push, not poll — polling defeats
    scale-to-zero) by the durable workflow; renders, uploads print PDFs
    to R2, calls the workflow back, auto-stops. At current volume this
    costs cents/month; the Dockerfile keeps Hetzner (or any host) as the
    volume-crossover fallback (~daily rendering is the break-even).
  - State-machine lessons from V4, baked in: turn OFF the account-wide 2h
    Prodigi edit window before launch (held orders are INVISIBLE to the
    Orders API); rejection can arrive via support email rather than API
    status, so "submitted but not in production within N hours" raises an
    alert — webhook trust alone is not enough; asset presigned URLs must
    comfortably outlive Prodigi's download window.
  - App-store compliance: selling the printed book from the app or web is
    exempt from IAP on both stores (physical goods — Apple guideline
    3.1.5(a) requires non-IAP payment; Google Play Billing scopes to
    digital goods). Keep the flow physical-only; a digital add-on (e.g.
    paid media-hosting extension) would change this analysis.
  - Preview is FREE for subscribers (decided 2026-08-31): marginal cost is
    ~$0.25/book (the outline LLM call — measured across five real runs at
    $0.17–$0.33; tagging is sunk at memory creation, layout is
    deterministic code, R2 egress is $0, and editor edits never re-run
    curation so editing costs $0.00). Guard: cap full REGENERATIONS —
    re-outline only when the scope's memories changed.

## 10. Open questions

1. Final price point within $99–149 (decide after V4 sample in hand).
2. ~~Prodigi vs Peecho~~ — RESOLVED 2026-08-29: Prodigi (API ergonomics,
   spine API, sandbox; V4 order placed with them).
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
