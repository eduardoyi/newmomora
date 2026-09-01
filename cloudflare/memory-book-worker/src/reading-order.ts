/**
 * Single-placement resolution, undersized-spread dissolve, spacing, and
 * final reading-order assembly -- ported from
 * supabase/scripts/eval-memory-book-outline.ts (resolveSinglePlacement,
 * dissolveSmallThemedSpreads, dissolveThinBirthdaySpreads,
 * enforceThemedSpreadSpacing, buildReadingOrder). See eligibility.ts's
 * header comment for why this is a faithful duplicate rather than a
 * `_shared/` extraction.
 *
 * Deliberate V5a simplification (documented deviation -- see the worker's
 * README/implementation report): the eval CLI ALSO runs a page-budget-aware
 * themed-spread ADMISSION pass (`admitThemedSpreads`, round-16) driven by a
 * `book-renderer/src/model/fitter.ts` page-count oracle, and a seasonal
 * PACING re-anchor pass (`paceThemedSpreads`) before spacing. This module
 * intentionally does NOT port either: the eval CLI's own round-14 decision
 * record (search "round-14... A/B test" in that file) states plainly that
 * "FITTING those choices to a physical page count is the renderer's job
 * alone, at render time" -- which is exactly what book-renderer's fitter
 * does downstream (out of scope for V5a: no web preview/print rendering
 * here). Every themed spread that survives the minimum-size dissolve is
 * admitted, anchored at the AI's own `insertAfterSegmentIndex` (clamped),
 * with only the spacing pass applied so two spreads never render back to
 * back with nothing else between them.
 */
import type {
  Candidate,
  CandidateKind,
  ParsedFirstsWarmName,
  SpreadTitleMode,
} from '../../../supabase/functions/_shared/memory-book-outline.ts';
import type { BackboneSegment } from '../../../supabase/functions/_shared/memory-book-outline.ts';

export interface PlacementCandidate {
  memoryId: string;
  spreadId: string;
}

export interface SinglePlacementResult {
  placementByMemory: Map<string, string>;
  reassignments: Array<{ memoryId: string; droppedFrom: string[]; keptIn: string }>;
}

/**
 * A memory that is a candidate for more than one spread is kept in whichever
 * candidate spread has the FEWEST members (scarcity), using each spread's
 * INITIAL candidate size (not recomputed as memories get resolved
 * elsewhere). Ties break on spreadId for full determinism.
 */
