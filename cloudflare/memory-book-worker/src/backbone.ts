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

export function buildBackboneSegments(
  memories: BackboneMemoryInput[],
  minPrintablePerSegment = 3,
): BackboneSegment[] {
  const byMonth = new Map<string, BackboneMemoryInput[]>();
  for (const memory of memories) {
    const key = memory.date.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    list.push(memory);
    byMonth.set(key, list);
  }

  const monthKeys = [...byMonth.keys()].sort();
  const segments: BackboneSegment[] = [];

  let pendingMonths: string[] = [];
  let pendingIds: string[] = [];
  let pendingPrintable = 0;

  for (const key of monthKeys) {
    const bucket = byMonth.get(key)!;
    pendingMonths.push(key);
    pendingIds.push(...bucket.map((m) => m.id));
    pendingPrintable += bucket.filter((m) => m.printable).length;

    if (pendingPrintable >= minPrintablePerSegment) {
      segments.push({
        id: pendingMonths.join('_'),
        label: formatMonthRangeLabel(pendingMonths),
        monthKeys: pendingMonths,
        memoryIds: pendingIds,
      });
      pendingMonths = [];
      pendingIds = [];
      pendingPrintable = 0;
    }
  }

  if (pendingMonths.length > 0) {
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      last.monthKeys.push(...pendingMonths);
      last.memoryIds.push(...pendingIds);
      last.id = last.monthKeys.join('_');
      last.label = formatMonthRangeLabel(last.monthKeys);
    } else {
      segments.push({
        id: pendingMonths.join('_'),
        label: formatMonthRangeLabel(pendingMonths),
        monthKeys: pendingMonths,
        memoryIds: pendingIds,
      });
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
