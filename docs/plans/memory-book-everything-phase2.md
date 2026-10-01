# Memory Book — Everything scope, Phase 2 implementation spec (D1–D6)

Status: spec approved 2026-10-01 · **all work packages (WP-0, A, B1, B2, C, D, E, F) code-complete 2026-10-01, not deployed** · pending owner: copy review, Tier C confirmation, themed-spread survival risk (single placement), dogfood run
Parent plan: [memory-book-everything-fixes.md](memory-book-everything-fixes.md) (Phase 2, items 2.1–2.8; owner decisions D1–D6 are locked there).

Everything below was read from the code at HEAD 117b571, line numbers included. Anything not read from code is marked **UNVERIFIED**.

## Orchestrator decisions (2026-10-01)

- Open questions 1, 3, 5, 6: defaults ACCEPTED. Month-aligned chapters; Firsts cap 6; themed anchoring by median date, ≤8 total, ≤2 per chapter; no pacing or spread budget for year books now.
- Q2 copy: the strings proposed below are used as-is for implementation and are **pending owner copy review** (see the table in "Copy strings").
- Q4 Tier C: IMPLEMENT behind a constant `ENABLE_TIER_C_CAPTIONED_DEMOTION = true`, chapter mode only. **Pending owner confirmation after the dogfood run.**
- Q7: the fitter dropping `birthday` elements is a separate bug, NOT in the Phase 2 work packages (see "Known defect (separate fix)"). For Everything the worker must not emit birthday spreads.

## Copy strings (pending owner copy review)

| Where | es | en |
|---|---|---|
| Chapter title, n=1…10 | Tu primer / segundo / tercer / cuarto / quinto / sexto / séptimo / octavo / noveno / décimo año; n≥11: "Tu 11.º año" | Year One … Year Ten; n≥11: "Year 11" |
| Chapter kicker | capítulo uno / dos … (digits past ten) | chapter one / two … |
| ThroughTheYears kicker (Everything) | los años en retratos | the years in portraits |
| ThroughTheYears title lines (Everything) | "Cómo cambiaste" / "con los años" | "How you changed" / "over the years" |
| Closing headline (Everything) | Y la historia continúa. | And the story continues. |
| Closing count line (Everything) | Este libro recoge ${n} recuerdos, de ${y0} a ${y1}. (if y0=y1: "de ${y}") | This book holds ${n} memories, from ${y0} to ${y1}. |
| Firsts default title (worker fallback, Everything) | n/a (English fallback) | Big and small victories |

## Findings that shape the design

1. **The fitter ignores `kind: 'birthday'` elements.** See "Known defect (separate fix)".
2. **Cap demotion pools are narrow.** Only these memories are demotable (`gatherDemotionCandidates` L3527, `gatherIllustratedDemotionCandidates` L3564):
   - photo-only or video-only memories with no caption and no milestone;
   - digest-eligible illustrated memories.
   - Captioned photos and long text are never cut ("text is sacred"). Real Everything data has ~490 memories with assets, so reaching ≤122 pages from these pools alone may be impossible. Hence Tier C in 2.3.
3. **The cap loop is one full `runFit` per omission** (`fitBook` L3912–3956).
   - The pick order depends only on pools, counts and omitted ids, never on layout. Only the termination test needs a fit.
   - ~300 omissions × full re-fit is a likely preview and Fly `/fit` latency problem. The web preview refits on every edit (`useEditableBook.ts` L201–203, `useMemo`). **Timing UNVERIFIED.**
4. **`extractYearOrdinal` already returns null for non-`age-year` kinds** (`ordinals.ts`). An Everything book (`kind:'custom'`, label `"Everything"`, hard-coded English at `src/utils/memory-book-scope.ts` L251) therefore closes with "…recuerdos de Everything." in an es book. The 2.7 count line fixes that.
5. **No renderer code branches on `scope.kind` or `outline.scope.type` except `extractYearOrdinal`.** Verified by grep: `workflow.ts` L333 only writes it and `manifest.ts` L264–270 maps it. The Expo app reads neither field.
6. **The render path is shared.** The Fly worker's `/fit` (`render/memory-book-renderer/src/fit.ts`, which imports `book-renderer` sources) feeds `memory-book-orders` page-count quotes. The web preview and Fly `/render` use the same fitter. Every new fitter behaviour is therefore gated on new data so existing ready year books stay byte-identical.

## Known defect (separate fix, NOT in Phase 2 work packages)

