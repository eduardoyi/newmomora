import { describe, expect, it } from 'vitest';
import { formatAgeChip } from '../age';

/**
 * Print-polish round (owner decision 2026-09-14, item F): `formatAgeChip`
 * is the book-renderer-local reimplementation of the app's own age-chip
 * format (`formatAgeFromDob` in src/utils/family-members.ts) — see age.ts's
 * own doc comment for why it's a separate function from `formatAge`
 * (through-the-years caption phrasing) rather than a shared one.
 */
describe('formatAgeChip', () => {
  it('formats a combined years+months age, comma-separated, no "and"/"old" (en)', () => {
    expect(formatAgeChip({ years: 2, months: 5 }, 'en')).toBe('2 years, 5 months');
  });

  it('formats a combined years+months age, comma-separated (es)', () => {
    expect(formatAgeChip({ years: 2, months: 5 }, 'es')).toBe('2 años, 5 meses');
  });

  it('formats under-1-year as months only, no "0 years" half', () => {
    expect(formatAgeChip({ years: 0, months: 7 }, 'en')).toBe('7 months');
    expect(formatAgeChip({ years: 0, months: 7 }, 'es')).toBe('7 meses');
  });

  it('formats an exact-year age as years only, no "0 months" half', () => {
    expect(formatAgeChip({ years: 2, months: 0 }, 'en')).toBe('2 years');
    expect(formatAgeChip({ years: 2, months: 0 }, 'es')).toBe('2 años');
  });

  it('uses correct singular grammar for exactly 1 year / 1 month in both languages', () => {
    expect(formatAgeChip({ years: 1, months: 0 }, 'en')).toBe('1 year');
    expect(formatAgeChip({ years: 1, months: 0 }, 'es')).toBe('1 año');
    expect(formatAgeChip({ years: 0, months: 1 }, 'en')).toBe('1 month');
    expect(formatAgeChip({ years: 0, months: 1 }, 'es')).toBe('1 mes');
    expect(formatAgeChip({ years: 1, months: 1 }, 'en')).toBe('1 year, 1 month');
    expect(formatAgeChip({ years: 1, months: 1 }, 'es')).toBe('1 año, 1 mes');
  });
});
