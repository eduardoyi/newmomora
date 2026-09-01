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
