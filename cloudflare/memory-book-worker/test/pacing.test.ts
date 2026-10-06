import { describe, expect, it } from 'vitest';
import { buildBackboneSegments } from '../src/backbone';
import {
  admitThemedSpreads,
  capThemedSpreadsPerChapter,
  chapterIndexOfGap,
  computeMedianDate,
  computeRequiredPacingGaps,
  computeThemedSpreadBudget,
  findAnchorSegmentIndex,
  isTimeAnchoredCandidate,
  MAX_THEMED_SPREADS_PER_CHAPTER,
  paceThemedSpreads,
  reassignDissolvedSpreadMembers,
  SPREAD_BUDGET_PAGES_PER_SPREAD,
  SPREAD_SPILL_BOUND,
  type PacingCandidate,
} from '../src/pacing';

function backboneInput(id: string, date: string) {
  return { id, date, printable: true };
}

// ── computeMedianDate + findAnchorSegmentIndex (ported) ────────────────────

describe('computeMedianDate', () => {
  it('lower median of an odd-length list', () => {
    expect(computeMedianDate(['2023-03-01', '2023-01-01', '2023-02-01'])).toBe('2023-02-01');
  });
  it('lower median of an even-length list', () => {
    expect(computeMedianDate(['2023-01-01', '2023-02-01', '2023-03-01', '2023-04-01'])).toBe('2023-02-01');
  });
  it('throws on an empty list', () => {
    expect(() => computeMedianDate([])).toThrow();
  });
});

describe('findAnchorSegmentIndex', () => {
  it('finds the last segment whose last month is <= the anchor', () => {
    const segments = buildBackboneSegments([
      backboneInput('a', '2023-01-05'),
      backboneInput('b', '2023-01-10'),
      backboneInput('c', '2023-01-15'),
      backboneInput('d', '2023-06-05'),
      backboneInput('e', '2023-06-10'),
      backboneInput('f', '2023-06-15'),
    ]);
    expect(segments).toHaveLength(2);
    expect(findAnchorSegmentIndex('2023-03', segments)).toBe(0);
    expect(findAnchorSegmentIndex('2023-06', segments)).toBe(1);
    expect(findAnchorSegmentIndex('2022-12', segments)).toBe(-1);
  });
  it('is -1 with no segments', () => {
    expect(findAnchorSegmentIndex('2023-03', [])).toBe(-1);
  });
});

// ── Pacing (ported) ────────────────────────────────────────────────────────

describe('computeRequiredPacingGaps', () => {
  it('no gaps needed for <=2 segments', () => {
    expect(computeRequiredPacingGaps(0)).toEqual([]);
    expect(computeRequiredPacingGaps(1)).toEqual([]);
    expect(computeRequiredPacingGaps(2)).toEqual([]);
  });
  it('one required gap for 3 or 4 segments', () => {
    expect(computeRequiredPacingGaps(3)).toEqual([1]);
    expect(computeRequiredPacingGaps(4)).toEqual([1]);
  });
  it('scales for larger segment counts', () => {
    expect(computeRequiredPacingGaps(7)).toEqual([1, 3, 5]);
  });
});

function pacingCandidate(id: string, idealGapIndex: number): PacingCandidate {
  return { id, idealGapIndex };
}