- `runFit`'s switch (`book-renderer/src/model/fitter.ts` L3664–3815) has no `birthday` case, so it falls to `default: continue`. `OutlineElementKind` (`types.ts` L158) has no `birthday` either.
- The worker emits `birthday-N` elements (`reading-order.ts` ~L248–279) when ≥3 memories carry a birthday milestone for one age. Those memories are removed from the backbone and then never laid out. No audit check catches it.
- Year books are affected whenever such an element exists. **UNVERIFIED** against stored production docs: check `book_document.outline.elements[kind='birthday']`.
- Everything has 4–5 birthdays, so it is much more exposed. For Everything the worker must NOT emit birthday spreads. Those memories stay in their backbone month, which is flagged deterministically from DOB (see 2.2).
- Do not change year-book behaviour in Phase 2, because a fix would alter regenerated output. File a separate fix: either a fitter `case 'birthday'` or a worker change.

## Known defect 2 (found during WP-0, separate fix)

- The worker emits `firstsWarmNames` on the firsts outline element (`cloudflare/memory-book-worker/src/reading-order.ts` L249 / L398), but the renderer fitter reads `element.firstsEntries` (`book-renderer/src/model/fitter.ts` ~L4147; type in `types.ts` L221). The entry shape matches (`{ memoryId, milestoneId?, warmName }`) but the element key does not, so the AI-generated warm names never reach the renderer and Firsts captions always fall back to each memory's own text.
- Affects year books and Everything alike. Not changed in Phase 2 (it would change regenerated year-book output). Fix: rename the worker's emitted key to `firstsEntries` (or have the fitter read `firstsWarmNames`). Add a seam test that a warm name set in the outline appears on the rendered Firsts page.

---

## 0. Scope identity

**Decision.** Extend the existing enum with a new value and branch on it. Do not add a parallel field.

- `supabase/functions/_shared/memory-book-manifest.ts` L227: `ManifestScopeKind = 'age-year' | 'calendar-year' | 'everything' | 'custom'`.
- `mapScopeKind` (L229–233): add `if (t === 'everything') return 'everything'`. `custom-range` and unknown still map to `'custom'`.
- `cloudflare/memory-book-worker/src/manifest.ts` `scopeKindToOutlineType` (L264–270): add `everything` → `'everything'`. `custom_range` → `'custom'` unchanged.
- `workflow.ts` L333 (`scope: { type: manifest.scope.kind }`) then yields `'everything'` with no edit.
- Renderer types: `ManifestScope.kind` and `BookOutline.scope.type` are already `string`. No type change. The fitter and templates use `manifest.scope.kind === 'everything'`.

**Backward compatibility.**
- Stored docs from before this change say `'custom'`. That value keeps the old furniture strings.
- The multi-year fitter mode is gated on the **presence of `chapter` outline elements**, not on the scope kind. Old docs have none, so they take the identical legacy path.
- Intentional consequence: `kind:'custom'` (old Everything or custom_range) keeps "Hasta el año que viene" and "doce meses". Byte-identity requires this. Custom-range books are out of scope per the parent plan §5.

**Tests.**
- Update `supabase/scripts/eval-memory-book-assets.test.ts` L821: `mapScopeKind('everything')` → `'everything'`; `'custom-range'` → `'custom'` still holds.
- `cloudflare/memory-book-worker/test/manifest.test.ts`: each of the four `scopeKind` values maps as specified.
- `workflow.integration.test.ts`: published `outline.scope.type` is `'everything'`.
- Renderer: `extractYearOrdinal({kind:'everything'})` is null; legacy `kind:'custom'` Closing and ThroughTheYears snapshots are unchanged.

---

## 2.1 D2 window start = max(child DOB, first eligible memory)

**New shared helper:** `supabase/functions/_shared/memory-book-scope-window.ts`, with `memory-book-scope-window.test.ts`. It moves `EMPTY_WINDOW_SENTINEL`, `addDaysToDateOnly` and `ScopeWindowError` out of both consumers. Today they are duplicated at bridge L358 and L130–138, and at edits L715–731. `memory-book-edits` re-exports `ScopeWindowError` so its tests keep importing it.

```ts
export async function resolveEverythingWindow(
  supabase, { familyId, childId: string|null, childDateOfBirth: string|null }
): Promise<{ start: string; endExclusive: string }>
```

**How "first eligible" is resolved** (tags are loaded after the window today):
- Do not rely on a PostgREST `is.null` embed filter. Its support is **UNVERIFIED** in this repo.
- Page `memories` ascending, with `.gte('memory_date', dob)` when DOB is known.
  - Select `id, memory_date, memory_family_members(family_member_id)`.
  - Order by `memory_date, id`; page size 200 via `.range`.
  - This is a left embed with a single FK from `memory_family_members.memory_id` to `memories`. Confirm there is no PGRST201, as Phase 0.3 did.
