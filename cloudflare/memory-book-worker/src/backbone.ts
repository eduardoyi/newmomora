/**
 * Chronological backbone segmentation + birth/birthday special-title
 * flagging, ported from supabase/scripts/eval-memory-book-outline.ts
 * (buildBackboneSegments, formatMonthRangeLabel, flagSpecialBackboneSegments,
 * computeAgeYearBirthdayMonths, buildSpecialSegmentTitlesByMonth,
 * suppressSurvivingBirthdaySpecialTitles). See eligibility.ts's header
 * comment for why this is a faithful duplicate rather than a `_shared/`
 * extraction.
 */
import type { BackboneSegment, SpecialSegmentFlag } from '../../../supabase/functions/_shared/memory-book-outline.ts';

export interface BackboneMemoryInput {
  id: string;
  date: string;
  printable: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatMonthRangeLabel(monthKeys: string[]): string {
  const first = monthKeys[0];
  const last = monthKeys[monthKeys.length - 1];
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);

  if (first === last) return `${MONTH_NAMES[fm - 1]} ${fy}`;
  if (fy === ly) return `${MONTH_NAMES[fm - 1]}–${MONTH_NAMES[lm - 1]} ${fy}`;
  return `${MONTH_NAMES[fm - 1]} ${fy} – ${MONTH_NAMES[lm - 1]} ${ly}`;
}

export interface BackboneOptions {
  /** Hard cap on a segment's CALENDAR span (last month - first month + 1;
   * empty months inside the span count). Wins over `minPrintablePerSegment`:
   * a segment is flushed at the cap even when it holds fewer printable
   * memories than the minimum, and the trailing-tail fold never exceeds it.
   * Default: no cap (single-year behaviour). Everything books pass 3. */
  maxSpanMonths?: number;
  /** Maps a month key to its chapter index (into the book's chapters array).
   * When set, segments never cross a chapter boundary (the merge loop and the
   * tail fold both run per chapter) and each segment carries `chapterIndex`.
   * Must be non-decreasing in the month key. */
  chapterOfMonth?: (monthKey: string) => number;
}

function monthOrdinal(monthKey: string): number {
  return Number(monthKey.slice(0, 4)) * 12 + Number(monthKey.slice(5, 7)) - 1;
}

/** Calendar span in months, inclusive of both ends. */
function spanMonths(firstMonth: string, lastMonth: string): number {
  return monthOrdinal(lastMonth) - monthOrdinal(firstMonth) + 1;
}

export function buildBackboneSegments(
  memories: BackboneMemoryInput[],
  minPrintablePerSegment = 3,
  options: BackboneOptions = {},
): BackboneSegment[] {
  const maxSpan = options.maxSpanMonths ?? Infinity;
  const chapterOfMonth = options.chapterOfMonth;

  const byMonth = new Map<string, BackboneMemoryInput[]>();
  for (const memory of memories) {
    const key = memory.date.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    list.push(memory);
    byMonth.set(key, list);
  }

  const monthKeys = [...byMonth.keys()].sort();

  // Consecutive months sharing a chapter form one group; without a chapter
  // function there is a single group (the legacy whole-scope loop).
  const groups: Array<{ chapterIndex: number | undefined; months: string[] }> = [];
  for (const key of monthKeys) {
    const chapterIndex = chapterOfMonth ? chapterOfMonth(key) : undefined;
    const current = groups[groups.length - 1];
    if (current && current.chapterIndex === chapterIndex) current.months.push(key);
    else groups.push({ chapterIndex, months: [key] });
  }

  const segments: BackboneSegment[] = [];

  const makeSegment = (months: string[], ids: string[], chapterIndex: number | undefined): BackboneSegment => ({
    id: months.join('_'),
    label: formatMonthRangeLabel(months),
    monthKeys: months,
    memoryIds: ids,
    ...(chapterIndex !== undefined ? { chapterIndex } : {}),
  });

  for (const group of groups) {
    const groupFirstSegment = segments.length;
    let pendingMonths: string[] = [];
    let pendingIds: string[] = [];
    let pendingPrintable = 0;

    const flush = () => {
      segments.push(makeSegment(pendingMonths, pendingIds, group.chapterIndex));
      pendingMonths = [];
      pendingIds = [];
      pendingPrintable = 0;
    };

    for (const key of group.months) {
      // The cap wins over the printable minimum: adding this month would
      // stretch the pending segment past the cap, so close it first.
      if (pendingMonths.length > 0 && spanMonths(pendingMonths[0], key) > maxSpan) flush();

      const bucket = byMonth.get(key)!;
      pendingMonths.push(key);
      pendingIds.push(...bucket.map((m) => m.id));
      pendingPrintable += bucket.filter((m) => m.printable).length;

      if (pendingPrintable >= minPrintablePerSegment) flush();
    }

    if (pendingMonths.length > 0) {
      const last = segments.length > groupFirstSegment ? segments[segments.length - 1] : null;
      const tailLast = pendingMonths[pendingMonths.length - 1];
      if (last && spanMonths(last.monthKeys[0], tailLast) <= maxSpan) {
        last.monthKeys.push(...pendingMonths);
        last.memoryIds.push(...pendingIds);
        last.id = last.monthKeys.join('_');
        last.label = formatMonthRangeLabel(last.monthKeys);
      } else {
        flush();
      }
    }
  }

  return segments;
}

export function flagSpecialBackboneSegments(
  segments: BackboneSegment[],
  birthMonth: string | null,
  birthdayMonthToAge: Map<string, number>,
): SpecialSegmentFlag[] {
  const flags: SpecialSegmentFlag[] = [];
  for (const segment of segments) {
    for (const month of segment.monthKeys) {
      if (birthMonth && month === birthMonth) {
        flags.push({ segmentId: segment.id, month, kind: 'birth' });
        continue;
      }
      const ageTurned = birthdayMonthToAge.get(month);
      if (ageTurned !== undefined) {
        flags.push({ segmentId: segment.id, month, kind: 'birthday', ageTurned });
      }
    }
  }
  return flags;
}

/**
 * Age-year scope ONLY: the window's own boundaries determine both flagged
 * months deterministically from the child's date_of_birth -- never from
 * whether a birthday-milestone memory happens to exist (see the eval CLI's
 * own header comment on this function for the two bugs that fixes). `null`
 * for every other scope kind (birthday flags there come from real
 * `birthday`-milestone memories instead -- see backbone-input.ts).
 */
export function computeAgeYearBirthdayMonths(
  isAgeYearScope: boolean,
  ageYear: number,
  windowStart: string,
  windowEndExclusive: string,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!isAgeYearScope) return map;
  if (ageYear - 1 >= 1) {
    map.set(windowStart.slice(0, 7), ageYear - 1);
  }
  map.set(windowEndExclusive.slice(0, 7), ageYear);
  return map;
}

export function buildSpecialSegmentTitlesByMonth(
  originalFlags: SpecialSegmentFlag[],
  aiTitlesBySegmentId: Record<string, string>,
): Map<string, string> {
  const byMonth = new Map<string, string>();
  for (const flag of originalFlags) {
    const title = aiTitlesBySegmentId[flag.segmentId];
    if (title && title.trim()) byMonth.set(flag.month, title.trim());
  }
  return byMonth;
}

export function suppressSurvivingBirthdaySpecialTitles(
  flags: SpecialSegmentFlag[],
  survivingBirthdayAges: ReadonlySet<number>,
): SpecialSegmentFlag[] {
  return flags.filter((flag) => !(flag.kind === 'birthday' && survivingBirthdayAges.has(flag.ageTurned!)));
}