describe('paceThemedSpreads', () => {
  it('already-paced input is left unchanged', () => {
    const result = paceThemedSpreads(4, [pacingCandidate('s1', 1), pacingCandidate('s2', -1)]);
    expect(result.get('s1')).toBe(1);
    expect(result.get('s2')).toBe(-1);
  });

  it('relocates a free spread to break up a long run', () => {
    const result = paceThemedSpreads(7, [pacingCandidate('s1', -1), pacingCandidate('s2', -1)]);
    const positions = [...result.values()].sort((a, b) => a - b);
    expect(positions.some((p) => p === 1 || p === 3 || p === 5)).toBe(true);
  });

  it('zero candidates is a no-op', () => {
    expect(paceThemedSpreads(7, []).size).toBe(0);
  });

  it('scarcity -- fewer free spreads than required gaps leaves some unfilled without crashing', () => {
    const result = paceThemedSpreads(7, [pacingCandidate('only', -1)]);
    expect(result.get('only')).toBe(1);
    expect(result.size).toBe(1);
  });

  it('prefers the candidate whose ideal gap is closest to the target', () => {
    const result = paceThemedSpreads(4, [pacingCandidate('near', 2), pacingCandidate('far', -1)]);
    expect(result.get('near')).toBe(1);
    expect(result.get('far')).toBe(-1);
  });

  it('surplus spreads at a satisfied required gap can be relocated to help elsewhere', () => {
    const result = paceThemedSpreads(7, [pacingCandidate('a', 1), pacingCandidate('b', 1)]);
    expect([result.get('a'), result.get('b')].sort()).toEqual([1, 3]);
  });

  it('an anchored spread is never relocated, even under scarcity', () => {
    const anchored: PacingCandidate = { id: 'topic:newborn-days', idealGapIndex: -1, anchored: true };
    expect(paceThemedSpreads(7, [anchored]).get('topic:newborn-days')).toBe(-1);
  });

  it('an anchored spread still counts toward gap coverage if it sits on one', () => {
    const anchored: PacingCandidate = { id: 'anchored', idealGapIndex: 1, anchored: true };
    const result = paceThemedSpreads(4, [anchored, pacingCandidate('free', -1)]);
    expect(result.get('anchored')).toBe(1);
    expect(result.get('free')).toBe(-1);
  });

  it('is deterministic: same input, same assignment, regardless of candidate order', () => {
    const candidates = [pacingCandidate('b', 0), pacingCandidate('a', 0), pacingCandidate('c', 6), pacingCandidate('d', 6)];
    const first = paceThemedSpreads(9, candidates);
    const second = paceThemedSpreads(9, [...candidates].reverse());
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
    expect([...paceThemedSpreads(9, candidates).entries()]).toEqual([...first.entries()]);
  });
});

describe('isTimeAnchoredCandidate', () => {
  it('newborn-days and date-gated seasonal topics are anchored', () => {
    for (const id of [
      'newborn-days', 'christmas', 'halloween', 'thanksgiving', 'easter', 'valentines', 'new-year',
      'lunar-new-year', 'hanukkah', 'eid', 'diwali', 'dia-de-muertos', 'mothers-fathers-day',
    ]) {
      expect(isTimeAnchoredCandidate(`topic:${id}`)).toBe(true);
    }
  });
  it('a non-seasonal topic, people-pair, or emotion candidate is NOT anchored', () => {
    expect(isTimeAnchoredCandidate('topic:beach')).toBe(false);
    expect(isTimeAnchoredCandidate('people:some-member-id')).toBe(false);
    expect(isTimeAnchoredCandidate('emotion:funny')).toBe(false);
  });
});

// ── Budget + admission (ported) ────────────────────────────────────────────

describe('computeThemedSpreadBudget', () => {
  it('a full 122-page book budgets 8 spreads', () => {
    expect(SPREAD_BUDGET_PAGES_PER_SPREAD).toBe(15);
    expect(computeThemedSpreadBudget(122, 122)).toBe(8);
  });
  it('caps the input at pageCap first', () => {
    expect(computeThemedSpreadBudget(300, 122)).toBe(8);
  });
  it('a smaller book budgets proportionally fewer spreads', () => {
    expect(computeThemedSpreadBudget(40, 122)).toBe(2);
    expect(computeThemedSpreadBudget(14, 122)).toBe(0);
  });
  it('never negative for a degenerate estimate', () => {
    expect(computeThemedSpreadBudget(-50, 122)).toBe(0);
    expect(computeThemedSpreadBudget(0, 122)).toBe(0);
  });
});

function admissionSpread(id: string, anchorGap: number, memberCount = 1) {
  return { id, anchorGap, memberCount };
}

