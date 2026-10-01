/**
 * Themed-spread pacing, admission budget, dissolve reassignment and the
 * per-chapter cap -- docs/plans/memory-book-everything-phase2.md §2.4.
 *
 * `findAnchorSegmentIndex`, `computeMedianDate`, `computeRequiredPacingGaps`,
 * `paceThemedSpreads`, `isTimeAnchoredCandidate` (+ `TIME_ANCHORED_TOPIC_IDS`),
 * `SPREAD_SPILL_BOUND`, `SPREAD_BUDGET_PAGES_PER_SPREAD`,
 * `computeThemedSpreadBudget`, `admitThemedSpreads` and
 * `reassignDissolvedSpreadMembers` are FAITHFUL ports of
 * supabase/scripts/eval-memory-book-outline.ts (see reading-order.ts's header
 * for why the worker duplicates rather than extracts). Behaviour is
 * identical; the only adaptation is the worker's own `BackboneSegment` type.
 * The one NEW piece here is `capThemedSpreadsPerChapter` (+
 * `chapterIndexOfGap`), the Everything-only "<= 2 themed spreads per
 * chapter" rule, which has no eval counterpart.
 *
 * Pure and deterministic: no env, no IO, no clock. Not yet wired into
 * outline.ts (WP-B1 does that; Everything scope only, so year-book output
 * stays byte-identical).
 *
 * Id convention: the worker's themed spreads are keyed by their bare
 * `candidateId` (e.g. `topic:christmas`), NOT the eval CLI's `spread:`
 * -prefixed placement id -- pass the bare candidate id to
 * `isTimeAnchoredCandidate` (the eval strips the prefix before calling it).
 */
import type { BackboneSegment } from '../../../supabase/functions/_shared/memory-book-outline.ts';
import { DATE_GATED_TOPIC_IDS } from '../../../supabase/functions/_shared/memory-topics.ts';

// ── Anchoring ───────────────────────────────────────────────────────────────

/**
 * The last final segment whose own last month is <= `anchorMonth` (a
 * "YYYY-MM" string) -- i.e. "insert right after wherever this chronological
 * point lands". Returns -1 if `anchorMonth` predates every final segment
 * (or there are no final segments at all).
 */
export function findAnchorSegmentIndex(
  anchorMonth: string,
  segments: ReadonlyArray<Pick<BackboneSegment, 'monthKeys'>>,
): number {
  let index = -1;
  segments.forEach((segment, i) => {
    const segmentLastMonth = segment.monthKeys[segment.monthKeys.length - 1];
    if (segmentLastMonth <= anchorMonth) index = i;
  });
  return index;
}

/**
 * Lower-median of a list of `YYYY-MM-DD` date strings (sorts correctly as
 * plain strings). Used to find each candidate spread's "center of gravity"
 * in time. Throws on an empty list -- callers only invoke this for spreads
 * with >=1 member memory (dissolve already removes anything smaller).
 */
