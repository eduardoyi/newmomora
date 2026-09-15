// Pure scope-window math for the Memory Book in-app scope picker (plan
// §"5a.5", docs/plans/memory-book.md, owner decision 2026-09-07). Every date
// function here is a deliberate, documented duplicate of the equivalent
// server-side math -- never a shared import -- because the client (Expo/RN)
// cannot import Deno Edge Function modules, and the picker's whole job is to
// FREEZE a scope window the server will later treat as authoritative input
// (memory_books.scope_start_date/scope_end_date). The app must therefore
// compute the exact same calendar dates the server does:
//
//   - `addYearsClamped` mirrors supabase/functions/_shared/date-context.ts's
//     `addYears` (Feb 29 -> Feb 28 clamp in a non-leap target year) byte for
//     byte -- this is the one that matters for exactness, since
//     supabase/functions/workflow-memory-book-bridge/index.ts derives its
//     own `windowEndExclusive` from the SAME `scope_end_date` this module
//     freezes at insert time (see that function's header comment and
//     docs/features/memory-book-generation.md's "Scope" section).
//   - `toJulianDayNumber`/`fromJulianDayNumber`/`addDaysToDate` mirror the
//     Fliegel & Van Flandern integer arithmetic in both
//     supabase/functions/_shared/date-context.ts and
//     supabase/scripts/eval-memory-book-outline.ts (`fromJulianDayNumber`),
//     so "day before next birthday" lands on the identical calendar date the
//     server would compute for the same DOB, with no `Date` object /
//     timezone round-trip anywhere (same rationale as those files).
//   - `ageYearLabel` mirrors eval-memory-book-outline.ts's `ageYearLabel`
//     (1 = "Year One" = birth -> 1st birthday) -- scope_label values already
//     rendered in book covers/lists use exactly this wording (see
//     book-renderer fixtures/tests referencing 'Year One', 'Year Two').
//
// scope_start_date/scope_end_date are frozen INCLUSIVE on both ends per the
// locked design brief ("our frozen dates are inclusive start, inclusive
// end"). The bridge converts scope_end_date -> its own exclusive window via
// `addDaysToDateOnly(scope_end_date, 1)` -- so as long as THIS module's
// inclusive end date is the true calendar day before the next boundary,
// the two sides agree exactly.

export const MEMORY_BOOK_THIN_THRESHOLD = 30;
// Locked design: every book inserted by the picker uses this fixed budget
// (a soft input to curation, not the final page count -- see
// docs/features/memory-book-generation.md's "Constraints & gotchas").
export const MEMORY_BOOK_PAGE_BUDGET = 122;

// Loop safety bounds only -- real enumeration always stops earlier (an
// age-year whose start date is still in the future, or a calendar year
// before MAX_CALENDAR_YEARS_BACK). No realistic child in this app is old
// enough to hit either cap; they exist so a corrupted/garbage
// date_of_birth can never produce an unbounded list.
const MAX_AGE_YEARS = 21;
const MAX_CALENDAR_YEARS_BACK = 25;

export type MemoryBookScopeKind = 'age_year' | 'calendar_year' | 'everything';

export interface MemoryBookScopeOption {
  kind: MemoryBookScopeKind;
  /** Primary label, e.g. "Year One" / "2024" / "Everything" -- stored verbatim as memory_books.scope_label. */
  label: string;
  /** Secondary "era line", e.g. "Oct 2022 – Oct 2023" -- age-year scopes only per the locked design brief; null otherwise. */
  eraLine: string | null;
  /** Inclusive. Null only for 'everything'. */
  startDate: string | null;
  /** Inclusive. Null only for 'everything'. */
  endDate: string | null;
  ageYear?: number;
  calendarYear?: number;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

export function parseDateParts(dateStr: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(`Unexpected date format "${dateStr}"`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Adds `years` to a `YYYY-MM-DD` date string without ever round-tripping
 * through a `Date` object. Clamps Feb 29 to Feb 28 in a non-leap target
 * year -- see this module's header comment for why this must byte-for-byte
 * match `supabase/functions/_shared/date-context.ts`'s `addYears`.
 */
export function addYearsClamped(dateStr: string, years: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const newYear = year + years;

  const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const clampedDay = month === 2 && day === 29 && !isLeapYear(newYear) ? 28 : day;

  return `${pad4(newYear)}-${pad2(month)}-${pad2(clampedDay)}`;
}

/** Gregorian date -> Julian Day Number (Fliegel & Van Flandern). */
export function toJulianDayNumber(dateStr: string): number {
  const { year: y, month: m, day: d } = parseDateParts(dateStr);
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * m2 + 2) / 5) +
    365 * y2 +
    Math.floor(y2 / 4) -
    Math.floor(y2 / 100) +
    Math.floor(y2 / 400) -
    32045
  );
}

/** Julian Day Number -> Gregorian date (inverse of toJulianDayNumber). */
export function fromJulianDayNumber(jdn: number): DateParts {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  return { year, month, day };
}

export function addDaysToDate(dateStr: string, days: number): string {
  const jdn = toJulianDayNumber(dateStr) + days;
  const { year, month, day } = fromJulianDayNumber(jdn);
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

const ORDINAL_WORDS = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen', 'Twenty',
];