describe('admitThemedSpreads', () => {
  it('a no-op when every spread already has its own gap and fits the budget', () => {
    const { placedGapById, dissolvedIds } = admitThemedSpreads(
      [admissionSpread('a', 0), admissionSpread('b', 2), admissionSpread('c', 5)], 10, 10,
    );
    expect(placedGapById.get('a')).toBe(0);
    expect(placedGapById.get('b')).toBe(2);
    expect(placedGapById.get('c')).toBe(5);
    expect(dissolvedIds).toEqual([]);
  });

  it('rule (b): spreads beyond the budget dissolve, lowest priority first (member count desc, then id asc)', () => {
    const { placedGapById, dissolvedIds } = admitThemedSpreads(
      [admissionSpread('big', 0, 10), admissionSpread('mid', 1, 5), admissionSpread('small', 2, 1)], 10, 2,
    );
    expect([...placedGapById.keys()].sort()).toEqual(['big', 'mid']);
    expect(dissolvedIds).toEqual(['small']);
  });

  it('rule (a): a spread exactly at the spill bound distance is placeable (earlier gap wins the tie)', () => {
    const { placedGapById, dissolvedIds } = admitThemedSpreads(
      [
        admissionSpread('winner', 5, 10),
        admissionSpread('filler4', 4, 9),
        admissionSpread('filler6', 6, 8),
        admissionSpread('contender', 5, 1),
      ],
      10,
      4,
    );
    expect(placedGapById.get('winner')).toBe(5);
    expect(placedGapById.get('filler4')).toBe(4);
    expect(placedGapById.get('filler6')).toBe(6);
    expect(placedGapById.get('contender')).toBe(5 - SPREAD_SPILL_BOUND);
    expect(dissolvedIds).toEqual([]);
  });

  it('rule (a) boundary: one gap beyond the spill bound is unplaceable and DISSOLVES', () => {
    const { placedGapById, dissolvedIds } = admitThemedSpreads(
      [
        admissionSpread('g3', 3, 10),
        admissionSpread('g4', 4, 10),
        admissionSpread('g5', 5, 10),
        admissionSpread('g6', 6, 10),
        admissionSpread('g7', 7, 10),
        admissionSpread('contender', 5, 1),
      ],
      10,
      6,
    );
    expect(dissolvedIds).toEqual(['contender']);
    expect(placedGapById.has('contender')).toBe(false);
    const allGaps = [...placedGapById.values()];
    expect(new Set(allGaps).size).toBe(allGaps.length);
  });

  it('real Tomás shape: 12 candidates over 9 segments, budget 8 -> survivors within the spill bound, none adjacent-sharing', () => {
    const spreads = [
      admissionSpread('bikes-scooters', 0, 4),
      admissionSpread('funny', 1, 6),
      admissionSpread('people-a', 2, 6),
      admissionSpread('treats', 3, 5),
      admissionSpread('eating-out', 6, 4),
      admissionSpread('toys-building', 6, 5),
      admissionSpread('tender', 7, 6),
      admissionSpread('people-b', 7, 6),
      admissionSpread('people-c', 7, 6),
      admissionSpread('travel', 7, 3),
      admissionSpread('days-out', 8, 5),
      admissionSpread('extra-thin', 8, 2),
    ];
    const budget = computeThemedSpreadBudget(122, 122);
    const { placedGapById, dissolvedIds } = admitThemedSpreads(spreads, 8, budget);
    expect(placedGapById.size <= budget).toBe(true);
    expect(placedGapById.size + dissolvedIds.length).toBe(spreads.length);
    const anchorById = new Map(spreads.map((s) => [s.id, s.anchorGap]));
    for (const [id, gap] of placedGapById) {
      expect(Math.abs(gap - anchorById.get(id)!) <= SPREAD_SPILL_BOUND).toBe(true);
    }
    const allGaps = [...placedGapById.values()];
    expect(new Set(allGaps).size).toBe(allGaps.length);
    expect(dissolvedIds).toContain('extra-thin');
    expect(dissolvedIds.length > spreads.length - budget).toBe(true);
  });

  it('is deterministic regardless of input order', () => {
    const spreads = [
      admissionSpread('a', 3, 5), admissionSpread('b', 3, 5), admissionSpread('c', 3, 4), admissionSpread('d', 4, 9),
    ];
    const one = admitThemedSpreads(spreads, 10, 3);
    const two = admitThemedSpreads([...spreads].reverse(), 10, 3);
    expect([...one.placedGapById.entries()].sort()).toEqual([...two.placedGapById.entries()].sort());
    expect(one.dissolvedIds).toEqual(two.dissolvedIds);
  });

  it('a zero budget dissolves everything', () => {
    const { placedGapById, dissolvedIds } = admitThemedSpreads([admissionSpread('a', 1), admissionSpread('b', 2)], 5, 0);
    expect(placedGapById.size).toBe(0);
    expect(dissolvedIds).toEqual(['a', 'b']);
  });
});

// ── reassignDissolvedSpreadMembers (ported) ────────────────────────────────

