// Date math for `analyze-memory`'s structured context block and deterministic
// date-aware rules (docs/plans/memory-book.md §5 Stage A). Ported from
// `supabase/scripts/eval-memory-book-tagging.ts` (the V1 eval harness this
// production module supersedes) -- pure integer/string arithmetic throughout,
// deliberately never round-tripping through a `Date` object: `new
// Date('YYYY-MM-DDT00:00:00')` parses in local time but `toISOString()`
// renders in UTC, so on a UTC-positive machine a sliced result can silently
// land on the previous day. Everything here works in exact whole days via
// Julian Day Numbers instead.
import { getAgeInYearsAtDate } from './age.ts';
import { getTopicById, type TopicDateGate } from './memory-topics.ts';

export function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(`Unexpected date format "${dateStr}"`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * Adds `years` to a `YYYY-MM-DD` date string without ever round-tripping
 * through a `Date` object (see module header). Clamps Feb 29 to Feb 28 in a
 * non-leap target year.
 */
export function addYears(dateStr: string, years: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const newYear = year + years;

  const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const clampedDay = month === 2 && day === 29 && !isLeapYear(newYear) ? 28 : day;

  return `${pad4(newYear)}-${pad2(month)}-${pad2(clampedDay)}`;
}

/**
 * Gregorian calendar date -> Julian Day Number, via the standard integer
 * formula (Fliegel & Van Flandern). Lets every date-distance calculation
 * below work in exact whole days with no timezone exposure at all.
 */
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

/** 0=Sunday .. 6=Saturday, derived from the JDN (verified against known
 * reference date 2000-01-01 = Saturday). */
function dayOfWeek(dateStr: string): number {
  return (toJulianDayNumber(dateStr) + 1) % 7;
}

/** The date of the n-th occurrence of `weekday` (0=Sunday..6=Saturday) in a
 * given month/year -- used for Thanksgiving (4th Thursday of November) and
 * Mother's/Father's Day (2nd Sunday of May / 3rd Sunday of June). */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  const firstOfMonth = `${pad4(year)}-${pad2(month)}-01`;
  const firstDow = dayOfWeek(firstOfMonth);
  const dayOffset = (weekday - firstDow + 7) % 7;
  const day = 1 + dayOffset + (n - 1) * 7;
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Age in whole months at `referenceDate`, pure calendar arithmetic (no Date
 * object). Returns null if `referenceDate` is before `dateOfBirth`. Used to
 * filter the milestone catalog to in-band entries (memory-milestones.ts).
 */
export function ageInMonthsAtDate(dateOfBirth: string, referenceDate: string): number | null {
  const birth = parseDateParts(dateOfBirth);
  const ref = parseDateParts(referenceDate);
  let months = (ref.year - birth.year) * 12 + (ref.month - birth.month);
  if (ref.day < birth.day) {
    months -= 1;
  }
  return months < 0 ? null : months;
}

export function classifyChildOrAdult(ageYears: number | null): 'child' | 'adult' | 'unknown' {
  if (ageYears === null) {
    return 'unknown';
  }
  return ageYears < 13 ? 'child' : 'adult';
}

interface NearestBirthday {
  date: string;
  diffDays: number;
}

/** The birthday anniversary (in the year before/of/after `referenceDate`)
 * closest to `referenceDate`, with a signed day distance (positive = still
 * to come, negative = already passed). */
function nearestBirthdayAnniversary(dateOfBirth: string, referenceDate: string): NearestBirthday {
  const birthYear = parseDateParts(dateOfBirth).year;
  const refYear = parseDateParts(referenceDate).year;
  const refJdn = toJulianDayNumber(referenceDate);

  let best: NearestBirthday | null = null;
  for (const candidateYear of [refYear - 1, refYear, refYear + 1]) {
    const anniversary = addYears(dateOfBirth, candidateYear - birthYear);
    const diffDays = toJulianDayNumber(anniversary) - refJdn;
    if (!best || Math.abs(diffDays) < Math.abs(best.diffDays)) {
      best = { date: anniversary, diffDays };
    }
  }
  return best!;
}

/** Signed distance in days from `referenceDate` to the tagged member's
 * nearest birthday anniversary (plan §5 Stage A structured context). */
export function daysToBirthday(dateOfBirth: string, referenceDate: string): number {
  return nearestBirthdayAnniversary(dateOfBirth, referenceDate).diffDays;
}

export interface BirthdayMatchMember {
  id: string;
  name: string;
  dateOfBirth: string | null;
}

export interface BirthdayMatch {
  memberId: string;
  memberName: string;
  ageTurned: number;
  /** Signed: memory_date minus the anniversary date (positive = memory is
   * after the anniversary, negative = before it). */
  daysOffset: number;
}

export interface BirthMatch {
  memberId: string;
  memberName: string;
  /** Signed: memory_date minus the actual date_of_birth. */
  daysFromBirth: number;
}

export interface BirthdayMatchResult {
  birthdayMatch: BirthdayMatch | null;
  birthMatch: BirthMatch | null;
}

/**
 * Deterministic whose-birthday resolution (plan §5: "never guessed by the
 * model"): any tagged member whose birthday anniversary falls within
 * `windowDays` of `memoryDate` is a candidate. A candidate whose nearest
 * anniversary IS the birth itself (ageTurned < 1 -- the anniversary year
 * equals or precedes the birth year) is a "birth" memory, not a birthday,
 * and is reported separately as `birthMatch` (newborn-week memories say
 * "birth", not "1st birthday"). Within each of the two buckets, when more
 * than one member matches (rare -- twins, or two members close in the
 * window), the closest anniversary wins; ties break on member id for
 * determinism.
 */
export function computeBirthdayMatch(
  members: BirthdayMatchMember[],
  memoryDate: string,
  windowDays = 7,
): BirthdayMatchResult {
  let bestBirthday: (BirthdayMatch & { diffDays: number }) | null = null;
  let bestBirth: (BirthMatch & { diffDays: number }) | null = null;

  for (const member of members) {
    if (!member.dateOfBirth) continue;

    const nearest = nearestBirthdayAnniversary(member.dateOfBirth, memoryDate);
    if (Math.abs(nearest.diffDays) > windowDays) continue;

    const ageTurned = parseDateParts(nearest.date).year - parseDateParts(member.dateOfBirth).year;
    const absDiff = Math.abs(nearest.diffDays);

    if (ageTurned < 1) {
      if (
        !bestBirth ||
        absDiff < Math.abs(bestBirth.diffDays) ||
        (absDiff === Math.abs(bestBirth.diffDays) && member.id < bestBirth.memberId)
      ) {
        bestBirth = {
          memberId: member.id,
          memberName: member.name,
          diffDays: nearest.diffDays,
          daysFromBirth: -nearest.diffDays,
        };
      }
      continue;
    }

    if (
      !bestBirthday ||
      absDiff < Math.abs(bestBirthday.diffDays) ||
      (absDiff === Math.abs(bestBirthday.diffDays) && member.id < bestBirthday.memberId)
    ) {
      bestBirthday = {
        memberId: member.id,
        memberName: member.name,
        ageTurned,
        diffDays: nearest.diffDays,
        daysOffset: -nearest.diffDays,
      };
    }
  }

  return {
    birthdayMatch: bestBirthday
      ? { memberId: bestBirthday.memberId, memberName: bestBirthday.memberName, ageTurned: bestBirthday.ageTurned, daysOffset: bestBirthday.daysOffset }
      : null,
    birthMatch: bestBirth
      ? { memberId: bestBirth.memberId, memberName: bestBirth.memberName, daysFromBirth: bestBirth.daysFromBirth }
      : null,
  };
}

export interface NearbyHoliday {
  name: string;
  date: string;
  daysAway: number;
}

const FIXED_HOLIDAYS: Array<{ name: string; month: number; day: number }> = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: "Valentine's Day", month: 2, day: 14 },
  { name: 'Halloween', month: 10, day: 31 },
  { name: 'Christmas', month: 12, day: 25 },
  { name: "New Year's Eve", month: 12, day: 31 },
];