- Stop at the first row where `tags.length === 0 || tags.some(t => t.family_member_id === childId)`. With `childId` null, take the first row.
- Cap at 50 pages (~10k rows), then throw `ScopeWindowError`.
- Query errors throw `ScopeWindowError`, never the sentinel (the Phase 0 rule).
- `end` = latest family memory, as today. D2 only changes the start.

**Nuance versus the literal D2 formula.** I search for the first eligible memory on or after DOB. That equals `max(DOB, firstEligible)` whenever the first eligible memory is on or after DOB. With pre-birth eligible memories it is stricter, because the window never opens on empty days.

**Edits to existing code.**
- Bridge `buildGenerationContext` L359–369: replace the two `Promise.all` queries with the helper. The child (including `dateOfBirth`) is already loaded at L339–349. The Phase 0.3 `countWindowRows` and `loadWindowRows` already take the resolved `windowStart`, so reconciliation uses the same window with no change.
- `memory-book-edits/index.ts`:
  - `BookRow` (L546): add `child_id: string | null`.
  - The book select (L1083): add `child_id`.
  - `resolveScopeWindow` (L740): for `everything`, look up the child's DOB (`family_members`, error checked → `ScopeWindowError`), then call the shared helper.
  - Optional hardening: if `book.book_document?.outline?.window` is a valid frozen window, prefer it. That guarantees the picker pool equals the generated window.
- Optional, for 2.6: add `status` to the milestone select (bridge L248–253) and to `DbMilestoneRow`. It is additive; the worker treats missing as `'candidate'`.

**Tests.**
- Helper unit test with a small in-memory fake that honours `gte`, `order` and `range` (the existing stubs are filter-blind).
- Cases:
  - the first memory is tagged only to another member → skipped;
  - an untagged memory → eligible;
  - a memory tagged to the child → eligible;
  - DOB later than the earliest memory;
  - no DOB;
  - no eligible memory → sentinel;
  - an error on the tag-embed query → `ScopeWindowError`;
  - more than one page before the first eligible memory.
- Bridge test: the `everything` window start flows to the count queries' `gte`; a tag-query error → 500 `context_load_failed`.
- Contract test: bridge and edits produce the same window for the same stub.

---

## 2.2 D3 chapters per age-year and quarter-capped backbone

### Chapter representation

**A new outline element kind `chapter`, rendered with the EXISTING `spread-title` template. No new template, no template or CSS change, so no snapshot risk.**

- Worker `ReadingOrderSectionKind` and renderer `OutlineElementKind` gain `'chapter'`. `OutlineElement` gains optional `chapter?: { ageYear: number; startMonth: string; endMonth: string }`.
- The fitter `runFit` gets `case 'chapter'`, which builds a single `spread-title` page (like `buildSpreadTitlePage` L2234) with:
  - `kicker` = chapter kicker furniture;
  - `title` = chapter title furniture;
  - `subtitle` = `localizeMonthLabel(element.subtitle, lang)` (cross-year labels were handled by Phase 1.3);
  - `titleMode: 'descriptive'`;
  - `page.sourceElementId` = the chapter element id.
- `sectionTitle:<id>` and `eyebrow:<id>` edits already work on any `spread-title` page (`edits.ts` L534), so chapter titles are editable for free.
- Furniture additions (`furniture.ts`): `chapter: { kicker(n), title(n) }` using `ordinalWord` and `numberWord`. Strings are in the copy table above. The worker's `element.title` is the English fallback ("Year Two"); the fitter localizes it, so the worker needs no language.

**Page cost.**
- One page per chapter. A chapter title page renders on the left (even) page, so budget ~1.5 pages average if parity is forced. For 4–5 chapters that is ~4–8 of 122 pages (3–6%).
- Forced-even-landing needs a new `BlankReason` `'parity:chapter-opener'` added to `BLANK_REASONS` (fitter L274). `RECOGNIZED_BLANK_REASONS` in the audit is derived from it automatically.
- Whether themed `spread-title` pages already force even landing is **UNVERIFIED** (`runFit` L3694–3713 does not; `SpreadTitle.tsx` hard-codes `Folio isEvenPage`). Decide on the dogfood run. If themed titles tolerate odd landing, skip the blank and save ~2 pages.

**Rejected cheaper alternative.** Put "Tu primer año" as the kicker of each chapter's first section header. It costs 0 pages but does not read as a chapter in print.

**Dissolve-if-empty.** Mirror the themed guard (L3687–3713). Precompute, per chapter element, whether any following backbone, themed or firsts element before the next chapter retains a non-omitted memory. If none, skip the chapter page.

**Audit.** Extend `auditSectionTitleOrphans` (`audit.ts` L170–193) so a `chapter` title page with no content pages before the next chapter is a `section-title-orphan` violation.