describe('admitThemedSpreads — gapRange (chapter-clamped placement)', () => {
  it('clamps the anchor into the range and keeps the spill search inside it', () => {
    // Chapter owns gaps 4..6. Anchor 1 clamps to 4; a second spread anchored at 4 spills to 5 (never 3).
    const out = admitThemedSpreads(
      [
        { id: 'a', memberCount: 9, anchorGap: 1, gapRange: { min: 4, max: 6 } },
        { id: 'b', memberCount: 8, anchorGap: 4, gapRange: { min: 4, max: 6 } },
      ],
      10,
      8,
    );
    expect(out.placedGapById.get('a')).toBe(4);
    expect(out.placedGapById.get('b')).toBe(5);
    expect(out.dissolvedIds).toEqual([]);
  });

  it('dissolves a spread with no free gap left inside its range (never spills out of the chapter)', () => {
    const out = admitThemedSpreads(
      [
        { id: 'a', memberCount: 9, anchorGap: 4, gapRange: { min: 4, max: 4 } },
        { id: 'b', memberCount: 8, anchorGap: 4, gapRange: { min: 4, max: 4 } },
      ],
      10,
      8,
    );
    expect([...out.placedGapById.keys()]).toEqual(['a']);
    expect(out.dissolvedIds).toEqual(['b']);
  });

  it('an empty range dissolves; no range behaves as before', () => {
    const out = admitThemedSpreads([{ id: 'a', memberCount: 3, anchorGap: 2, gapRange: { min: 0, max: -1 } }, { id: 'b', memberCount: 3, anchorGap: 2 }], 10, 8);
    expect(out.dissolvedIds).toEqual(['a']);
    expect(out.placedGapById.get('b')).toBe(2);
  });
});

describe('reassignDissolvedSpreadMembers', () => {
  it("routes a dissolved spread's members to their own default backbone segment", () => {
    const placement = new Map([
      ['m1', 'spread:travel'],
      ['m2', 'spread:travel'],
      ['m3', 'backbone:2025-08'],
    ]);
    const dissolved = new Map([['spread:travel', ['m1', 'm2']]]);
    const defaultBackbone = new Map([
      ['m1', 'backbone:2025-08'],
      ['m2', 'backbone:2025-09'],
    ]);
    const result = reassignDissolvedSpreadMembers(placement, dissolved, defaultBackbone);
    expect(result.get('m1')).toBe('backbone:2025-08');
    expect(result.get('m2')).toBe('backbone:2025-09');
    expect(result.get('m3')).toBe('backbone:2025-08');
  });

  it('ZERO memories are ever lost -- the key set is identical before and after', () => {
    const placement = new Map([
      ['m1', 'spread:travel'],
      ['m2', 'spread:tender'],
      ['m3', 'backbone:2025-08'],
      ['m4', 'firsts'],
    ]);
    const dissolved = new Map([
      ['spread:travel', ['m1']],
      ['spread:tender', ['m2']],
    ]);
    const defaultBackbone = new Map([
      ['m1', 'backbone:2025-08'],
      ['m2', 'backbone:2025-09'],
    ]);
    const result = reassignDissolvedSpreadMembers(placement, dissolved, defaultBackbone);
    expect(new Set(result.keys())).toEqual(new Set(placement.keys()));
    expect(result.size).toBe(placement.size);
  });

  it('a memory with no default-backbone entry is left at its current placement', () => {
    const result = reassignDissolvedSpreadMembers(
      new Map([['m1', 'spread:travel']]),
      new Map([['spread:travel', ['m1']]]),
      new Map(),
    );
    expect(result.get('m1')).toBe('spread:travel');
  });

  it('does not mutate its inputs', () => {
    const placement = new Map([['m1', 'spread:x']]);
    reassignDissolvedSpreadMembers(placement, new Map([['spread:x', ['m1']]]), new Map([['m1', 'backbone:a']]));
    expect(placement.get('m1')).toBe('spread:x');
  });
});

// ── Per-chapter cap (new) ──────────────────────────────────────────────────

describe('chapterIndexOfGap', () => {
  // 6 segments across 3 chapters: [0,0,1,1,2,2]
  const chapters = [0, 0, 1, 1, 2, 2];
  it('gap g sits after segment g, so it takes that segment\'s chapter (never the next chapter\'s)', () => {
    expect(chapterIndexOfGap(1, chapters)).toBe(0); // after the last segment of chapter 0
    expect(chapterIndexOfGap(2, chapters)).toBe(1);
    expect(chapterIndexOfGap(5, chapters)).toBe(2);
  });
  it('gap -1 belongs to the first segment\'s chapter; out-of-range gaps clamp', () => {
    expect(chapterIndexOfGap(-1, chapters)).toBe(0);
    expect(chapterIndexOfGap(99, chapters)).toBe(2);
    expect(chapterIndexOfGap(0, [])).toBe(0);
  });
});

