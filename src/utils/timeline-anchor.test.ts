import {
  buildMonthCounts,
  formatTimelineMonthLabel,
  getAnchoredNextPageParam,
  getAnchoredPreviousPageParam,
  getMonthAnchorDate,
  getTimelineMonthOptions,
  trimAnchoredPagesToAnchor,
} from '@/utils/timeline-anchor';
import type { MemoriesPage } from '@/services/memories';

const cursor = (memoryDate: string, createdAt = `${memoryDate}T00:00:00Z`) => ({ memoryDate, createdAt });
const page = (overrides: Partial<MemoriesPage> = {}): MemoriesPage => ({
  memories: [],
  nextCursor: null,
  ...overrides,
});

describe('anchored page params', () => {
  it('continues older from a page with rows via its nextCursor', () => {
    expect(getAnchoredNextPageParam(page({ nextCursor: cursor('2025-03-01') }), { dir: 'anchor' }))
      .toEqual({ dir: 'older', cursor: cursor('2025-03-01') });
  });

  it('stops at the oldest page', () => {
    expect(getAnchoredNextPageParam(page(), { dir: 'older', cursor: cursor('2025-01-01') })).toBeUndefined();
  });

  it('resumes from an EMPTY newer page\'s own cursor, inclusive, so a refetch replay never truncates', () => {
    expect(getAnchoredNextPageParam(page(), { dir: 'newer', cursor: cursor('2025-03-20') }))
      .toEqual({ dir: 'older', cursor: cursor('2025-03-20'), inclusive: true });
  });

  it('pages newer only while the first page carries a prevCursor', () => {
    expect(getAnchoredPreviousPageParam(page({ prevCursor: cursor('2025-03-20') })))
      .toEqual({ dir: 'newer', cursor: cursor('2025-03-20') });
    expect(getAnchoredPreviousPageParam(page({ prevCursor: null }))).toBeUndefined();
    expect(getAnchoredPreviousPageParam(page())).toBeUndefined();
  });

  it('trims to the anchor page, wherever it sits, with its param reset', () => {
    const anchor = page({ nextCursor: cursor('2025-03-01') });
    const trimmed = trimAnchoredPagesToAnchor({
      pages: [page(), anchor, page()],
      pageParams: [
        { dir: 'newer', cursor: cursor('2025-03-20') },
        { dir: 'anchor' },
        { dir: 'older', cursor: cursor('2025-03-01') },
      ],
    });
    expect(trimmed).toEqual({ pages: [anchor], pageParams: [{ dir: 'anchor' }] });
  });

  it('leaves data without an anchor page untouched', () => {
    const data = { pages: [page()], pageParams: [null] };
    expect(trimAnchoredPagesToAnchor(data)).toBe(data);
    expect(trimAnchoredPagesToAnchor(undefined)).toBeUndefined();
  });
});

describe('month picker', () => {
  const september2026 = new Date(2026, 8, 28);

  it('counts memories per month, skipping blocked authors', () => {
    const counts = buildMonthCounts(
      [
        { memory_date: '2026-09-02', user_id: 'a' },
        { memory_date: '2026-09-20', user_id: 'b' },
        { memory_date: '2026-07-01', user_id: 'blocked' },
        { memory_date: '2026-06-30', user_id: 'a' },
      ],
      (userId) => userId === 'blocked',
    );
    expect(counts).toEqual({ '2026-09': 2, '2026-06': 1 });
  });

  it('lists every month from now back to the oldest memory, empty months at 0', () => {
    const options = getTimelineMonthOptions(september2026, { '2026-09': 2, '2026-06': 1 });
    expect(options.map((o) => [o.iso, o.count, o.isCurrent])).toEqual([
      ['2026-09-01', 2, true],
      ['2026-08-01', 0, false],
      ['2026-07-01', 0, false],
      ['2026-06-01', 1, false],
    ]);
  });

  it('crosses years and starts at a future-dated memory\'s month when there is one', () => {
    const options = getTimelineMonthOptions(september2026, { '2026-11': 1, '2025-12': 3 });
    expect(options[0]).toMatchObject({ iso: '2026-11-01', count: 1, isCurrent: false });
    expect(options.find((o) => o.isCurrent)?.iso).toBe('2026-09-01');
    expect(options.at(-1)).toMatchObject({ iso: '2025-12-01', count: 3, year: 2025, month: 11 });
    expect(options).toHaveLength(12);
  });

  it('offers only the current month with no memories', () => {
    expect(getTimelineMonthOptions(september2026, {}).map((o) => o.iso)).toEqual(['2026-09-01']);
  });

  it('anchors a picked month at its last day, and the current month at today (null)', () => {
    expect(getMonthAnchorDate({ year: 2025, month: 1, isCurrent: false })).toBe('2025-02-28');
    expect(getMonthAnchorDate({ year: 2024, month: 1, isCurrent: false })).toBe('2024-02-29');
    expect(getMonthAnchorDate({ year: 2025, month: 11, isCurrent: false })).toBe('2025-12-31');
    expect(getMonthAnchorDate({ year: 2026, month: 8, isCurrent: true })).toBeNull();
  });

  it('labels months with the year, always', () => {
    expect(formatTimelineMonthLabel('2025-03-20')).toBe('March 2025');
    expect(formatTimelineMonthLabel(september2026)).toBe('September 2026');
  });
});