### Chapter boundaries (month-aligned, accepted)

Boundaries come from DOB using `addYears` from `supabase/functions/_shared/date-context.ts` (L34, Feb-29 clamped; already imported by the worker's `eligibility.ts`). The month containing the Nth birthday is the LAST month of chapter N ("the month you turned N").

- `endMonth_N = addYears(dob, N).slice(0,7)`; `startMonth_1 = dob.slice(0,7)`; `startMonth_N` = the month after `endMonth_{N-1}`.
- Each calendar month appears once, so the fitter's month floor, the age-eyebrow code and the audit (all keyed by calendar month) keep working. There are no duplicate "October 2023" sections.
- New pure module `cloudflare/memory-book-worker/src/chapters.ts`: `computeAgeYearChapters(dob, firstMonth, lastMonth)` and `chapterIndexOfMonth(chapters, month)`.
- Drop chapters with zero eligible printable months. Emit chapter elements only if ≥2 non-empty chapters remain (**"chapter mode"**). Otherwise Everything degenerates to the legacy structure, still with the quarter cap.
- No DOB → no chapters.
- Chapter `subtitle` (English) = `formatMonthRangeLabel([firstActualMonth, lastActualMonth])` of its content. `chapter.startMonth/endMonth` stay theoretical (the fitter uses them for assignment).

### Quarter-capped backbone (`backbone.ts` `buildBackboneSegments`, L33–91)

New signature (defaults reproduce today's behaviour exactly):

```ts
buildBackboneSegments(memories, minPrintable = 3,
  options?: { maxSpanMonths?: number; chapterOfMonth?: (monthKey: string) => number })
```

- Group month keys by chapter and run the existing merge loop per chapter.
- Cap = calendar span (last − first + 1 month) ≤ 3. This is rolling, not calendar-quarter aligned, and empty months count toward the span.
- When the cap is hit the segment flushes even with <3 printable memories. The cap wins over the minimum.
- The trailing-tail fold (L73–90) must not exceed the cap or cross a chapter. If it would, emit the tail as its own segment.
- Add optional `chapterIndex?: number` to `BackboneSegment` (`_shared/memory-book-outline.ts` L149).
- Birthday and birth flags for `everything`: replace the data-driven map at `outline.ts` L135–142 with a deterministic `computeBirthdayMonthsFromDob(dob, windowStart, windowEndExclusive)` in `backbone.ts`. It maps month(addYears(dob,a)) → a for every birthday inside the window, and reuses `flagSpecialBackboneSegments`. A birthday month ends its chapter, so a section never spans a birthday into the next chapter.
- `outline.ts` L170–186: skip `birthday-N` spreads for `everything` (see the known defect).
- `reading-order.ts` `buildReadingOrder` (L233–342): add optional input `chapters?`.
  - Emit chapter 1 before `pushThemedAt(-1)`.
  - Emit each later chapter immediately before its first backbone segment, after the previous gap's themed spread.
  - Each chapter section has `memoryIds: []`, `id: 'chapter:<ageYear>'`, and the `chapter` meta.
- `workflow.ts` `estimatePageCount` (L441): add `chapter: 1`.

**Tests.**
- `backbone.test.ts`: the four existing tests untouched; span ≤3 including a gap month (Jan + Aug never merge); the tail never exceeds the cap; a chapter boundary is never crossed; an Everything-shaped input produces no "enero–junio" section.
- New `chapters.test.ts`: DOB 2022-10-23 with window 2023-01 → 2026-09; Feb-29 DOB; DOB in January; an empty chapter dropped; a single chapter gives chapter mode off.
- `reading-order.test.ts`: chapter placement relative to themed spreads at gap −1 and at chapter seams; the existing test at L126 unchanged without `chapters`.
- Fitter: `case 'chapter'` page content in es and en; the empty-chapter dissolve; the parity blank; the audit orphan.

---

## 2.3 D1 proportional per-age-year budget and time-spread tie-break (fitter)

**Gate.** `chapters = outline.elements.filter(kind === 'chapter')`. Chapter mode is `chapters.length >= 2`. Otherwise `fitBook` runs the existing code path unchanged.

**Why it cannot regress single-year.** Only the new worker emits `chapter` elements, and only for Everything with ≥2 age-years. Year, calendar, custom and old docs contain none, so the new branch is a single `if` and the legacy loop is untouched. The WP-0 golden tests prove it.

**Budgeting rule: equalise the keep-rate across chapters.** Equal keep-rate across chapters means each chapter keeps the same fraction of its memories, which is exactly "page budget proportional to eligible-memory count". It reuses the shape of `pickHighestKeepRateKind` (L3613).

- `total_c` = number of memories in backbone and themed elements whose month falls in chapter c. Count all resolved memories, including protected ones, like `backboneThemedKindTotals` L3594.
- `omitted_c` = omitted count so far.
- Per-chapter floor in memories: `CHAPTER_FLOOR = min(total_c, 12)` (new constant next to `MIN_MEMORIES_PER_MONTH`, L257). This is the "small per-year floor".
- Add `chapterIndex` to `DemotionCandidate` (L3476), derived from `month` via `chapterIndexForMonth`.

**Selection per step.**

1. **Tier A.** Candidates must be above both the month floor and the chapter floor.
   - Pick the chapter with the highest keep-rate `(total_c − omitted_c)/total_c` among chapters that still have an above-floor candidate. Ties → larger `total_c`, then lower index.
   - Within that chapter, pick the kind with the existing `pickHighestKeepRateKind` using global totals (keeps photo/video/illustrated parity).
   - Within that chapter and kind, take the minimum `rank`.
2. **Tier B1.** Relax the chapter floor, keep the month floor.
3. **Tier B2.** Relax both (today's Tier B).
4. **Tier C** (last resort, chapter mode only), behind `export const ENABLE_TIER_C_CAPTIONED_DEMOTION = true`, **pending owner confirmation after the dogfood run**.
   - Add captioned photo and video memories as demotable candidates: not protected (hero, panorama, milestone, quote-title source), ranked by engagement then shorter text first, classified as kind `photo` or `video`.
   - Run it only after all other tiers are exhausted and the book is still over cap.
   - With the flag false the fitter behaves as before this tier existed; add a test for each flag value.

**Time-spread tie-break (replaces date order).** Among candidates tied on `rank` within the chosen chapter and kind:
1. prefer the one whose calendar month has the highest remaining fraction `remaining_m / original_m`;
2. then the highest remaining count;
3. then memory id ascending.

Today a stable ascending sort cuts the earliest memories first on ties, which was the incident behaviour. Month equalisation spreads cuts across time. Memory ids are random uuids, so the final tie is not date-biased.

**Performance (finding 3).**
- Add a pure `planChapterDemotions(outline, manifest, chapters)` that returns the whole ordered omission list, using the same pool state machine as above but no `runFit`.
- In `fitBook`, replace the one-per-fit loop in chapter mode with an exponential then binary search on the prefix length `k` for `runFit(k).totalPages <= cap`, then probe `k-1` and `k-2` for parity noise. That is ~20 fits instead of hundreds.
- If even the full list leaves the book over cap, return it as `overCap`, as today.
- Emit one `LayoutGap` per omission (the same `omittedGaps` shape) with a chapter-aware reason string.
- Optional test hook: `FitOptions.onRunFit?: () => void`, to assert the fit count.

**Tests (fitter.test.ts or a new file).**
- Three chapters of 10/30/60 memories with equal engagement → omitted counts proportional (±1), floors respected.
- Within one chapter, all-zero engagement → omissions spread across months, not earliest-first.
- A single chapter element is ignored: identical `omittedMemoryIds` and pages to the same outline without it.
- Synthetic ~600-memory, 5-chapter fixture with a realistic kind mix → totalPages ≤122, `auditBookDocument` returns `[]`, every chapter ≥ floor, keep-rates within a few points, fit count ≤ ~25.
- Tier C: engages only when other tiers are exhausted and the book is over cap; off when the flag is false.
- Existing round-13 tests (e.g. "tie-break: photo, then video, then illustrated") pass untouched.

---

## 2.4 Port `paceThemedSpreads` and the spread budget to the worker

**Everything only for now (accepted).** Port faithfully and gate on `isEverything` in `outline.ts`. Year-book regeneration stays byte-identical to the current worker. Extending these rules to year books is a separate follow-up decision; it would change themed spread count and placement on regenerated year books.

**New file `cloudflare/memory-book-worker/src/pacing.ts`**, copied from the eval CLI (L1753–1795, 1854–1895, 2096–2185):
- `findAnchorSegmentIndex`, `computeMedianDate`, `computeRequiredPacingGaps`, `paceThemedSpreads`;
- `SPREAD_SPILL_BOUND = 2`, `SPREAD_BUDGET_PAGES_PER_SPREAD = 15`, `computeThemedSpreadBudget`, `admitThemedSpreads`, `reassignDissolvedSpreadMembers`;
- `isTimeAnchoredCandidate`, with `TIME_ANCHORED_TOPIC_IDS = {'newborn-days', ...DATE_GATED_TOPIC_IDS}` from `_shared/memory-topics.ts` L207.

**Wiring (`outline.ts`).** After the themed and birthday dissolves (L261–274) and before the final membership rebuild (L276), for `everything` only:
- For each surviving themed spread, compute `idealGap = findAnchorSegmentIndex(median month of members, backboneSegments)`. The worker never re-segments, so these are the same indices the AI saw.
- Run `paceThemedSpreads`, then `admitThemedSpreads` with `budget = floor(min(eligibleCount, pageBudget) / 15)` (8 for 122).
- Per-chapter cap of 2: when the anchor chapter already holds 2, dissolve the lowest-priority one.
- Dissolved members return to their default backbone segment via `reassignDissolvedSpreadMembers`.
- Use the placed gap for `insertAfterFinalSegmentIndex` (L328). The AI's `insert_after_segment_index` is ignored for Everything.
- Record `themed_spread_dissolved_budget` violations.

**Tests.**
- `pacing.test.ts`: port the eval tests (anchoring, pacing stride, admission with spill, determinism).
- Outline-level: 12 candidates → ≤8 admitted, none adjacent, ≤2 per chapter.
- Year-book golden unchanged.

---

## 2.5 D4 portrait sampling and scope-aware title

**Sampling lives in the worker manifest builder** (`manifest.ts` L219–229, after the portraits loop). It is deterministic and auditable in the stored document, and the fitter and templates stay unchanged (`partitionPortraits` L2121 already yields ≤2 spreads for 6 portraits). It is gated on `context.book.scopeKind === 'everything'`.

**Rule** (new pure `samplePortraitsForMultiYear`; constants `PORTRAIT_MONTHS_PER_SAMPLE = 6`, `PORTRAIT_MAX = 6`):
- Sort by date.
- `n = min(6, max(1, ceil(spanMonths/6)))`. If the portrait count is ≤ n, keep all.
- Always keep the first and the last. The last is also used on the cover (`fitter.ts` L2039).
- Otherwise target dates `t_i` evenly spaced between first and last, and pick the nearest unused portrait for each.
- Example: 17 portraits over ~47 months → 6, partitioned [3,3].
- Feed the sampled count into `throughTheYearsCount` (`outline.ts` L199) so the prompt matches.

**Strings** (new `Furniture.throughTheYearsMultiYear`; `ThroughTheYears.tsx` L28–32 picks it when `manifest.scope.kind === 'everything'`; `ttyKicker` and `ttyTitle` edits still win): see the copy table (pending owner copy review).

**Tests.**
- Worker: sampling cases (17 over 47 months; fewer than n; first and last kept; sorted; no duplicates; year-book scope untouched).
- Furniture and ThroughTheYears render snapshots for `everything`, `age-year` and legacy `custom`.
- `partitionPortraits(6) = [3,3]`.

---

## 2.6 D5 Firsts cap

**New `cloudflare/memory-book-worker/src/firsts.ts`**, with `FIRSTS_MAX_MEMORIES_MULTI_YEAR = 6` (accepted; ≈ title page plus two grid pages; confirm the page cost on the dogfood run).

**Selection** (only when `isEverything`):
- Candidates: for each non-birthday `milestone_id`, the earliest memory holding it.
- Score per memory:
  - `+2` per confirmed milestone (needs the optional `status` field);
  - `+1` per milestone not `out_of_band`;
  - `+2` if it has a photo or video;
  - ties by engagement descending, then date ascending.
- Take the top 6, then sort chronologically. The current worker returns firsts in memory-id order (`resolveSinglePlacement` insertion order), so sort explicitly.
- Everything not selected stays in the backbone. Milestone holders are still protected from demotion (`fitter.ts` L3538).

**Wiring (`outline.ts`).**
- `firstsMemoryIds` / `firstsCount` / `firstsPresent` (L170–176) use the capped set.
- `validMilestoneKeys` (L222) is restricted to the capped set.
- `OutlineSkeletonSummaryInput` gains optional `firstsMemoryIds`. `buildOutlineUserPrompt` L360–369 lists FIRSTS MILESTONES rows only for those ids, and lists all of them when the field is undefined.
- `FIRSTS_DEFAULT_TITLE` (`reading-order.ts` L223) gets a multi-year variant ("Big and small victories"), chosen by `buildReadingOrder`.

**Tests.**
- 23 milestones across 12 memories → ≤6 memories, one per distinct milestone first, chronological.
- Prompt rows match the capped set.
- A year book keeps all milestone memories in firsts (golden).

---

## 2.7 D6 closing and outline prompt

**Closing (renderer).** New `Furniture.closing.multiYear: { headline, memoryCountLine(count, startYear, endYear) }`, used by `Closing.tsx` L53–64 when `manifest.scope.kind === 'everything'` (strings in the copy table).
- Years come from `manifest.scope.start/end` `.slice(0,4)`. This also removes the English `scope.label` leak.
- `closingTitle` and `closingLine` edits still override.
- Year scopes keep "Hasta el año que viene." / "See you next year." unchanged.

**Outline prompt (`_shared/memory-book-outline.ts`).**
- `buildOutlineSystemPrompt(options?: { multiYear?: boolean })`. The default output stays byte-identical, so the existing assertions in `supabase/scripts/eval-memory-book-outline.test.ts` (L1895–2100) still pass.
- When `multiYear` is set, insert a **MULTI-YEAR BOOK** block after the LANGUAGE paragraph (after L242). It tells the model:
  - this book spans several years, organised into one chapter per age-year;
  - read "this year", "of the year" and "a year of memories" as "across the years";
  - `firsts_title` is framed as "big and small victories" with no "this year";
  - the dedication cites the first and last dates of the span and never says "este año";
  - `back_cover_line` is about years of memories;
  - hero, cover and panorama candidates should be spread across different years;
  - birthday months are titled "the month you turned N" using the flag's N;
  - selection across years is handled by code, so do not favour recent years.
- `OutlineSkeletonSummaryInput` gains optional `chapters?: Array<{ageYear; startMonth; endMonth}>`. `buildOutlineUserPrompt` then prints a CHAPTERS block and tags each BACKBONE SEGMENT line with its chapter.
- The worker (`outline.ts` L208–209) passes `multiYear: isEverything`.

**Tests.**
- The default prompt is unchanged.
- The multi-year block contains the key phrases.
- The CHAPTERS block appears only when supplied.
- Closing render in es and en for `everything`, legacy `custom`, and `age-year`.

---

## 2.8 Tests and integrity audit

**Characterization first (WP-0), before touching any fitter or worker logic.** Commit snapshots generated from the baseline code:
- A seeded synthetic ~300-memory year-book fixture in `book-renderer/src/model/__tests__/fixtures/`. The real dogfood books are private and the repo fixtures hold only ~10 memories.
  - It includes photo, video, illustrated and captioned memories.
  - It is fitted both uncapped and at a squeezed cap, so demotion is exercised.
  - The snapshot is a hash or JSON of `pages`, `omittedMemoryIds` and `gaps`.
  - Variants: scope kind `age-year`, `calendar-year`, and a legacy `custom`.
- A worker `test/outline.golden.test.ts`: `runOutlineStage` and `buildBookManifest` with `vi.mock` on `./openai`, for `age_year` and `calendar_year` contexts. The worker has no `outline` test today.

**Per-item tests** are listed inside each section above.

**Fitter integrity audit.**
- Extend `book-renderer/scripts/audit-layout.mts`. It does not currently call `auditBookDocument`.
  - Call `auditBookDocument(document, outline, manifest)` and print violation counts by check.
  - Add per-chapter stats: pages, memories kept and total, keep-rate, months at floor.
  - Keep its privacy rule: ids and counts only.
- `audit.ts` also gets the `chapter` extension to `auditSectionTitleOrphans` (see 2.2).
- Acceptance: both dogfood Everything books (Enzo 4y, Mara 2y) fit with 0 violations and ≤122 pages.

**Run suites.**
- Worker: `npm test` and `npm run typecheck` in `cloudflare/memory-book-worker`.
- Renderer: `npm test` in `book-renderer`.
- Deno: `deno test` for `supabase/functions/_shared`, the bridge, `memory-book-edits`, and `supabase/scripts/eval-memory-book-*.test.ts`.

---

## Work packages by file cluster

No two packages touch the same file.

**WP-0 (first): characterization goldens.** New files only: `book-renderer/src/model/__tests__/fixtures/syntheticYearBook.ts`, `fitter.golden.test.ts`, `cloudflare/memory-book-worker/test/outline.golden.test.ts`.

**WP-A: shared builders and scope identity.**
- `supabase/functions/_shared/memory-book-manifest.ts`
- `supabase/functions/_shared/memory-book-outline.ts` (`chapterIndex`, multi-year prompt, skeleton fields)
- `supabase/scripts/eval-memory-book-assets.test.ts`
- `supabase/scripts/eval-memory-book-outline.test.ts` (new prompt tests)

**WP-E: Edge Functions window and milestone status.**
- new `_shared/memory-book-scope-window.ts` and test
- `workflow-memory-book-bridge/index.ts` and `index.test.ts`
- `memory-book-edits/index.ts` and `index.test.ts`

**WP-B2: pure worker modules.** New files and tests only: `pacing.ts`, `firsts.ts`, `chapters.ts`, a portrait-sampling module, with `test/pacing.test.ts`, `firsts.test.ts`, `chapters.test.ts` and the portrait-sampling test.

**WP-B1: worker wiring.** Needs A and B2.
- `backbone.ts`, `outline.ts`, `reading-order.ts`, `manifest.ts`, `workflow.ts`
- tests: `backbone.test.ts`, `reading-order.test.ts`, `manifest.test.ts`, `workflow.integration.test.ts`

**WP-D: renderer furniture and templates.**
- `book-renderer/src/templates/furniture.ts`, `Closing.tsx`, `ThroughTheYears.tsx`
- `__tests__/furniture.test.ts`, `templates.test.tsx` and its snapshot

**WP-C: renderer fitter and model.** Needs D.
- `book-renderer/src/model/fitter.ts`, `types.ts` (incl. `FitOptions`), `audit.ts`
- `__tests__/fitter.test.ts`, `audit.test.ts`, plus new fixtures

**WP-F: tooling and docs.** Needs C and B1.
- `book-renderer/scripts/audit-layout.mts`
- `docs/features/memory-book-generation.md` (changelog row and new section)
- the parent plan's status block

**Dependency order:** WP-0 → {A, D, E, B2 in parallel} → {B1 after A and B2; C after D} → F. The birthday-element defect has no work package here.

---

## Deploy implications

- **Renderer (WP-C, D).** The web preview (`cloudflare/memory-book-web`) and the Fly print worker (`render/memory-book-renderer`, which also serves `/fit` for quotes) must redeploy together (the parity rule). Deploy first; it is backward compatible, and existing year docs are byte-identical by design.
- **Bridge and memory-book-edits (WP-E).** Both need Edge Function deploys. The response shape is unchanged, so the bridge is safe with the old worker. The optional additive `status` field is safe in either order.
- **Worker (WP-A, B1, B2).** `wrangler deploy --env=""` in `cloudflare/memory-book-worker`. The shared `_shared/memory-book-*.ts` files are bundled into it. Deploy last, after the renderer; the reverse order would publish documents with `chapter` elements that an old renderer silently skips.
- **No redeploy needed:** `generate-memory-book` (the `PAUSED_SCOPE_KINDS` pause stays until Phase 3.3), `memory-book-orders`, `stripe-webhook`, the order worker, and the Expo app (no OTA). The `_shared` manifest changes are additive to the Edge Function consumers of `memory-book-backfill`.
- **Order of operations:** renderer (web and Fly) → bridge and edits → worker. Then generate the dogfood books through the owner allowlist.

---

## Where single-year behaviour could regress, and the guarantee

| Risk | Guarantee |
|---|---|
| `mapScopeKind` / `scopeKindToOutlineType` | Only the `everything` branch changes. The test lists all four scope kinds. |
| `buildBackboneSegments` | New options default to today's behaviour. The existing four tests are untouched. |
| `buildReadingOrder` | New inputs are optional. The test at L126 is unchanged. |
| `outline.ts` | Every new branch is gated on `isEverything` and DOB. WP-0 golden fixes the baseline output. |
| `buildOutlineSystemPrompt` / `UserPrompt` | Default parameters produce the identical string. The eval CLI tests catch drift. |
| Fitter | New behaviour is gated on `chapter` elements. WP-0 golden covers cap-squeezed year books and legacy `custom`. |
| Furniture, `Closing.tsx`, `ThroughTheYears.tsx` | Branches only on `scope.kind === 'everything'`. Snapshots of `age-year` and `custom` are unchanged. |
| `memory-book-edits` | `resolveScopeWindow` is untouched for non-`everything` kinds. `ScopeWindowError` stays exported. |
| `audit.ts` | The new orphan check iterates only chapter elements. |

---

## Decisions and remaining open items

Resolved by the orchestrator (2026-10-01):
1. Chapter boundary: month-aligned (the birthday month closes the chapter).
2. Copy strings: as proposed in the copy table, pending owner copy review.
3. Firsts cap: 6 memories.
4. Tier C: implemented behind `ENABLE_TIER_C_CAPTIONED_DEMOTION = true`, chapter mode only; pending owner confirmation after the dogfood run.
5. Themed spreads: anchor by median date, ≤8 total, ≤2 per chapter, ignore the AI's `insertAfterSegmentIndex`.
6. Pacing and spread budget for year books: not now.
7. Birthday elements dropped by the fitter: separate bug, see "Known defect (separate fix)".

Still unverified, to confirm on the dogfood run:
- the cap-demotion loop's runtime on a ~600-memory book;
- whether the existing pools reach ≤122 pages without Tier C;
- whether themed `spread-title` pages are forced to land on the left page (decides the chapter-opener parity blank);
- the Firsts cap's page cost;
- the PostgREST left-embed behaviour for the first-eligible-memory query;
- whether any stored production doc already contains `birthday` elements.
