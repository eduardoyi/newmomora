/**
 * Age-year chapter boundaries for multi-year ("everything") books --
 * docs/plans/memory-book-everything-phase2.md §2.2 ("Chapter boundaries,
 * month-aligned"). Pure and deterministic: no env, no IO, no clock. Not yet
 * wired into backbone.ts / reading-order.ts / outline.ts (WP-B1 does that).
 *
 * Boundaries are MONTH-aligned so each calendar month belongs to exactly one
 * chapter (the fitter's month floor, the age-eyebrow code and the audit are
 * all keyed by calendar month). The month containing the Nth birthday is the
 * LAST month of chapter N ("the month you turned N"); chapter 1 therefore
 * runs from the birth month through the first-birthday month.
 *
 * `chapter.startMonth/endMonth` are THEORETICAL (derived from the DOB, not
 * clipped to the window or to the months that actually hold memories) --
 * the fitter uses them for assignment. A chapter's printed subtitle comes
 * from its actual content months (see backbone.ts `formatMonthRangeLabel`).
 *
 * Month keys are `YYYY-MM`; lexicographic comparison is chronological.
 */
import { addYears } from '../../../supabase/functions/_shared/date-context.ts';

export interface AgeYearChapter {
  /** 1-based age-year number; chapter N ends in the month of the Nth birthday. */
  ageYear: number;
  /** First month of the chapter (`YYYY-MM`), inclusive. */
  startMonth: string;
  /** Last month of the chapter (`YYYY-MM`), inclusive -- the Nth-birthday month. */
  endMonth: string;
}

/** A book needs at least this many non-empty chapters to use chapter mode. */
export const MIN_CHAPTERS_FOR_CHAPTER_MODE = 2;

/** Safety bound for the chapter loop (a person's age-years). */
const MAX_AGE_YEARS = 130;

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function nextMonth(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (month === 12) return `${String(year + 1).padStart(4, '0')}-01`;
  return `${monthKey.slice(0, 4)}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * Chapters (one per age-year) that overlap `[firstMonth, lastMonth]`,
 * ordered by `ageYear`. Chapters that end before `firstMonth` are skipped
 * (their `ageYear` numbering is preserved on the ones that remain); the
 * chapter containing `firstMonth` keeps its theoretical (un-clipped) bounds.
 * Returns `[]` for a missing/invalid DOB, an invalid month key, or an
 * inverted range -- "no DOB -> no chapters".
 */
export function computeAgeYearChapters(
  dob: string | null | undefined,
  firstMonth: string,
  lastMonth: string,
): AgeYearChapter[] {
  if (!dob || !DATE_PATTERN.test(dob)) return [];
  if (!MONTH_KEY_PATTERN.test(firstMonth) || !MONTH_KEY_PATTERN.test(lastMonth)) return [];
  if (firstMonth > lastMonth) return [];

  const chapters: AgeYearChapter[] = [];
  let startMonth = dob.slice(0, 7);
  for (let ageYear = 1; ageYear <= MAX_AGE_YEARS; ageYear++) {
    if (startMonth > lastMonth) break;
    const endMonth = addYears(dob, ageYear).slice(0, 7);
    if (endMonth >= firstMonth) chapters.push({ ageYear, startMonth, endMonth });
    startMonth = nextMonth(endMonth);
  }
  return chapters;
}

/**
 * Index (into `chapters`, NOT the age-year) of the chapter a month belongs
 * to: the last chapter whose `startMonth <= month`. Months before the first
 * chapter (e.g. memories dated before the DOB) clamp to index 0; months past
 * the last chapter clamp to the last index. `-1` only when `chapters` is
 * empty.
 */
export function chapterIndexOfMonth(chapters: readonly AgeYearChapter[], month: string): number {
  if (chapters.length === 0) return -1;
  let index = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].startMonth <= month) index = i;
    else break;
  }
  return index;
}

/**
 * Drops chapters that hold none of `monthKeys` (the eligible printable
 * months, `YYYY-MM`). Each month is assigned with `chapterIndexOfMonth`, so
 * a pre-DOB month counts toward the first chapter. Order is preserved.
 */
export function dropEmptyChapters(
  chapters: readonly AgeYearChapter[],
  monthKeys: Iterable<string>,
): AgeYearChapter[] {
  if (chapters.length === 0) return [];
  const occupied = new Set<number>();
  for (const month of monthKeys) occupied.add(chapterIndexOfMonth(chapters, month));
  return chapters.filter((_, index) => occupied.has(index));
}

/** Chapter mode = at least two non-empty chapters. Pass the chapters AFTER
 * `dropEmptyChapters`. */
export function isChapterMode(nonEmptyChapters: readonly AgeYearChapter[]): boolean {
  return nonEmptyChapters.length >= MIN_CHAPTERS_FOR_CHAPTER_MODE;
}

/**
 * Convenience for the wiring package: compute, drop empties, and apply the
 * chapter-mode rule in one call. Returns `[]` (chapter mode OFF -- legacy
 * structure) when there is no DOB, no months, or fewer than two non-empty
 * chapters remain; otherwise the non-empty chapters. `printableMonthKeys`
 * are the months with eligible printable memories; first/last are their
 * min/max.
 */
export function resolveChapters(
  dob: string | null | undefined,
  printableMonthKeys: Iterable<string>,
): AgeYearChapter[] {
  const months = [...new Set(printableMonthKeys)].sort();
  if (months.length === 0) return [];
  const chapters = computeAgeYearChapters(dob, months[0], months[months.length - 1]);
  const nonEmpty = dropEmptyChapters(chapters, months);
  return isChapterMode(nonEmpty) ? nonEmpty : [];
}

/**
 * Deterministic birthday flags from the DOB (spec §2.2 "Birthday and birth
 * flags"): `month(addYears(dob, a)) -> a` for every birthday (a >= 1) whose
 * DATE falls in `[windowStart, windowEndExclusive)`. Feeds
 * `flagSpecialBackboneSegments`. Empty for a missing/invalid DOB or window.
 * (The birth month itself is flagged separately as `kind: 'birth'`.)
 */
export function computeBirthdayMonthsFromDob(
  dob: string | null | undefined,
  windowStart: string,
  windowEndExclusive: string,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!dob || !DATE_PATTERN.test(dob)) return map;
  if (!DATE_PATTERN.test(windowStart) || !DATE_PATTERN.test(windowEndExclusive)) return map;
  for (let age = 1; age <= MAX_AGE_YEARS; age++) {
    const birthday = addYears(dob, age);
    if (birthday >= windowEndExclusive) break;
    if (birthday >= windowStart) map.set(birthday.slice(0, 7), age);
  }
  return map;
}
