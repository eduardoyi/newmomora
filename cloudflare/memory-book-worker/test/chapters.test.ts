import { describe, expect, it } from 'vitest';
import {
  chapterIndexOfMonth,
  computeAgeYearChapters,
  computeBirthdayMonthsFromDob,
  dropEmptyChapters,
  isChapterMode,
  resolveChapters,
} from '../src/chapters';

describe('computeAgeYearChapters', () => {
  it('DOB 2022-10-23, window 2023-01 -> 2026-09: the birthday month ends each chapter', () => {
    const chapters = computeAgeYearChapters('2022-10-23', '2023-01', '2026-09');
    expect(chapters).toEqual([
      { ageYear: 1, startMonth: '2022-10', endMonth: '2023-10' },
      { ageYear: 2, startMonth: '2023-11', endMonth: '2024-10' },
      { ageYear: 3, startMonth: '2024-11', endMonth: '2025-10' },
      { ageYear: 4, startMonth: '2025-11', endMonth: '2026-10' },
    ]);
  });

  it('every month belongs to exactly one chapter (no overlap, no gap)', () => {
    const chapters = computeAgeYearChapters('2022-10-23', '2022-10', '2026-09');
    for (let i = 1; i < chapters.length; i++) {
      const prevEnd = chapters[i - 1].endMonth;
      const [y, m] = prevEnd.split('-').map(Number);
      const expectedStart = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      expect(chapters[i].startMonth).toBe(expectedStart);
    }
  });

  it('skips chapters that end before the first month, keeping age-year numbering', () => {
    const chapters = computeAgeYearChapters('2022-10-23', '2024-03', '2025-02');
    expect(chapters.map((c) => c.ageYear)).toEqual([2, 3]);
    expect(chapters[0].startMonth).toBe('2023-11'); // theoretical, not clipped
  });

  it('Feb-29 DOB clamps non-leap birthdays to Feb 28 and keeps leap birthdays on Feb 29', () => {
    const chapters = computeAgeYearChapters('2020-02-29', '2020-02', '2024-06');
    expect(chapters).toEqual([
      { ageYear: 1, startMonth: '2020-02', endMonth: '2021-02' },
      { ageYear: 2, startMonth: '2021-03', endMonth: '2022-02' },
      { ageYear: 3, startMonth: '2022-03', endMonth: '2023-02' },
      { ageYear: 4, startMonth: '2023-03', endMonth: '2024-02' },
      { ageYear: 5, startMonth: '2024-03', endMonth: '2025-02' },
    ]);
  });

  it('January DOB: chapter 1 runs birth month through the first-birthday January (13 months), later chapters are 12', () => {
    const chapters = computeAgeYearChapters('2022-01-10', '2022-01', '2024-01');
    expect(chapters).toEqual([
      { ageYear: 1, startMonth: '2022-01', endMonth: '2023-01' },
      { ageYear: 2, startMonth: '2023-02', endMonth: '2024-01' },
    ]);
  });

  it('a December birthday rolls the next chapter start into January of the following year', () => {
    const chapters = computeAgeYearChapters('2021-12-05', '2022-01', '2023-06');
    expect(chapters[0]).toEqual({ ageYear: 1, startMonth: '2021-12', endMonth: '2022-12' });
    expect(chapters[1].startMonth).toBe('2023-01');
  });

  it('returns [] with no DOB, an invalid DOB, bad month keys or an inverted range', () => {
    expect(computeAgeYearChapters(null, '2023-01', '2024-01')).toEqual([]);
    expect(computeAgeYearChapters(undefined, '2023-01', '2024-01')).toEqual([]);
    expect(computeAgeYearChapters('nope', '2023-01', '2024-01')).toEqual([]);
    expect(computeAgeYearChapters('2022-10-23', '2023-1', '2024-01')).toEqual([]);
    expect(computeAgeYearChapters('2022-10-23', '2024-01', '2023-01')).toEqual([]);
  });
});