/**
 * Holidays within `windowDays` of `memoryDate` (plan §5 structured context
 * "proximity to major holidays"). Easter, Mother's Day, and Father's Day are
 * deliberately omitted (movable/ambiguous for a quick display line -- the
 * precise per-topic date gate lives in memory-topics.ts / isDateWithinGate,
 * not here). Thanksgiving (US, 4th Thursday of November) is computed via
 * nthWeekdayOfMonth rather than a fixed day-of-month.
 */
export function nearbyHolidays(memoryDate: string, windowDays = 10): NearbyHoliday[] {
  const { year } = parseDateParts(memoryDate);
  const refJdn = toJulianDayNumber(memoryDate);
  const results: NearbyHoliday[] = [];

  for (const candidateYear of [year - 1, year, year + 1]) {
    for (const holiday of FIXED_HOLIDAYS) {
      const dateStr = `${pad4(candidateYear)}-${pad2(holiday.month)}-${pad2(holiday.day)}`;
      const daysAway = toJulianDayNumber(dateStr) - refJdn;
      if (Math.abs(daysAway) <= windowDays) {
        results.push({ name: holiday.name, date: dateStr, daysAway });
      }
    }

    const thanksgiving = nthWeekdayOfMonth(candidateYear, 11, 4, 4);
    const thanksgivingDaysAway = toJulianDayNumber(thanksgiving) - refJdn;
    if (Math.abs(thanksgivingDaysAway) <= windowDays) {
      results.push({ name: 'Thanksgiving (US)', date: thanksgiving, daysAway: thanksgivingDaysAway });
    }
  }

  results.sort((a, b) => Math.abs(a.daysAway) - Math.abs(b.daysAway));
  return results;
}