export function computeMedianDate(dates: string[]): string {
  if (dates.length === 0) {
    throw new Error('computeMedianDate: cannot compute a median of zero dates');
  }
  const sorted = [...dates].sort();
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// ── Time-anchored candidates ───────────────────────────────────────────────

/**
 * Time-anchored topics: `newborn-days` (not itself date-gated, but inherently
 * tied to a specific real-world window) plus every date-gated seasonal topic
 * from the shared vocabulary. A themed spread built from one of these stays
 * pinned near its median memory date -- pacing may relocate every OTHER
 * candidate kind but never these.
 */
export const TIME_ANCHORED_TOPIC_IDS: ReadonlySet<string> = new Set(['newborn-days', ...DATE_GATED_TOPIC_IDS]);

/** Whether a unified candidate id (e.g. `topic:christmas`) is time-anchored. */
export function isTimeAnchoredCandidate(candidateId: string): boolean {
  if (!candidateId.startsWith('topic:')) return false;
  return TIME_ANCHORED_TOPIC_IDS.has(candidateId.slice('topic:'.length));
}

// ── Pacing ──────────────────────────────────────────────────────────────────

/**
 * A "run" of `minRunLength` (default 3) consecutive, unbroken backbone
 * segments is exactly `minRunLength - 1` consecutive UNOCCUPIED internal
 * gaps (the gap between segment i and i+1, for i in 0..segmentCount-2).
 * Preventing every such run reduces to: no `minRunLength - 1` consecutive
 * empty gaps. A periodic pattern (occupy every `minRunLength - 1`-th gap) is
 * a minimal, deterministic way to guarantee that.
 */
export function computeRequiredPacingGaps(segmentCount: number, minRunLength = 3): number[] {
  const numGaps = Math.max(0, segmentCount - 1);
  const stride = minRunLength - 1;
  const required: number[] = [];
  if (stride <= 0) return required;
  for (let gap = stride - 1; gap < numGaps; gap += stride) {
    required.push(gap);
  }
  return required;
}

export interface PacingCandidate {
  id: string;
  /** Chronological soft preference -- typically the candidate's median
   * memory date, anchored to a final segment index via
   * `findAnchorSegmentIndex`. -1..segmentCount-1. */
  idealGapIndex: number;
  /** Time-anchored spreads (see `isTimeAnchoredCandidate`) are pinned at
   * `idealGapIndex` and never relocated by pacing, even under scarcity.
   * They still COUNT toward gap coverage, just never become a pacing DONOR. */
  anchored?: boolean;
}

/**
 * Redistributes themed spreads across the backbone so no run of
 * `minRunLength`+ consecutive segments goes unbroken, AS LONG AS a spread is
 * available to relocate there (under scarcity, some runs may stay unbroken;
 * that's the best achievable, not a bug). A candidate is "free" to move to
 * fill an uncovered required gap when it is NOT anchored, AND its CURRENT gap
 * either isn't itself required, or is required but already covered by
 * another candidate too. Among free candidates for a gap, the one whose
 * ORIGINAL `idealGapIndex` is numerically closest wins (ties break on id).
 * Firsts and birthday spreads never pass through this function.
 */
export function paceThemedSpreads(
  segmentCount: number,
  candidates: PacingCandidate[],
  minRunLength = 3,
): Map<string, number> {
  const assignment = new Map<string, number>();
  const idealById = new Map<string, number>();
  for (const c of candidates) {
    assignment.set(c.id, c.idealGapIndex);
    idealById.set(c.id, c.idealGapIndex);
  }

  const requiredGaps = computeRequiredPacingGaps(segmentCount, minRunLength);
  if (requiredGaps.length === 0 || candidates.length === 0) return assignment;

  for (const gap of requiredGaps) {
    const alreadyCovered = [...assignment.values()].some((v) => v === gap);
    if (alreadyCovered) continue;

    const freeCandidates = candidates.filter((c) => {
      if (c.anchored) return false;
      const current = assignment.get(c.id)!;
      const occupantsAtCurrent = [...assignment.values()].filter((v) => v === current).length;
      const currentIsRequired = requiredGaps.includes(current);
      return !currentIsRequired || occupantsAtCurrent > 1;
    });

    if (freeCandidates.length === 0) continue; // Scarcity -- nothing safe to move here.

    freeCandidates.sort((a, b) => {
      const distA = Math.abs(idealById.get(a.id)! - gap);
      const distB = Math.abs(idealById.get(b.id)! - gap);
      return distA - distB || a.id.localeCompare(b.id);
    });

    assignment.set(freeCandidates[0].id, gap);
  }

  return assignment;
}

// ── Admission: seasonal spill bound + spread budget + dissolve ─────────────

/** A themed spread may spill at most this many gaps away from its own
 * seasonal anchor gap before it is considered unplaceable. */
export const SPREAD_SPILL_BOUND = 2;

/** At most `floor(min(preCapPageEstimate, pageCap) / SPREAD_BUDGET_PAGES_PER_SPREAD)`
 * themed spreads survive per book (122 pages -> 8). */
export const SPREAD_BUDGET_PAGES_PER_SPREAD = 15;

/** `min(preCapPageEstimate, pageCap)` caps the input at the printer's hard
 * limit first, THEN divides by the per-spread page cost. Never negative. */
export function computeThemedSpreadBudget(preCapPageEstimate: number, pageCap: number): number {
  return Math.floor(Math.max(0, Math.min(preCapPageEstimate, pageCap)) / SPREAD_BUDGET_PAGES_PER_SPREAD);
}

export interface ThemedSpreadAdmissionCandidate {
  id: string;
  memberCount: number;
  /** The spread's own seasonal anchor gap (already paced). */
  anchorGap: number;
}

export interface ThemedSpreadAdmissionResult {
  /** Survivors and the gap each was placed at -- spacing (no two adjacent)
   * AND the spill bound both already satisfied. */
  placedGapById: Map<string, number>;
  /** Ids that DISSOLVE: either cut for budget, or budget-admitted but
   * unplaceable within the spill bound of their own anchor. Sorted. Never
   * "dropped" -- see `reassignDissolvedSpreadMembers`. */
  dissolvedIds: string[];
}

/**
 * Admits themed spreads within a page BUDGET, then places the survivors
 * within a bounded SEASONAL SPILL distance of their own anchor -- anything
 * that loses either contest dissolves rather than drops. Priority for both
 * the budget cut and a contested gap is member count DESC, then id ASC.
 */
export function admitThemedSpreads(
  spreads: ThemedSpreadAdmissionCandidate[],
  lastValidIndex: number,
  budget: number,
  maxSpillDistance: number = SPREAD_SPILL_BOUND,
): ThemedSpreadAdmissionResult {
  const minGap = -1;
  const ordered = [...spreads].sort((a, b) => b.memberCount - a.memberCount || a.id.localeCompare(b.id));

  const withinBudget = ordered.slice(0, Math.max(0, budget));
  const dissolvedIds: string[] = ordered.slice(Math.max(0, budget)).map((s) => s.id);

  const taken = new Set<number>();
  const placedGapById = new Map<string, number>();

  for (const spread of withinBudget) {
    const anchor = Math.min(Math.max(spread.anchorGap, minGap), lastValidIndex);
    if (!taken.has(anchor)) {
      taken.add(anchor);
      placedGapById.set(spread.id, anchor);
      continue;
    }
    let best: number | null = null;
    let bestDist = Infinity;
    const searchStart = Math.max(minGap, anchor - maxSpillDistance);
    const searchEnd = Math.min(lastValidIndex, anchor + maxSpillDistance);
    for (let gap = searchStart; gap <= searchEnd; gap++) {
      if (taken.has(gap)) continue;
      const dist = Math.abs(gap - anchor);
      if (dist < bestDist) {
        best = gap;
        bestDist = dist;
      }
    }
    if (best === null) {
      dissolvedIds.push(spread.id); // unplaceable within the spill bound -- dissolves, never dropped.
      continue;
    }
    taken.add(best);
    placedGapById.set(spread.id, best);
  }

  return { placedGapById, dissolvedIds: dissolvedIds.sort() };
}

/**
 * "Dissolve, never drop": reverses a themed-spread placement for every
 * dissolved spread's members -- each memory returns to its OWN natural
 * chronological backbone home. A memory with no entry in
 * `defaultBackboneByMemory` is left at its current placement rather than
 * silently vanishing. ZERO memories are ever lost: only WHERE an already
 * placed id points changes, never the key set.
 */
export function reassignDissolvedSpreadMembers(
  placementByMemory: ReadonlyMap<string, string>,
  dissolvedSpreadMemberIds: ReadonlyMap<string, readonly string[]>,
  defaultBackboneByMemory: ReadonlyMap<string, string>,
): Map<string, string> {
  const result = new Map(placementByMemory);
  for (const memoryIds of dissolvedSpreadMemberIds.values()) {
    for (const memoryId of memoryIds) {
      const backboneId = defaultBackboneByMemory.get(memoryId);
      if (backboneId) result.set(memoryId, backboneId);
    }
  }
  return result;
}

// ── Per-chapter cap (NEW -- no eval counterpart; Everything chapter mode) ──

/** At most this many themed spreads may sit in one chapter. */
export const MAX_THEMED_SPREADS_PER_CHAPTER = 2;

/**
 * Chapter (an index shared with `segmentChapterIndices`, e.g. the future
 * `BackboneSegment.chapterIndex` values) a themed spread at `gap` lands in.
 * Gap `g >= 0` sits right AFTER segment `g`, so it belongs to that segment's
 * chapter (a chapter opener is emitted just before ITS first segment, after
 * the previous gap's spread); gap `-1` sits before the first segment, i.e.
 * inside the first segment's chapter. Out-of-range gaps clamp. `0` when
 * there are no segments.
 */
export function chapterIndexOfGap(gap: number, segmentChapterIndices: readonly number[]): number {
  if (segmentChapterIndices.length === 0) return 0;
  const segmentIndex = Math.min(Math.max(gap, 0), segmentChapterIndices.length - 1);
  return segmentChapterIndices[segmentIndex];
}

export interface ChapterCapCandidate {
  id: string;
  memberCount: number;
  chapterIndex: number;
}

export interface ChapterCapResult {
  keptIds: string[];
  /** Spreads dissolved because their chapter already held `maxPerChapter`
   * higher-priority spreads. Sorted. Their members go back through
   * `reassignDissolvedSpreadMembers`. */
  dissolvedIds: string[];
}

/**
 * Keeps at most `maxPerChapter` themed spreads per chapter, dissolving the
 * lowest-priority ones. Priority is the same signal admission uses: member
 * count DESC, then id ASC. Pure; `keptIds` come back in that same global
 * priority order. Suggested use: apply to the survivors of `admitThemedSpreads`, mapping each
 * placed gap to its chapter with `chapterIndexOfGap` (the chapter actually
 * rendered), then dissolve the returned ids.
 */
export function capThemedSpreadsPerChapter(
  spreads: ChapterCapCandidate[],
  maxPerChapter: number = MAX_THEMED_SPREADS_PER_CHAPTER,
): ChapterCapResult {
  const ordered = [...spreads].sort((a, b) => b.memberCount - a.memberCount || a.id.localeCompare(b.id));
  const countByChapter = new Map<number, number>();
  const keptIds: string[] = [];
  const dissolvedIds: string[] = [];
  for (const spread of ordered) {
    const used = countByChapter.get(spread.chapterIndex) ?? 0;
    if (used < Math.max(0, maxPerChapter)) {
      countByChapter.set(spread.chapterIndex, used + 1);
      keptIds.push(spread.id);
    } else {
      dissolvedIds.push(spread.id);
    }
  }
  return { keptIds, dissolvedIds: dissolvedIds.sort() };
}
