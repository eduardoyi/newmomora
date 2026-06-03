import { formatIsoDateForDisplay, parseIsoDate, toIsoDate, todayIsoDate } from '@/utils/dates';

describe('toIsoDate', () => {
  it('formats dates as YYYY-MM-DD', () => {
    expect(toIsoDate(new Date('2022-10-25T15:30:00'))).toBe('2022-10-25');
  });
});

describe('parseIsoDate', () => {
  it('parses valid ISO dates', () => {
    const parsed = parseIsoDate('2022-10-25');

    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2022);
    expect(parsed?.getMonth()).toBe(9);
    expect(parsed?.getDate()).toBe(25);
  });

  it('returns null for invalid values', () => {
    expect(parseIsoDate('10/25/2022')).toBeNull();
    expect(parseIsoDate('invalid')).toBeNull();
  });
});

describe('formatIsoDateForDisplay', () => {
  it('formats valid ISO dates for display', () => {
    expect(formatIsoDateForDisplay('2026-05-24')).toContain('2026');
  });

  it('returns the original value when parsing fails', () => {
    expect(formatIsoDateForDisplay('not-a-date')).toBe('not-a-date');
  });
});

describe('todayIsoDate', () => {
  it('returns today in ISO format', () => {
    expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