describe('capThemedSpreadsPerChapter', () => {
  it('defaults to 2 per chapter and dissolves the lowest-priority spread(s)', () => {
    expect(MAX_THEMED_SPREADS_PER_CHAPTER).toBe(2);
    const { keptIds, dissolvedIds } = capThemedSpreadsPerChapter([
      { id: 'a', memberCount: 9, chapterIndex: 0 },
      { id: 'b', memberCount: 7, chapterIndex: 0 },
      { id: 'c', memberCount: 4, chapterIndex: 0 },
      { id: 'd', memberCount: 3, chapterIndex: 1 },
    ]);
    expect(keptIds).toEqual(['a', 'b', 'd']);
    expect(dissolvedIds).toEqual(['c']);
  });

  it('ties break on id ascending (higher id dissolves)', () => {
    const { keptIds, dissolvedIds } = capThemedSpreadsPerChapter([
      { id: 'z', memberCount: 5, chapterIndex: 0 },
      { id: 'y', memberCount: 5, chapterIndex: 0 },
      { id: 'x', memberCount: 5, chapterIndex: 0 },
    ]);
    expect(keptIds).toEqual(['x', 'y']);
    expect(dissolvedIds).toEqual(['z']);
  });

  it('counts chapters independently and is a no-op when every chapter is within the cap', () => {
    const input = [
      { id: 'a', memberCount: 5, chapterIndex: 0 },
      { id: 'b', memberCount: 5, chapterIndex: 0 },
      { id: 'c', memberCount: 5, chapterIndex: 1 },
      { id: 'd', memberCount: 5, chapterIndex: 1 },
    ];
    const { keptIds, dissolvedIds } = capThemedSpreadsPerChapter(input);
    expect(keptIds.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(dissolvedIds).toEqual([]);
  });

  it('honours a custom cap, including 0, and is order-independent', () => {
    const input = [
      { id: 'a', memberCount: 5, chapterIndex: 0 },
      { id: 'b', memberCount: 6, chapterIndex: 0 },
    ];
    expect(capThemedSpreadsPerChapter(input, 1).keptIds).toEqual(['b']);
    expect(capThemedSpreadsPerChapter([...input].reverse(), 1).keptIds).toEqual(['b']);
    expect(capThemedSpreadsPerChapter(input, 0).dissolvedIds).toEqual(['a', 'b']);
  });

  it('end to end: 12 candidates over a 5-chapter backbone -> <=8 admitted, none adjacent, <=2 per chapter', () => {
    // 15 segments, 3 per chapter.
    const segmentChapterIndices = Array.from({ length: 15 }, (_, i) => Math.floor(i / 3));
    const spreads = Array.from({ length: 12 }, (_, i) => ({
      id: `s${String(i).padStart(2, '0')}`,
      memberCount: 3 + (i % 5),
      anchorGap: Math.min(14, i < 6 ? 1 + i : 7 + (i - 6)), // dense in the first half
    }));
    const budget = computeThemedSpreadBudget(122, 122);
    const admitted = admitThemedSpreads(spreads, 14, budget);
    const cap = capThemedSpreadsPerChapter(
      [...admitted.placedGapById].map(([id, gap]) => ({
        id,
        memberCount: spreads.find((s) => s.id === id)!.memberCount,
        chapterIndex: chapterIndexOfGap(gap, segmentChapterIndices),
      })),
    );
    expect(cap.keptIds.length).toBeLessThanOrEqual(8);
    const gaps = cap.keptIds.map((id) => admitted.placedGapById.get(id)!).sort((a, b) => a - b);
    expect(new Set(gaps).size).toBe(gaps.length); // one spread per gap => never adjacent
    const perChapter = new Map<number, number>();
    for (const gap of gaps) {
      const c = chapterIndexOfGap(gap, segmentChapterIndices);
      perChapter.set(c, (perChapter.get(c) ?? 0) + 1);
    }
    for (const count of perChapter.values()) expect(count).toBeLessThanOrEqual(2);
  });
});
