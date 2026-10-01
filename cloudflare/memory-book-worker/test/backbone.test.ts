import { describe, expect, it } from 'vitest';
import {
  buildBackboneSegments,
  buildSpecialSegmentTitlesByMonth,
  computeAgeYearBirthdayMonths,
  flagSpecialBackboneSegments,
  formatMonthRangeLabel,
  suppressSurvivingBirthdaySpecialTitles,
} from '../src/backbone';

describe('buildBackboneSegments', () => {
  it('merges consecutive months forward until the printable threshold is met, folding a trailing sparse tail into the last flushed segment', () => {
    const memories = [
      { id: 'a', date: '2025-01-05', printable: true },
      { id: 'b', date: '2025-02-05', printable: true },
      { id: 'c', date: '2025-03-05', printable: true },
      { id: 'd', date: '2025-04-05', printable: true },
    ];
    const segments = buildBackboneSegments(memories, 3);
    // Jan-Mar flush as one segment (3 printable reached); the trailing April
    // month never reaches 3 on its own, so it folds into that segment too.
    expect(segments).toHaveLength(1);
    expect(segments[0].monthKeys).toEqual(['2025-01', '2025-02', '2025-03', '2025-04']);
    expect(segments[0].memoryIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('flushes a second segment once a later month batch reaches the threshold on its own', () => {
    const memories = [
      { id: 'a', date: '2025-01-05', printable: true },
      { id: 'b', date: '2025-02-05', printable: true },
      { id: 'c', date: '2025-03-05', printable: true },
      { id: 'd', date: '2025-04-05', printable: true },
      { id: 'e', date: '2025-04-06', printable: true },
      { id: 'f', date: '2025-04-07', printable: true },
    ];
    const segments = buildBackboneSegments(memories, 3);
    expect(segments).toHaveLength(2);
    expect(segments[0].monthKeys).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(segments[1].monthKeys).toEqual(['2025-04']);
    expect(segments[1].memoryIds).toEqual(['d', 'e', 'f']);
  });

  it('folds a lone trailing sparse segment into the previous one when it exists', () => {
    const memories = [
      { id: 'a', date: '2025-01-05', printable: true },
      { id: 'b', date: '2025-01-06', printable: true },
      { id: 'c', date: '2025-01-07', printable: true },
      { id: 'd', date: '2025-02-05', printable: true },
    ];
    const segments = buildBackboneSegments(memories, 3);
    expect(segments).toHaveLength(1);
    expect(segments[0].monthKeys).toEqual(['2025-01', '2025-02']);
  });

  it('keeps a single small segment when the whole scope never reaches the threshold', () => {
    const memories = [{ id: 'a', date: '2025-01-05', printable: true }];
    const segments = buildBackboneSegments(memories, 3);
    expect(segments).toHaveLength(1);
    expect(segments[0].memoryIds).toEqual(['a']);
  });
});

describe('buildBackboneSegments — quarter cap and chapter options (Everything)', () => {
  const capped = { maxSpanMonths: 3 };
  const spanOf = (monthKeys: string[]) => {
    const ord = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7));
    return ord(monthKeys[monthKeys.length - 1]) - ord(monthKeys[0]) + 1;
  };

  it('without options is identical to the legacy call (defaults reproduce today)', () => {
    const memories = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'].map((m, i) => ({ id: `m${i}`, date: `${m}-05`, printable: i === 5 }));
    expect(buildBackboneSegments(memories, 3, {})).toEqual(buildBackboneSegments(memories, 3));
    expect(buildBackboneSegments(memories, 3)[0].monthKeys).toHaveLength(6);
    expect(buildBackboneSegments(memories, 3)[0]).not.toHaveProperty('chapterIndex');
  });

  it('caps a segment at 3 calendar months even when it holds fewer than the printable minimum (the cap wins)', () => {
    // One printable memory per month: the legacy loop would merge Jan-Jun into one 6-month section.
    const memories = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'].map((m, i) => ({ id: `m${i}`, date: `${m}-05`, printable: true }));
    const segments = buildBackboneSegments(memories, 4, capped);
    expect(segments.map((s) => s.monthKeys)).toEqual([
      ['2025-01', '2025-02', '2025-03'],
      ['2025-04', '2025-05', '2025-06'],
    ]);
  });

  it('counts empty months toward the span: Jan + Aug never merge', () => {
    const memories = [
      { id: 'a', date: '2025-01-05', printable: true },
      { id: 'b', date: '2025-08-05', printable: true },
      { id: 'c', date: '2025-08-06', printable: true },
      { id: 'd', date: '2025-08-07', printable: true },
    ];
    const segments = buildBackboneSegments(memories, 3, capped);
    expect(segments.map((s) => s.monthKeys)).toEqual([['2025-01'], ['2025-08']]);
    expect(segments[0].memoryIds).toEqual(['a']);
  });

  it('a gap month inside the window counts: Jan + Mar merge (span 3) but Jan + Apr do not', () => {
    const mk = (months: string[]) => months.map((m, i) => ({ id: `m${i}`, date: `${m}-05`, printable: true }));
    expect(buildBackboneSegments(mk(['2025-01', '2025-03']), 3, capped).map((s) => s.monthKeys)).toEqual([['2025-01', '2025-03']]);
    expect(buildBackboneSegments(mk(['2025-01', '2025-04']), 3, capped).map((s) => s.monthKeys)).toEqual([['2025-01'], ['2025-04']]);
  });

  it('never folds a sparse trailing tail past the cap: it becomes its own segment', () => {
    const memories = [
      { id: 'a', date: '2025-01-05', printable: true },
      { id: 'b', date: '2025-02-05', printable: true },
      { id: 'c', date: '2025-03-05', printable: true },
      { id: 'd', date: '2025-04-05', printable: true },
    ];
    const segments = buildBackboneSegments(memories, 3, capped);
    // Legacy folds April into Jan-Mar (4 months); the cap keeps April alone.
    expect(segments.map((s) => s.monthKeys)).toEqual([['2025-01', '2025-02', '2025-03'], ['2025-04']]);
  });

  it('still folds a tail that stays within the cap', () => {
    const memories = [
      { id: 'a', date: '2025-01-05', printable: true },
      { id: 'b', date: '2025-01-06', printable: true },
      { id: 'c', date: '2025-01-07', printable: true },
      { id: 'd', date: '2025-02-05', printable: true },
    ];
    expect(buildBackboneSegments(memories, 3, capped).map((s) => s.monthKeys)).toEqual([['2025-01', '2025-02']]);
  });

  it('never crosses a chapter boundary, tags chapterIndex, and folds the tail only inside its own chapter', () => {
    // Chapter 0 = through 2025-02, chapter 1 = from 2025-03.
    const chapterOfMonth = (m: string) => (m <= '2025-02' ? 0 : 1);
    const memories = [
      { id: 'a', date: '2025-01-05', printable: true },
      { id: 'b', date: '2025-02-05', printable: true },
      { id: 'c', date: '2025-03-05', printable: true },
      { id: 'd', date: '2025-04-05', printable: true },
    ];
    const segments = buildBackboneSegments(memories, 3, { maxSpanMonths: 3, chapterOfMonth });
    expect(segments.map((s) => [s.monthKeys, s.chapterIndex])).toEqual([
      [['2025-01', '2025-02'], 0],
      [['2025-03', '2025-04'], 1],
    ]);
  });

  it('an Everything-shaped input (4 years, ~1 printable memory per month) has no section longer than a quarter and none crossing a chapter', () => {
    const memories: Array<{ id: string; date: string; printable: boolean }> = [];
    for (let i = 0; i < 48; i++) {
      const y = 2022 + Math.floor((9 + i) / 12);
      const m = ((9 + i) % 12) + 1;
      memories.push({ id: `m${i}`, date: `${y}-${String(m).padStart(2, '0')}-10`, printable: true });
    }
    // Birthday-month-closed chapters for DOB 2022-10-23.
    const chapterOfMonth = (m: string) => Math.max(0, Math.floor((Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 - (2022 * 12 + 9) - 1) / 12));
    const segments = buildBackboneSegments(memories, 3, { maxSpanMonths: 3, chapterOfMonth });
    for (const segment of segments) {
      expect(spanOf(segment.monthKeys)).toBeLessThanOrEqual(3);
      expect(new Set(segment.monthKeys.map(chapterOfMonth)).size).toBe(1);
      expect(segment.chapterIndex).toBe(chapterOfMonth(segment.monthKeys[0]));
      expect(segment.monthKeys.length).toBeLessThanOrEqual(3);
    }
    expect(segments.map((s) => s.memoryIds.length).reduce((a, b) => a + b, 0)).toBe(48);
  });
});

describe('formatMonthRangeLabel', () => {
  it('formats a single month, a same-year range, and a cross-year range', () => {
    expect(formatMonthRangeLabel(['2025-01'])).toBe('January 2025');
    expect(formatMonthRangeLabel(['2025-01', '2025-03'])).toBe('January–March 2025');
    expect(formatMonthRangeLabel(['2024-11', '2025-01'])).toBe('November 2024 – January 2025');
  });
});

describe('computeAgeYearBirthdayMonths', () => {
  it('flags the window start (age N-1) and window end (age N) for an age-year scope', () => {
    const map = computeAgeYearBirthdayMonths(true, 1, '2024-10-23', '2025-10-23');
    // Age 0 (ageYear - 1 === 0) is omitted -- the birth flag covers it instead.
    expect(map.has('2024-10')).toBe(false);
    expect(map.get('2025-10')).toBe(1);
  });

  it('flags both boundaries for age-year 2', () => {
    const map = computeAgeYearBirthdayMonths(true, 2, '2025-10-23', '2026-10-23');
    expect(map.get('2025-10')).toBe(1);
    expect(map.get('2026-10')).toBe(2);
  });

  it('is empty for a non age-year scope', () => {
    expect(computeAgeYearBirthdayMonths(false, 1, '2024-10-23', '2025-10-23').size).toBe(0);
  });
});

describe('flagSpecialBackboneSegments + suppression', () => {
  it('flags birth over birthday when both would apply to the same month, and flags every month independently', () => {
    const segments = [
      { id: 's1', label: 'Oct 2024', monthKeys: ['2024-10'], memoryIds: [] },
      { id: 's2', label: 'Oct 2025', monthKeys: ['2025-10'], memoryIds: [] },
    ];
    const flags = flagSpecialBackboneSegments(segments, '2024-10', new Map([['2025-10', 1]]));
    expect(flags).toEqual([
      { segmentId: 's1', month: '2024-10', kind: 'birth' },
      { segmentId: 's2', month: '2025-10', kind: 'birthday', ageTurned: 1 },
    ]);
  });

  it('suppresses a birthday flag whose spread survived on its own, never a birth flag', () => {
    const flags = [
      { segmentId: 's1', month: '2024-10', kind: 'birth' as const },
      { segmentId: 's2', month: '2025-10', kind: 'birthday' as const, ageTurned: 1 },
    ];
    const result = suppressSurvivingBirthdaySpecialTitles(flags, new Set([1]));
    expect(result).toEqual([{ segmentId: 's1', month: '2024-10', kind: 'birth' }]);
  });
});

describe('buildSpecialSegmentTitlesByMonth', () => {
  it('bridges the AI response (keyed by original segment id) to a month-keyed map', () => {
    const flags = [{ segmentId: 's1', month: '2024-10', kind: 'birth' as const }];
    const titles = buildSpecialSegmentTitlesByMonth(flags, { s1: 'Welcome to the world' });
    expect(titles.get('2024-10')).toBe('Welcome to the world');
  });

  it('ignores a blank or missing title', () => {
    const flags = [{ segmentId: 's1', month: '2024-10', kind: 'birth' as const }];
    expect(buildSpecialSegmentTitlesByMonth(flags, {}).size).toBe(0);
    expect(buildSpecialSegmentTitlesByMonth(flags, { s1: '   ' }).size).toBe(0);
  });
});