describe('chapterIndexOfMonth', () => {
  const chapters = computeAgeYearChapters('2022-10-23', '2023-01', '2026-09');

  it('maps boundary months to the right chapter (birthday month closes its chapter)', () => {
    expect(chapterIndexOfMonth(chapters, '2023-01')).toBe(0);
    expect(chapterIndexOfMonth(chapters, '2023-10')).toBe(0);
    expect(chapterIndexOfMonth(chapters, '2023-11')).toBe(1);
    expect(chapterIndexOfMonth(chapters, '2024-10')).toBe(1);
    expect(chapterIndexOfMonth(chapters, '2025-11')).toBe(3);
    expect(chapterIndexOfMonth(chapters, '2026-09')).toBe(3);
  });

  it('clamps months before the first and after the last chapter; -1 for no chapters', () => {
    expect(chapterIndexOfMonth(chapters, '2022-01')).toBe(0);
    expect(chapterIndexOfMonth(chapters, '2030-05')).toBe(3);
    expect(chapterIndexOfMonth([], '2023-01')).toBe(-1);
  });
});

describe('dropEmptyChapters / isChapterMode / resolveChapters', () => {
  const chapters = computeAgeYearChapters('2022-10-23', '2023-01', '2026-09');

  it('drops a chapter with zero eligible months, keeping order and age-year numbers', () => {
    // No months in chapter 2 (2023-11..2024-10).
    const kept = dropEmptyChapters(chapters, ['2023-03', '2025-01', '2026-02']);
    expect(kept.map((c) => c.ageYear)).toEqual([1, 3, 4]);
    expect(isChapterMode(kept)).toBe(true);
  });

  it('counts a pre-DOB month toward the first chapter', () => {
    const kept = dropEmptyChapters(chapters, ['2022-05', '2024-01']);
    expect(kept.map((c) => c.ageYear)).toEqual([1, 2]);
  });

  it('single non-empty chapter -> chapter mode off', () => {
    const kept = dropEmptyChapters(chapters, ['2024-01', '2024-05']);
    expect(kept.map((c) => c.ageYear)).toEqual([2]);
    expect(isChapterMode(kept)).toBe(false);
    expect(resolveChapters('2022-10-23', ['2024-01', '2024-05'])).toEqual([]);
  });

  it('resolveChapters returns the non-empty chapters when >= 2 remain', () => {
    const resolved = resolveChapters('2022-10-23', ['2023-03', '2025-01', '2026-02', '2025-01']);
    expect(resolved.map((c) => c.ageYear)).toEqual([1, 3, 4]);
  });

  it('no DOB or no months -> no chapters, chapter mode off', () => {
    expect(resolveChapters(null, ['2023-03', '2025-01'])).toEqual([]);
    expect(resolveChapters('2022-10-23', [])).toEqual([]);
    expect(isChapterMode([])).toBe(false);
  });
});

describe('computeBirthdayMonthsFromDob', () => {
  it('maps every birthday inside the window to its age', () => {
    const map = computeBirthdayMonthsFromDob('2022-10-23', '2023-01-01', '2026-10-01');
    expect([...map.entries()]).toEqual([
      ['2023-10', 1],
      ['2024-10', 2],
      ['2025-10', 3],
    ]);
  });

  it('is half-open: a birthday on windowEndExclusive is out, one on windowStart is in', () => {
    expect([...computeBirthdayMonthsFromDob('2022-10-23', '2023-10-23', '2024-10-23').entries()]).toEqual([
      ['2023-10', 1],
    ]);
  });

  it('Feb-29 DOB: the clamped Feb-28 birthday still flags February', () => {
    const map = computeBirthdayMonthsFromDob('2020-02-29', '2021-01-01', '2023-01-01');
    expect([...map.entries()]).toEqual([
      ['2021-02', 1],
      ['2022-02', 2],
    ]);
  });

  it('January DOB', () => {
    const map = computeBirthdayMonthsFromDob('2022-01-10', '2022-01-01', '2024-06-01');
    expect([...map.entries()]).toEqual([
      ['2023-01', 1],
      ['2024-01', 2],
    ]);
  });

  it('empty for no DOB, an invalid DOB, or a window before the first birthday', () => {
    expect(computeBirthdayMonthsFromDob(null, '2023-01-01', '2026-10-01').size).toBe(0);
    expect(computeBirthdayMonthsFromDob('bad', '2023-01-01', '2026-10-01').size).toBe(0);
    expect(computeBirthdayMonthsFromDob('2022-10-23', '2022-10-23', '2023-10-23').size).toBe(0);
  });
});