// ── Structured per-memory context (plan §5: "memory date, tagged members
// with their ages on that date, days-to-birthday for each tagged member,
// and proximity to major holidays") ─────────────────────────────────────

export interface MemberContext {
  memberId: string;
  firstName: string;
  ageYears: number | null;
  ageMonths: number | null;
  personType: 'child' | 'adult' | 'unknown';
  daysToBirthday: number | null;
}

export interface MemoryContext {
  memoryDate: string;
  members: MemberContext[];
  holidays: NearbyHoliday[];
}

export interface FamilyMemberForContext {
  id: string;
  name: string;
  dateOfBirth: string | null;
}

export function buildMemoryContext(
  memoryDate: string,
  taggedMembers: FamilyMemberForContext[],
): MemoryContext {
  const members: MemberContext[] = taggedMembers.map((member) => {
    const ageYears = member.dateOfBirth ? getAgeInYearsAtDate(member.dateOfBirth, memoryDate) : null;
    const ageMonths = member.dateOfBirth ? ageInMonthsAtDate(member.dateOfBirth, memoryDate) : null;

    return {
      memberId: member.id,
      firstName: member.name.trim().split(/\s+/)[0] || member.name,
      ageYears,
      ageMonths,
      personType: classifyChildOrAdult(ageYears),
      daysToBirthday: member.dateOfBirth ? daysToBirthday(member.dateOfBirth, memoryDate) : null,
    };
  });

  return { memoryDate, members, holidays: nearbyHolidays(memoryDate) };
}

function describeDaysToBirthday(days: number): string {
  if (days === 0) return 'birthday today';
  if (days > 0) return `birthday in ${days}d`;
  return `birthday ${Math.abs(days)}d ago`;
}

/** Renders `MemoryContext` as the plain-text structured context block that
 * opens the user message sent to the model. */
