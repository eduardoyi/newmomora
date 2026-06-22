import { buildCalendarWeeks, getCalendarFetchRange } from '@/utils/calendar';

describe('calendar utilities', () => {
  const referenceDate = new Date('2026-06-10T12:00:00');

  it('builds week rows back to the oldest memory week', () => {
    const weeks = buildCalendarWeeks({
      referenceDate,
      oldestMemoryDate: '2026-04-20',
      minimumWeeks: 4,
    });

    expect(weeks[0]?.label).toBe('this week');
    expect(weeks[0]?.days.map((day) => day.iso)).toEqual([
      '2026-06-10',
      '2026-06-09',
      '2026-06-08',
    ]);
    expect(weeks.at(-1)?.startIso).toBe('2026-04-20');
  });

  it('keeps a short fallback range when there are no memories yet', () => {
    const weeks = buildCalendarWeeks({
      referenceDate,
      oldestMemoryDate: null,
      minimumWeeks: 4,
    });

    expect(weeks).toHaveLength(4);
    expect(weeks.at(-1)?.startIso).toBe('2026-05-18');
  });

  it('returns a bounded fetch range around visible week rows', () => {
    const weeks = buildCalendarWeeks({
      referenceDate,
      oldestMemoryDate: '2026-04-20',
      minimumWeeks: 4,
    });

    expect(getCalendarFetchRange(weeks, { startIndex: 2, endIndex: 3 }, 1)).toEqual({
      startDate: '2026-05-11',
      endDate: '2026-06-07',
    });
  });
});
