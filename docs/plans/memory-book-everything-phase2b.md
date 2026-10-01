# Memory Book — Everything Phase 2b (dogfood round 1 fixes)

Status: spec approved 2026-10-01 (owner: "write the 2b spec and implement it")
Parent: [memory-book-everything-phase2.md](memory-book-everything-phase2.md),
[memory-book-everything-fixes.md](memory-book-everything-fixes.md).

Input: the first real Everything books (Enzo `b4f3e3b0`, 4 chapters, 118pp,
73 memories kept; Mara `f75b3f4c`, 2 chapters, 122pp, 91 kept), owner review
screenshots, and a root-cause investigation run offline against both books
(line numbers below are at dc3f456).

## Findings → fixes

| # | Finding (evidence) | Fix | Scope |
|---|---|---|---|
| A | 48 one-month sections (Enzo) eat the budget; the per-MONTH floor keeps ≥1 memory per month, so structure dominates and chapter keep-rates can't equalise (Enzo ch1 kept 13/164) | Everything backbone = calendar-aligned 3-month blocks per chapter; chapter-mode floors keyed per SECTION (backbone element), not per month | Everything only |
| B | One-liners survive as a section's only memory (Enzo p99/101/107/110: 12–48 chars) because text-only memories are never demotable | In chapter mode, text-only memories join the last-resort demotion pool | Everything only |
| C | Enzo stopped at 118/122: page count is non-monotone (omission #524 freed 6pp via panorama/full-bleed quota cliffs); search never adds back | Refill pass after the prefix search (measured: +3 memories → 122pp, 6 fits) | Everything only |
| 1 | Mara p79: a photo memory (325-char caption) and a video memory paired onto a `text-page`, BOTH lose their media. `pairSoloGroups` level ≥3 (fitter.ts:1315-1340) pairs solo groups; `isSoloPhotoGroup` (:1254) ignores `hasLongText`; the merged group scores text-page (:1381) and `buildSlotsForTemplate('text-page')` (:1673) emits text only; companion-photo pass bails on multi-memory groups (:3239) | `isSoloPhotoGroup` also requires `!group.hasLongText` and no audio memory; new audit check (below) | ALL books (bug) |
| 2 | Enzo p7: header + footer index, zero photos. Multi-asset memory (5 assets, asset[0] wide) treated as a wide-hero panorama in `buildContentUnits` (:2602-2610); odd parity after a single-page chapter title + `lastSwappablePageIndex` reset at section start (:2698) → demote rung (:2796) → `toGroup([unit.item])` puts all 5 assets on `anchor-media`, which only draws 1–2 slots. The normal panorama path (:2825+) keeps only `assets[0]` and silently drops the rest (Enzo: 4 memories, Mara: 2) | Panorama/full-bleed units take ONE asset; the memory's remaining assets go back into the run buffer as an ordinary group (both normal and demote paths) | ALL books (bug) |
| 3 | Themed groups mix years (Enzo: 4/4 spreads have 4–6 of 6 members outside their chapter; Mara 4/4 have 2–3). Membership is chapter-blind (candidates over the whole window) and `paceThemedSpreads` (a year-book heuristic) drags spreads to early gaps (Enzo ideal gaps ~33–46 → placed 7–23) | Chapter-restrict membership + home-chapter placement (below) | Everything only |
| 4 | Text-only pages look bare: one entry, small type, top-left, ~70% blank. Quote collections never fire (need 3 ADJACENT eligible memories inside one element) | Pull-quote design for a lone short entry; per-chapter quote pooling in chapter mode | Design: ALL books; pooling: Everything |
| 5 | Audio QR has the script word "escúchalo" + a `momora.co/e/<code>` line — the code is a fabricated placeholder (`placeholderShortCode`, fitter.ts:1196/:1688) that doesn't match the real encoded URL (`m.usemomora.com/m/<token>`) | QR + badge only, like video; delete the label/URL and the placeholder short code | ALL books |
| 6 | Themed spreads shrink to title + 1–3 memories after demotion (Enzo people-pair: 1) | Themed elements get a section floor of min(total, 3) in chapter mode; if one still ends below 2 kept memories, its title page dissolves | Everything only |
| 7 | A title-only page followed by a media-less page (Enzo p6→p7 via bug 2; Enzo p21→p22 text-page) | Covered by fixes 2/4; plus an audit check | ALL books (audit) |

## Detailed rules

### A. Quarter sections (worker `backbone.ts`, Everything only)

- Chapter mode: for each chapter, walk its calendar months from
  `chapter.startMonth` to `chapter.endMonth`, cutting consecutive 3-month
  blocks from the chapter start (13-month chapter → 3,3,3,3,1; the trailing
  1-month block is the birthday month — keep it, it's flagged as a birthday
  segment and titled by the existing flag rules). Clip to the window's
  first/last month. Drop blocks with zero printable memories.
- No chapter mode (no DOB / single chapter): same 3-month blocks from the
  window's first month.
- Blocks are fixed — no "merge until ≥3 printable" for Everything.
- Labels via `formatMonthRangeLabel` (already localized by the renderer).
- Year/calendar books: existing `buildBackboneSegments` behaviour, untouched
  (worker golden must stay green).

### Chapter-mode floors (renderer `fitter.ts`, chapter mode only)

- Replace the per-month floor with a per-SECTION floor: each backbone element
  keeps ≥ min(total, 2) memories; relaxation goes 2 → 1 (never 0 while any
  other demotable memory exists anywhere). Themed elements: floor
  min(total, 3) (fix 6).
- Chapter floor (12) and keep-rate equalisation unchanged; the time-spread
  tie-break uses the section instead of the month.
- Tier order (chapter mode): ordinary A → ordinary B1 → C above both floors →
  C with only section floor → ordinary B2 (section floor 1) → C with section
  floor 1 → floor 0 last resort. Keep the `tierCAfterB2` measuring switch.

### B. Text-only demotable (chapter mode only)

- Tier C pool gains `text_only` memories that aren't protected (milestone,
  quote-title source, hero). Rank: engagement asc, then shorter text first
  (one-liners go first), then id.