export function formatMemoryContextForPrompt(context: MemoryContext): string {
  const lines: string[] = [];
  lines.push(`Entry date: ${context.memoryDate}`);

  if (context.members.length > 0) {
    lines.push('Tagged people:');
    for (const member of context.members) {
      const ageDesc =
        member.ageYears === null
          ? 'age unknown'
          : member.ageMonths !== null && member.ageMonths < 24
            ? `${member.ageYears}y (${member.ageMonths} months)`
            : `${member.ageYears}y`;
      const birthdayDesc = member.daysToBirthday === null ? '' : `, ${describeDaysToBirthday(member.daysToBirthday)}`;
      lines.push(`- ${member.firstName}: ${ageDesc}, ${member.personType}${birthdayDesc}`);
    }
  } else {
    lines.push('Tagged people: none');
  }

  if (context.holidays.length > 0) {
    const holidayDesc = context.holidays
      .map((h) => `${h.name} (${h.daysAway >= 0 ? `in ${h.daysAway}d` : `${Math.abs(h.daysAway)}d ago`})`)
      .join(', ');
    lines.push(`Nearby holidays: ${holidayDesc}`);
  } else {
    lines.push('Nearby holidays: none');
  }

  return lines.join('\n');
}

// ── Topic date gating (applied in code, never trusted from the model --
// docs/plans/topic-vocabulary.md "Date gating for occasions") ──────────

function monthDayString(month: number, day: number): string {
  return `${pad2(month)}-${pad2(day)}`;
}

/** Whether month-day `md` falls in [start, end], where start > end means the
 * window wraps the year boundary. */
function isMonthDayInRange(md: string, start: string, end: string): boolean {
  if (start <= end) {
    return md >= start && md <= end;
  }
  return md >= start || md <= end;
}

function isWithinDaysOfAny(memoryDate: string, candidates: string[], windowDays: number): boolean {
  const refJdn = toJulianDayNumber(memoryDate);
  return candidates.some((candidate) => Math.abs(toJulianDayNumber(candidate) - refJdn) <= windowDays);
}

/**
 * Whether `memoryDate` is calendar-plausible for a topic's `dateGate`.
 * Returns `true` for `{type:'none'}` (nothing to check). Exported for direct
 * unit testing independent of `gateTopicsByDate`.
 */
export function isDateWithinGate(gate: TopicDateGate, memoryDate: string): boolean {
  const { year, month, day } = parseDateParts(memoryDate);

  switch (gate.type) {
    case 'none':
      return true;
    case 'fixed':
      return isMonthDayInRange(monthDayString(month, day), gate.startMonthDay, gate.endMonthDay);
    case 'thanksgiving':
      // 4th Thursday of November -- only ever near the boundary of its own
      // year (late Nov +/- 7 days never reaches January), so a single year's
      // computed date is enough.
      return isWithinDaysOfAny(memoryDate, [nthWeekdayOfMonth(year, 11, 4, 4)], 7);
    case 'mothers-fathers-day': {
      const mothersDay = nthWeekdayOfMonth(year, 5, 0, 2); // 2nd Sunday of May
      const fathersDay = nthWeekdayOfMonth(year, 6, 0, 3); // 3rd Sunday of June
      return isWithinDaysOfAny(memoryDate, [mothersDay, fathersDay], 7);
    }
    case 'movable': {
      const candidateDate = gate.datesByYear[year];
      if (!candidateDate) return false; // Outside the table -- fail closed.
      return isWithinDaysOfAny(memoryDate, [candidateDate], 10);
    }
    default:
      return true;
  }
}

/**
 * Removes any date-gated topic whose window doesn't cover `memoryDate`,
 * recording the removed ids in `dateGated`. Generic over any `{id: string}`
 * shape so this module has no dependency on how the caller represents a
 * parsed topic assignment (analyze-memory-core.ts owns that type).
 */
export function gateTopicsByDate<T extends { id: string }>(
  topics: T[],
  memoryDate: string,
): { topics: T[]; dateGated: string[] } {
  const surviving: T[] = [];
  const dateGated: string[] = [];

  for (const topic of topics) {
    const definition = getTopicById(topic.id);
    const gate: TopicDateGate = definition?.dateGate ?? { type: 'none' };

    if (isDateWithinGate(gate, memoryDate)) {
      surviving.push(topic);
    } else {
      dateGated.push(topic.id);
    }
  }

  return { topics: surviving, dateGated };
}