/** `ageYear` is 1-based (1 = "Year One" = birth -> 1st birthday). */
export function ageYearLabel(ageYear: number): string {
  const word = ORDINAL_WORDS[ageYear - 1] ?? String(ageYear);
  return `Year ${word}`;
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "Oct 2022" -- deliberately not `Intl.DateTimeFormat` (no locale/timezone
 * surprises for a plain calendar-date string, same rationale as the rest of
 * this module). */
export function formatMonthYear(dateStr: string): string {
  const { year, month } = parseDateParts(dateStr);
  return `${MONTH_ABBR[month - 1]} ${year}`;
}

/** "Oct 2022 – Oct 2023" -- the age-year cover-furniture era-line style
 * (locked design brief). `endDateInclusive` is the frozen inclusive end
 * date (the calendar day before the next birthday), not the exclusive
 * boundary. */
export function formatEraLine(startDate: string, endDateInclusive: string): string {
  return `${formatMonthYear(startDate)} – ${formatMonthYear(endDateInclusive)}`;
}

/**
 * Every age-year scope that has already started as of `todayIso`, oldest
 * first (Year One, Year Two, ...). Empty when `dateOfBirth` is null -- a
 * family member without a DOB on file simply has no age-year options (see
 * docs/features/memory-book-generation.md for this documented fallback).
 */
export function buildAgeYearScopeOptions(
  dateOfBirth: string | null,
  todayIso: string,
): MemoryBookScopeOption[] {
  if (!dateOfBirth) return [];

  const options: MemoryBookScopeOption[] = [];
  for (let ageYear = 1; ageYear <= MAX_AGE_YEARS; ageYear++) {
    const start = addYearsClamped(dateOfBirth, ageYear - 1);
    if (start > todayIso) break;

    const endExclusive = addYearsClamped(dateOfBirth, ageYear);
    const endInclusive = addDaysToDate(endExclusive, -1);

    options.push({
      kind: 'age_year',
      label: ageYearLabel(ageYear),
      eraLine: formatEraLine(start, endInclusive),
      startDate: start,
      endDate: endInclusive,
      ageYear,
    });
  }
  return options;
}

/**
 * Every calendar year from the child's birth year (or, when DOB is
 * unknown, a small fixed lookback) through the current year, most recent
 * first -- parents think of calendar-year books in recency order, unlike
 * the developmental Year One/Two/... progression. Not in the locked design
 * brief verbatim; a documented implementation choice (see feature doc).
 */
export function buildCalendarYearScopeOptions(
  dateOfBirth: string | null,
  todayIso: string,
): MemoryBookScopeOption[] {
  const currentYear = parseDateParts(todayIso).year;
  const dobYear = dateOfBirth ? parseDateParts(dateOfBirth).year : null;
  // No DOB on file: fall back to a small, bounded window (current + previous
  // year) rather than guessing an origin for the family's memory history.
  const earliestYear = Math.max(
    dobYear ?? currentYear - 1,
    currentYear - MAX_CALENDAR_YEARS_BACK + 1,
  );

  const options: MemoryBookScopeOption[] = [];
  for (let year = currentYear; year >= earliestYear; year--) {
    options.push({
      kind: 'calendar_year',
      label: String(year),
      eraLine: null,
      startDate: `${pad4(year)}-01-01`,
      endDate: `${pad4(year)}-12-31`,
      calendarYear: year,
    });
  }
  return options;
}

export function everythingScopeOption(): MemoryBookScopeOption {
  return { kind: 'everything', label: 'Everything', eraLine: null, startDate: null, endDate: null };
}

/** Age-year options, then calendar-year options, then Everything -- the
 * locked design brief's listed order. */
export function buildMemoryBookScopeOptions(
  dateOfBirth: string | null,
  todayIso: string,
): MemoryBookScopeOption[] {
  return [
    ...buildAgeYearScopeOptions(dateOfBirth, todayIso),
    ...buildCalendarYearScopeOptions(dateOfBirth, todayIso),
    everythingScopeOption(),
  ];
}

/** Stable identity for a scope, independent of any memory_books row --
 * used to match an existing row to the option that produced it, to key
 * React lists, and to key transient per-scope dispatch-error state. */
export function memoryBookScopeKey(option: {
  kind: MemoryBookScopeKind;
  startDate: string | null;
  endDate: string | null;
}): string {
  return `${option.kind}:${option.startDate ?? 'null'}:${option.endDate ?? 'null'}`;
}

/** Whether an existing `memory_books` row was created for exactly this
 * scope option (same kind + frozen window). */
export function memoryBookMatchesScope(
  book: { scope_kind: string; scope_start_date: string | null; scope_end_date: string | null },
  option: MemoryBookScopeOption,
): boolean {
  return (
    book.scope_kind === option.kind &&
    book.scope_start_date === option.startDate &&
    book.scope_end_date === option.endDate
  );
}

/**
 * Copy shape locked by the design brief: "12 memories in this period —
 * books need about 30". Returns null (no disabling reason) once the count
 * reaches the threshold.
 */
export function thinPeriodReason(eligibleCount: number): string | null {
  if (eligibleCount >= MEMORY_BOOK_THIN_THRESHOLD) return null;
  const noun = eligibleCount === 1 ? 'memory' : 'memories';
  return `${eligibleCount} ${noun} in this period — books need about ${MEMORY_BOOK_THIN_THRESHOLD}`;
}
