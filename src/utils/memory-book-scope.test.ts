import {
  addDaysToDate,
  addYearsClamped,
  ageYearLabel,
  buildAgeYearScopeOptions,
  buildCalendarYearScopeOptions,
  buildMemoryBookScopeOptions,
  everythingScopeOption,
  formatEraLine,
  formatMonthYear,
  formatYearRange,
  memoryBookMatchesScope,
  memoryBookScopeKey,
  MEMORY_BOOK_PAGE_BUDGET,
  MEMORY_BOOK_THIN_THRESHOLD,
  pickSuggestedScopes,
  thinPeriodReason,
  toJulianDayNumber,
  fromJulianDayNumber,
} from '@/utils/memory-book-scope';

describe('addYearsClamped', () => {
  it('adds whole years on a plain date', () => {
    expect(addYearsClamped('2022-10-14', 1)).toBe('2023-10-14');
    expect(addYearsClamped('2022-10-14', 0)).toBe('2022-10-14');
  });

  it('clamps a Feb 29 birthday to Feb 28 in a non-leap target year', () => {
    expect(addYearsClamped('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYearsClamped('2024-02-29', 2)).toBe('2026-02-28');
  });

  it('keeps Feb 29 when the target year is itself a leap year', () => {
    expect(addYearsClamped('2024-02-29', 4)).toBe('2028-02-29');
  });
});

describe('toJulianDayNumber / fromJulianDayNumber round-trip', () => {
  it('round-trips across a year boundary and a leap day', () => {
    for (const date of ['2024-01-01', '2024-02-29', '2024-12-31', '2025-01-01', '2000-02-29']) {
      const jdn = toJulianDayNumber(date);
      const { year, month, day } = fromJulianDayNumber(jdn);
      const formatted = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      expect(formatted).toBe(date);
    }
  });
});

describe('addDaysToDate', () => {
  it('steps back one day across a month boundary', () => {
    expect(addDaysToDate('2025-03-01', -1)).toBe('2025-02-28');
  });

  it('steps back one day into a leap-day Feb 29', () => {
    expect(addDaysToDate('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('steps forward across a year boundary', () => {
    expect(addDaysToDate('2024-12-31', 1)).toBe('2025-01-01');
  });
});

describe('ageYearLabel', () => {
  it('renders the first twenty years as ordinal words', () => {
    expect(ageYearLabel(1)).toBe('Year One');
    expect(ageYearLabel(2)).toBe('Year Two');
    expect(ageYearLabel(20)).toBe('Year Twenty');
  });

  it('falls back to a plain number past the ordinal-word table', () => {
    expect(ageYearLabel(21)).toBe('Year 21');
  });
});

describe('formatMonthYear / formatEraLine', () => {
  it('formats a plain calendar date as "Mon YYYY"', () => {
    expect(formatMonthYear('2022-10-14')).toBe('Oct 2022');
    expect(formatMonthYear('2023-01-01')).toBe('Jan 2023');
  });

  it('joins start/end with an en dash', () => {
    expect(formatEraLine('2022-10-14', '2023-10-13')).toBe('Oct 2022 – Oct 2023');
  });
});

describe('buildAgeYearScopeOptions', () => {
  it('returns no options when date_of_birth is unknown', () => {
    expect(buildAgeYearScopeOptions(null, '2026-09-15')).toEqual([]);
  });

  it('builds Year One through the in-progress current age year', () => {
    // Born 2023-06-01; "today" is 2026-09-15 -> child has had 1st, 2nd, 3rd
    // birthdays and is partway through Year Four.
    const options = buildAgeYearScopeOptions('2023-06-01', '2026-09-15');
    expect(options.map((o) => o.label)).toEqual(['Year One', 'Year Two', 'Year Three', 'Year Four']);
    expect(options[0]).toMatchObject({
      kind: 'age_year',
      ageYear: 1,
      startDate: '2023-06-01',
      endDate: '2024-05-31',
      eraLine: 'Jun 2023 – May 2024',
    });
    // Year Four is still in progress (today is inside its window) -- it
    // must still be offered per the locked design ("show every scope").
    expect(options[3]).toMatchObject({
      ageYear: 4,
      startDate: '2026-06-01',
      endDate: '2027-05-31',
    });
  });

  it('does not offer an age year that has not started yet', () => {
    const options = buildAgeYearScopeOptions('2026-09-01', '2026-09-15');
    expect(options).toHaveLength(1);
    expect(options[0].label).toBe('Year One');
  });

  it('offers exactly Year One on the child\'s actual birth date', () => {
    const options = buildAgeYearScopeOptions('2026-09-15', '2026-09-15');
    expect(options).toHaveLength(1);
  });

  it('handles a leap-day birthday: Year One ends the day before the clamped Feb 28 anniversary', () => {
    // "today" pushed out to 2029 so the child has reached Year Five, which
    // starts back on the leap day itself (2028 is a leap year again).
    const options = buildAgeYearScopeOptions('2024-02-29', '2029-06-01');
    const yearOne = options.find((o) => o.ageYear === 1)!;
    expect(yearOne.startDate).toBe('2024-02-29');
    // endExclusive = addYearsClamped(dob, 1) = 2025-02-28 (clamped, non-leap
    // target year) -> inclusive end is the day before that.
    expect(yearOne.endDate).toBe('2025-02-27');
    expect(yearOne.eraLine).toBe('Feb 2024 – Feb 2025');

    const yearFour = options.find((o) => o.ageYear === 4)!;
    // Year Four's endExclusive is the 2028 leap day itself (unclamped) --
    // its inclusive end is the day before, Feb 28 2028.
    expect(yearFour.startDate).toBe('2027-02-28');
    expect(yearFour.endDate).toBe('2028-02-28');

    const yearFive = options.find((o) => o.ageYear === 5)!;
    // Year Five starts exactly on the 2028 leap day.
    expect(yearFive.startDate).toBe('2028-02-29');
    expect(yearFive.endDate).toBe('2029-02-27');
  });
});

describe('buildCalendarYearScopeOptions', () => {
  it('lists birth year through current year, most recent first', () => {
    const options = buildCalendarYearScopeOptions('2023-06-01', '2026-09-15');
    expect(options.map((o) => o.label)).toEqual(['2026', '2025', '2024', '2023']);
    expect(options[0]).toMatchObject({
      kind: 'calendar_year',
      calendarYear: 2026,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      eraLine: null,
    });
  });

  it('falls back to current + previous year when date_of_birth is unknown', () => {
    const options = buildCalendarYearScopeOptions(null, '2026-09-15');
    expect(options.map((o) => o.label)).toEqual(['2026', '2025']);
  });

  it('caps the lookback for a very old date_of_birth', () => {
    const options = buildCalendarYearScopeOptions('1990-01-01', '2026-09-15');
    expect(options.length).toBeLessThanOrEqual(25);
    expect(options[options.length - 1].calendarYear).toBeGreaterThan(1990);
  });
});

describe('buildMemoryBookScopeOptions', () => {
  it('orders age years, then calendar years, then Everything', () => {
    const options = buildMemoryBookScopeOptions('2025-01-10', '2026-09-15');
    const kinds = options.map((o) => o.kind);
    const lastAgeYearIndex = kinds.lastIndexOf('age_year');
    const firstCalendarYearIndex = kinds.indexOf('calendar_year');
    const lastCalendarYearIndex = kinds.lastIndexOf('calendar_year');
    expect(lastAgeYearIndex).toBeLessThan(firstCalendarYearIndex);
    expect(lastCalendarYearIndex).toBe(kinds.length - 2);
    expect(kinds[kinds.length - 1]).toBe('everything');
  });

  it('always includes Everything even with no date_of_birth', () => {
    const options = buildMemoryBookScopeOptions(null, '2026-09-15');
    expect(options[options.length - 1]).toEqual(everythingScopeOption());
  });
});

describe('memoryBookScopeKey / memoryBookMatchesScope', () => {
  it('produces a stable, distinct key per scope shape', () => {
    const a = { kind: 'age_year' as const, startDate: '2023-06-01', endDate: '2024-05-31' };
    const b = { kind: 'calendar_year' as const, startDate: '2023-06-01', endDate: '2024-05-31' };
    expect(memoryBookScopeKey(a)).not.toBe(memoryBookScopeKey(b));
    expect(memoryBookScopeKey(everythingScopeOption())).toBe('everything:null:null');
  });

  it('matches a DB row against the option that would have produced it', () => {
    const option = buildAgeYearScopeOptions('2023-06-01', '2026-09-15')[0];
    expect(memoryBookMatchesScope(
      { scope_kind: 'age_year', scope_start_date: '2023-06-01', scope_end_date: '2024-05-31' },
      option,
    )).toBe(true);
    expect(memoryBookMatchesScope(
      { scope_kind: 'age_year', scope_start_date: '2023-06-01', scope_end_date: '2024-05-30' },
      option,
    )).toBe(false);
    expect(memoryBookMatchesScope(
      { scope_kind: 'calendar_year', scope_start_date: '2023-06-01', scope_end_date: '2024-05-31' },
      option,
    )).toBe(false);
  });
});

describe('thinPeriodReason', () => {
  it('matches the locked copy shape below the threshold', () => {
    expect(thinPeriodReason(12)).toBe('12 memories in this period — books need about 30');
  });

  it('uses singular "memory" for a count of exactly one', () => {
    expect(thinPeriodReason(1)).toBe('1 memory in this period — books need about 30');
  });

  it('handles zero', () => {
    expect(thinPeriodReason(0)).toBe('0 memories in this period — books need about 30');
  });

  it('returns null once the threshold is met', () => {
    expect(thinPeriodReason(MEMORY_BOOK_THIN_THRESHOLD)).toBeNull();
    expect(thinPeriodReason(MEMORY_BOOK_THIN_THRESHOLD + 5)).toBeNull();
  });
});

describe('constants', () => {
  it('matches the locked design brief', () => {
    expect(MEMORY_BOOK_THIN_THRESHOLD).toBe(30);
    expect(MEMORY_BOOK_PAGE_BUDGET).toBe(122);
  });
});

describe('formatYearRange', () => {
  it('spans two years when the window crosses a calendar year', () => {
    expect(formatYearRange('2022-10-14', '2023-10-13')).toBe('2022 – 2023');
  });

  it('collapses to a single year when start and end share a year', () => {
    expect(formatYearRange('2024-01-01', '2024-12-31')).toBe('2024');
  });
});

describe('pickSuggestedScopes', () => {
  const todayIso = '2026-09-17';
  const dateOfBirth = '2022-06-01';
  const options = buildMemoryBookScopeOptions(dateOfBirth, todayIso);

  it('excludes calendar-year options entirely', () => {
    const suggestions = pickSuggestedScopes(options, {}, todayIso);
    expect(suggestions.every((option) => option.kind !== 'calendar_year')).toBe(true);
  });

  it('excludes scopes that already have an existing book', () => {
    const yearOne = options.find((option) => option.label === 'Year One')!;
    const rowsByScopeKey = { [memoryBookScopeKey(yearOne)]: true };

    const suggestions = pickSuggestedScopes(options, rowsByScopeKey, todayIso);

    expect(suggestions.some((option) => option.label === 'Year One')).toBe(false);
  });

  it('never returns more than 3 suggestions', () => {
    const suggestions = pickSuggestedScopes(options, {}, todayIso);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('orders completed age-years most-recent-first, up to 2', () => {
    // DOB 2022-06-01 as of today 2026-09-17: Year Five (2026-06-01 -- ) is
    // still in progress; Year Four (2025-06-01 -- 2026-05-31) is the most
    // recently completed, then Year Three.
    const suggestions = pickSuggestedScopes(options, {}, todayIso);
    const ageYearSuggestions = suggestions.filter((option) => option.kind === 'age_year');

    expect(ageYearSuggestions.length).toBe(2);
    expect(ageYearSuggestions[0].label).toBe('Year Four');
    expect(ageYearSuggestions[1].label).toBe('Year Three');
  });

  it('excludes the in-progress (not-yet-completed) current age-year', () => {
    const suggestions = pickSuggestedScopes(options, {}, todayIso);
    expect(suggestions.some((option) => option.label === 'Year Five')).toBe(false);
  });

  it('includes the everything option exactly once when it has no book', () => {
    const suggestions = pickSuggestedScopes(options, {}, todayIso);
    const everythingCount = suggestions.filter((option) => option.kind === 'everything').length;
    expect(everythingCount).toBe(1);
  });

  it('omits everything once it already has a book', () => {
    const everything = everythingScopeOption();
    const rowsByScopeKey = { [memoryBookScopeKey(everything)]: true };

    const suggestions = pickSuggestedScopes(options, rowsByScopeKey, todayIso);

    expect(suggestions.some((option) => option.kind === 'everything')).toBe(false);
  });

  it('returns an empty result when every eligible scope already has a book', () => {
    const rowsByScopeKey = Object.fromEntries(
      options
        .filter((option) => option.kind !== 'calendar_year')
        .map((option) => [memoryBookScopeKey(option), true]),
    );

    const suggestions = pickSuggestedScopes(options, rowsByScopeKey, todayIso);

    expect(suggestions).toEqual([]);
  });
});
