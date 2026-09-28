import {
  buildGridMonth,
  buildGridMonthOffsets,
  buildGridMonths,
  getGridDayAccessibilityLabel,
  getGridFetchRange,
  getGridMonthHeight,
  getGridTileSize,
  GRID_GAP,
  GRID_MONTH_BOTTOM_PADDING,
  GRID_MONTH_TITLE_HEIGHT,
  summarizeGridDays,
} from '@/utils/calendar-grid';
import { getTimelineMonthOptions } from '@/utils/timeline-anchor';
import type { MemoryWithTags } from '@/services/memories';

const TODAY = '2026-09-28';

describe('buildGridMonth', () => {
  it('pads a Monday-start grid: September 2026 starts on a Tuesday, 5 rows', () => {
    const month = buildGridMonth(2026, 8, TODAY);
    expect(month.key).toBe('2026-09');
    expect(month.title).toBe('September 2026');
    expect(month.weeks).toHaveLength(5);
    expect(month.weeks[0]![0]).toBeNull();
    expect(month.weeks[0]![1]).toMatchObject({ iso: '2026-09-01', day: 1 });
    expect(month.weeks.every((week) => week.length === 7)).toBe(true);
  });

  it('builds 4-row (Feb 2021, Monday the 1st, 28 days) and 6-row (Mar 2026, Sunday the 1st) months', () => {
    expect(buildGridMonth(2021, 1, TODAY).weeks).toHaveLength(4);
    const march = buildGridMonth(2026, 2, TODAY);
    expect(march.weeks).toHaveLength(6);
    expect(march.weeks[0]!.slice(0, 6).every((cell) => cell === null)).toBe(true);
    expect(march.weeks[0]![6]).toMatchObject({ iso: '2026-03-01' });
  });

  it('keeps every local day across a DST change (March 2026, US spring forward on the 8th)', () => {
    const days = buildGridMonth(2026, 2, TODAY).weeks.flat().filter(Boolean);
    expect(days.map((day) => day!.iso)).toEqual(
      Array.from({ length: 31 }, (_, index) => `2026-03-${String(index + 1).padStart(2, '0')}`),
    );
  });

  it('flags today and future days', () => {
    const days = buildGridMonth(2026, 8, TODAY).weeks.flat().filter(Boolean);
    expect(days.find((day) => day!.iso === TODAY)).toMatchObject({ isToday: true, isFuture: false });
    expect(days.find((day) => day!.iso === '2026-09-29')).toMatchObject({ isToday: false, isFuture: true });
    expect(days.find((day) => day!.iso === '2026-09-27')).toMatchObject({ isFuture: false });
  });

  it('builds one grid month per picker option, newest first', () => {
    const options = getTimelineMonthOptions(new Date(2026, 8, 28), { '2026-09': 1, '2026-07': 2 });
    expect(buildGridMonths(options, TODAY).map((month) => month.key)).toEqual(['2026-09', '2026-08', '2026-07']);
  });
});

describe('layout math', () => {
  it('sizes tiles to fill seven columns', () => {
    // 390 - 32 padding - 24 gaps = 334 / 7 = 47.7
    expect(getGridTileSize(390)).toBe(47);
    expect(getGridTileSize(100)).toBe(24);
  });

  it('computes exact month heights and cumulative offsets', () => {
    const fiveRows = buildGridMonth(2026, 8, TODAY);
    const sixRows = buildGridMonth(2026, 2, TODAY);
    expect(getGridMonthHeight(fiveRows, 40)).toBe(GRID_MONTH_TITLE_HEIGHT + 5 * 40 + 4 * GRID_GAP + GRID_MONTH_BOTTOM_PADDING);
    expect(buildGridMonthOffsets([fiveRows, sixRows, fiveRows], 40)).toEqual([
      0,
      getGridMonthHeight(fiveRows, 40),
      getGridMonthHeight(fiveRows, 40) + getGridMonthHeight(sixRows, 40),
    ]);
  });

  it('fetches the visible months plus one either side, clamped at the ends', () => {
    const months = ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05'].map((key) => {
      const [year, month] = key.split('-').map(Number) as [number, number];
      return buildGridMonth(year, month - 1, TODAY);
    });
    expect(getGridFetchRange(months, 2, 2)).toEqual({ startDate: '2026-06-01', endDate: '2026-08-31' });
    expect(getGridFetchRange(months, 0, 1)).toEqual({ startDate: '2026-07-01', endDate: '2026-09-30' });
    expect(getGridFetchRange(months, 4, 4)).toEqual({ startDate: '2026-05-01', endDate: '2026-06-30' });
    expect(getGridFetchRange([], 0, 0)).toBeNull();
  });
});

describe('summarizeGridDays', () => {
  const memory = (id: string, date: string, userId = 'u1') => ({ id, memory_date: date, user_id: userId }) as MemoryWithTags;

  it('keeps each day\'s first (newest) row and counts the rest, skipping blocked authors', () => {
    const summaries = summarizeGridDays(
      [memory('a', '2026-09-02'), memory('b', '2026-09-02'), memory('c', '2026-09-02', 'blocked'), memory('d', '2026-09-01')],
      (userId) => userId === 'blocked',
    );
    expect(summaries.get('2026-09-02')).toEqual({ memory: expect.objectContaining({ id: 'a' }), count: 2 });
    expect(summaries.get('2026-09-01')).toEqual({ memory: expect.objectContaining({ id: 'd' }), count: 1 });
  });

  it('drops a day whose memories are all by blocked authors', () => {
    const summaries = summarizeGridDays([memory('c', '2026-09-02', 'blocked')], (userId) => userId === 'blocked');
    expect(summaries.has('2026-09-02')).toBe(false);
  });
});

it('labels tiles for screen readers', () => {
  const month = buildGridMonth(2026, 2, TODAY);
  const day = month.weeks.flat().find((cell) => cell?.day === 3)!;
  expect(getGridDayAccessibilityLabel(day, month, 0)).toBe('March 3, no memories');
  expect(getGridDayAccessibilityLabel(day, month, 1)).toBe('March 3, 1 memory');
  expect(getGridDayAccessibilityLabel(day, month, 2)).toBe('March 3, 2 memories');
});