### C. Refill (chapter mode only)

- After choosing the prefix k: walk omitted ids in REVERSE plan order, restore
  one at a time with one `runFit`, keep it if totalPages ≤ cap, stop when the
  cap is reached or the list ends (bounded: ≤ 40 attempts). Update
  `omittedIds`/`omittedGaps`. Count fits via `onRunFit`.

### 1. No caption without its media (ALL books)

- `isSoloPhotoGroup` returns false for groups with long text or any audio
  memory. Nothing else changes in pairing.

### 2. Panorama/full-bleed take one asset (ALL books)

- In `buildContentUnits`, a memory chosen as a wide-hero panorama/full-bleed
  contributes only the chosen asset to that unit; its remaining assets are
  pushed back into the run buffer as a normal group (chunked by
  `chunkSingleMemoryAssets`) so they lay out on the following pages. The
  demote rung builds its group from the chosen asset only.

### 3. Themed spreads stay in their chapter (worker `outline.ts`, chapter mode)

- Before admission/pacing: for each surviving themed spread, compute each
  member's chapter (`chapterIndexOfMonth`); home chapter = plurality (tie →
  chapter of the lower-median member). Out-of-home members return to their
  default backbone segment (`reassignDissolvedSpreadMembers`); if < 3 members
  remain (`MIN_SPREAD_SIZE`), dissolve. Record `themed_spread_out_of_chapter`.
- Placement: anchor gap from in-chapter members' median month, CLAMPED to the
  home chapter's gap range; `paceThemedSpreads` is NOT applied in chapter
  mode. Admission budget and the ≤2-per-chapter cap still apply.
- Prompt (optional, if cheap): candidates listed per chapter is a follow-up,
  not required here.

### 4. Text pages (templates + fitter)

- Design (ALL books, `TextPage.tsx/.css`): when a text page holds exactly one
  entry of ≤ 120 chars, render it as a pull quote — Newsreader ~28pt,
  vertically centred at the optical centre, a lavender opening quote glyph,
  the date as a small tracked kicker above; section header (if any) stays at
  the top inside SafeArea. Longer / multi-entry text pages: keep today's
  layout but vertically centre the text block in the free area below the
  header.
- Pooling (chapter mode only, fitter): per chapter, collect
  `isQuoteEligible` memories from that chapter's backbone elements; if ≥ 3,
  remove them from their sections and emit a `quote-collection` (split with
  `partitionQuoteRun`) after the chapter's last backbone section. Fewer than
  3 → leave them (they get the pull-quote design).

### 5. Audio QR (ALL books)

- `AudioNote.tsx`: delete the `mark-text` block (script word + URL) and its
  CSS; keep the 26mm QR with the audio badge inside. Remove
  `furniture.listenToIt`, the `shortCode` page param and
  `placeholderShortCode`; update tests that pin them.

### 7. Audit checks (renderer `audit.ts`, ALL books)

- `media-memory-without-media`: every non-omitted memory with ≥ 1 asset has
  ≥ 1 rendered photo/video slot somewhere in the book.
- `unrenderable-slots`: a page's slot count exceeds what its template can
  draw (e.g. `anchor-media` with ≥ 3 photo slots).
- `title-then-empty`: a title-only page (chapter / spread-title) immediately
  followed by a page with no media and no text entries.

## Golden snapshots (deliberate updates)

Fixes 1, 2, 4-design and 5 change ALL books, so the renderer characterization
golden (`fitter.golden.test.ts`) WILL change. Implementers must NOT run
`vitest -u`; they report which golden cases fail and why. The orchestrator
reviews the golden diff and updates it once, deliberately, at the end. The
worker golden (`outline.golden.test.ts`) must stay green (A, 3 are
Everything-only).

## Acceptance (dogfood round 2)

Regenerate Enzo + Mara Everything books; offline audit must show: 0 integrity
violations; 122 pages (or the true maximum); every chapter's keep-rate within
~5 points; no section with only a one-liner; every themed spread's members in
its home chapter; no media-less memory; owner page-by-page review.
The 3 kept year books re-audited: no new violations; any page changes are
explained by fixes 1/2/4/5 only.