export function resolveSinglePlacement(candidates: PlacementCandidate[]): SinglePlacementResult {
  const bySpread = new Map<string, Set<string>>();
  const byMemory = new Map<string, string[]>();

  for (const c of candidates) {
    if (!bySpread.has(c.spreadId)) bySpread.set(c.spreadId, new Set());
    bySpread.get(c.spreadId)!.add(c.memoryId);

    const list = byMemory.get(c.memoryId) ?? [];
    if (!list.includes(c.spreadId)) list.push(c.spreadId);
    byMemory.set(c.memoryId, list);
  }

  const initialCounts = new Map<string, number>();
  for (const [spreadId, members] of bySpread) initialCounts.set(spreadId, members.size);

  const placementByMemory = new Map<string, string>();
  const reassignments: SinglePlacementResult['reassignments'] = [];

  for (const [memoryId, spreadIds] of [...byMemory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (spreadIds.length === 1) {
      placementByMemory.set(memoryId, spreadIds[0]);
      continue;
    }

    const sorted = [...spreadIds].sort((a, b) => {
      const diff = (initialCounts.get(a) ?? 0) - (initialCounts.get(b) ?? 0);
      return diff !== 0 ? diff : a.localeCompare(b);
    });

    const keptIn = sorted[0];
    placementByMemory.set(memoryId, keptIn);
    reassignments.push({ memoryId, droppedFrom: spreadIds.filter((s) => s !== keptIn), keptIn });
  }

  return { placementByMemory, reassignments };
}

export interface DissolveResult {
  placementByMemory: Map<string, string>;
  dissolvedSpreadIds: string[];
  movedToBackbone: Array<{ memoryId: string; fromSpread: string; toSpread: string }>;
}

/** Themed spreads that fall below 3 memories after single-placement dissolve
 * back into the backbone -- every member returns to its own default
 * chronological segment, never dropped from the book. */
export function dissolveSmallThemedSpreads(
  placementByMemory: Map<string, string>,
  themedSpreadIds: Set<string>,
  defaultBackboneByMemory: Map<string, string>,
  minSize = 3,
): DissolveResult {
  const result = new Map(placementByMemory);
  const dissolvedSpreadIds: string[] = [];
  const movedToBackbone: DissolveResult['movedToBackbone'] = [];

  const countBySpread = new Map<string, number>();
  for (const spreadId of result.values()) {
    countBySpread.set(spreadId, (countBySpread.get(spreadId) ?? 0) + 1);
  }

  for (const spreadId of [...themedSpreadIds].sort()) {
    const count = countBySpread.get(spreadId) ?? 0;
    if (count > 0 && count < minSize) {
      dissolvedSpreadIds.push(spreadId);
      for (const [memoryId, placedIn] of [...result.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (placedIn !== spreadId) continue;
        const backboneId = defaultBackboneByMemory.get(memoryId);
        if (!backboneId) continue;
        result.set(memoryId, backboneId);
        movedToBackbone.push({ memoryId, fromSpread: spreadId, toSpread: backboneId });
      }
    }
  }

  return { placementByMemory: result, dissolvedSpreadIds, movedToBackbone };
}

export interface BirthdayDissolveResult {
  placementByMemory: Map<string, string>;
  dissolvedAges: number[];
  movedToBackbone: Array<{ memoryId: string; fromSpread: string; toSpread: string }>;
}

/** Same <3 threshold and mechanics as `dissolveSmallThemedSpreads`, for
 * birthday spreads specifically (a birthday spread that can't fill 2 pages
 * duplicates the beat its own specially-titled backbone month already
 * carries). */
export function dissolveThinBirthdaySpreads(
  placementByMemory: Map<string, string>,
  birthdaySpreadIds: Set<string>,
  defaultBackboneByMemory: Map<string, string>,
  minSize = 3,
): BirthdayDissolveResult {
  const result = new Map(placementByMemory);
  const dissolvedAges: number[] = [];
  const movedToBackbone: BirthdayDissolveResult['movedToBackbone'] = [];

  const countBySpread = new Map<string, number>();
  for (const spreadId of result.values()) {
    countBySpread.set(spreadId, (countBySpread.get(spreadId) ?? 0) + 1);
  }

  for (const spreadId of [...birthdaySpreadIds].sort()) {
    const count = countBySpread.get(spreadId) ?? 0;
    if (count > 0 && count < minSize) {
      dissolvedAges.push(Number(spreadId.slice('birthday-'.length)));
      for (const [memoryId, placedIn] of [...result.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (placedIn !== spreadId) continue;
        const backboneId = defaultBackboneByMemory.get(memoryId);
        if (!backboneId) continue;
        result.set(memoryId, backboneId);
        movedToBackbone.push({ memoryId, fromSpread: spreadId, toSpread: backboneId });
      }
    }
  }

  return { placementByMemory: result, dissolvedAges: dissolvedAges.sort((a, b) => a - b), movedToBackbone };
}

/**
 * Round-15 spacing rule: no two themed spreads may ever be adjacent -- at
 * most one per "gap" (`-1` = before the first backbone segment,
 * `0..lastValidIndex-1` = between two segments, `lastValidIndex` = after the
 * last). Priority for a contested gap is member count DESC then id ASC
 * (this outline carries no other per-spread ranking signal); the loser
 * spills to the nearest still-free gap in the WHOLE valid range (V5a keeps
 * the unbounded round-15 search rather than round-16's bounded spill --
 * see this file's header comment on the admission pass V5a omits).
 */
export function enforceThemedSpreadSpacing(
  spreads: Array<{ id: string; memberCount: number; anchorGap: number }>,
  lastValidIndex: number,
): Map<string, number> {
  const minGap = -1;
  const totalGaps = lastValidIndex - minGap + 1;

  const ordered = [...spreads].sort((a, b) => b.memberCount - a.memberCount || a.id.localeCompare(b.id));

  const taken = new Set<number>();
  const assignment = new Map<string, number>();

  for (const spread of ordered) {
    const anchor = Math.min(Math.max(spread.anchorGap, minGap), lastValidIndex);
    if (!taken.has(anchor)) {
      taken.add(anchor);
      assignment.set(spread.id, anchor);
      continue;
    }
    if (taken.size >= totalGaps) {
      assignment.set(spread.id, anchor);
      continue;
    }
    let best = anchor;
    let bestDist = Infinity;
    for (let gap = minGap; gap <= lastValidIndex; gap++) {
      if (taken.has(gap)) continue;
      const dist = Math.abs(gap - anchor);
      if (dist < bestDist) {
        best = gap;
        bestDist = dist;
      }
    }
    taken.add(best);
    assignment.set(spread.id, best);
  }

  return assignment;
}

export type ReadingOrderSectionKind =
  | 'cover' | 'title' | 'through-the-years' | 'firsts' | 'birthday' | 'themed' | 'backbone' | 'closing';

export const FIRSTS_DEFAULT_TITLE = 'Big and small victories this year';

export interface ReadingOrderSection {
  id: string;
  kind: ReadingOrderSectionKind;
  title: string;
  memoryIds: string[];
  rationale: Record<string, string>;
  spreadType?: CandidateKind;
  subtitle?: string;
  titleMode?: SpreadTitleMode;
  titleSourceMemoryId?: string | null;
  kicker?: string | null;
  highlights?: string[];
  firstsWarmNames?: ParsedFirstsWarmName[];
}

export interface ReadingOrderThemedSpreadInput {
  candidateId: string;
  candidateKind: CandidateKind;
  title: string;
  titleMode: SpreadTitleMode;
  titleSourceMemoryId: string | null;
  memoryIds: string[];
  insertAfterFinalSegmentIndex: number;
  rationale: Record<string, string>;
  kicker: string | null;
}

export interface ReadingOrderInput {
  childName: string;
  finalBackboneSegments: BackboneSegment[];
  firsts: { present: boolean; title: string | null; memoryIds: string[]; warmNames?: ParsedFirstsWarmName[] } | null;
  birthdaySpreads: Array<{ ageTurned: number; memoryIds: string[] }>;
  themedSpreads: ReadingOrderThemedSpreadInput[];
  backboneRationale: Record<string, string>;
  specialSegmentTitles?: Record<string, string>;
  highlightedMemoryIds?: ReadonlySet<string>;
}

export function buildReadingOrder(input: ReadingOrderInput): ReadingOrderSection[] {
  const sections: ReadingOrderSection[] = [];

  sections.push({ id: 'cover', kind: 'cover', title: 'Cover', memoryIds: [], rationale: {} });
  sections.push({ id: 'title', kind: 'title', title: 'Title & dedication', memoryIds: [], rationale: {} });
  sections.push({
    id: 'through-the-years',
    kind: 'through-the-years',
    title: `Through the years -- ${input.childName}`,
    memoryIds: [],
    rationale: {},
  });

  for (const spread of [...input.birthdaySpreads].sort((a, b) => a.ageTurned - b.ageTurned)) {
    sections.push({
      id: `birthday-${spread.ageTurned}`,
      kind: 'birthday',
      title: `Birthday -- turns ${spread.ageTurned}`,
      memoryIds: spread.memoryIds,
      rationale: {},
    });
  }

  const lastValidIndex = input.finalBackboneSegments.length - 1;

  const spacedGapByCandidateId = enforceThemedSpreadSpacing(
    input.themedSpreads.map((s) => ({ id: s.candidateId, memberCount: s.memoryIds.length, anchorGap: s.insertAfterFinalSegmentIndex })),
    lastValidIndex,
  );

  const themedByIndex = new Map<number, ReadingOrderThemedSpreadInput[]>();
  for (const spread of input.themedSpreads) {
    const gap = spacedGapByCandidateId.get(spread.candidateId) ?? -1;
    const list = themedByIndex.get(gap) ?? [];
    list.push(spread);
    themedByIndex.set(gap, list);
  }

  const pushThemedAt = (index: number) => {
    const group = (themedByIndex.get(index) ?? []).slice().sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    for (const spread of group) {
      sections.push({
        id: spread.candidateId,
        kind: 'themed',
        title: spread.title,
        memoryIds: spread.memoryIds,
        rationale: spread.rationale,
        spreadType: spread.candidateKind,
        titleMode: spread.titleMode,
        titleSourceMemoryId: spread.titleSourceMemoryId,
        kicker: spread.kicker,
      });
    }
  };

  const highlightedMemoryIds = input.highlightedMemoryIds ?? new Set<string>();

  pushThemedAt(-1);
  input.finalBackboneSegments.forEach((segment, index) => {
    const rationale: Record<string, string> = {};
    for (const id of segment.memoryIds) {
      if (input.backboneRationale[id]) rationale[id] = input.backboneRationale[id];
    }
    const specialTitle = input.specialSegmentTitles?.[segment.id];
    sections.push({
      id: `backbone:${segment.id}`,
      kind: 'backbone',
      title: specialTitle ?? segment.label,
      subtitle: specialTitle ? segment.label : undefined,
      memoryIds: segment.memoryIds,
      rationale,
      highlights: segment.memoryIds.filter((id) => highlightedMemoryIds.has(id)),
    });
    pushThemedAt(index);
  });

  if (input.firsts?.present) {
    sections.push({
      id: 'firsts',
      kind: 'firsts',
      title: input.firsts.title?.trim() || FIRSTS_DEFAULT_TITLE,
      memoryIds: input.firsts.memoryIds,
      rationale: {},
      firstsWarmNames: (input.firsts.warmNames ?? []).filter((w) => input.firsts!.memoryIds.includes(w.memoryId)),
    });
  }

  sections.push({ id: 'closing', kind: 'closing', title: 'Closing', memoryIds: [], rationale: {} });

  return sections;
}

/** Re-exported so downstream (workflow.ts) can build unified `Candidate[]`
 * without importing candidates.ts's `topicCandidatesToUnified` family for
 * this one type. */
export type { Candidate };
