import { parseIsoDate, toIsoDate } from '@/utils/dates';

export interface CalendarDay {
  dow: string;
  n: number;
  iso: string;
  today: boolean;
}

export interface CalendarWeek {
  index: number;
  label: string;
  rangeLabel: string;
  monthBreak: string | null;
  startIso: string;
  endIso: string;
  days: CalendarDay[];
}

export interface CalendarVisibleWeekRange {
  startIndex: number;
  endIndex: number;
}

export interface CalendarFetchRange {
  startDate: string;
  endDate: string;
}

export interface CalendarMonthOption {
  year: number;
  month: number; // 0-11, JS Date convention
  label: string;
  iso: string; // first-of-month ISO date; stable list key
  isCurrent: boolean;
}

interface BuildCalendarWeeksInput {
  referenceDate?: Date;
  oldestMemoryDate?: string | null;
  minimumWeeks?: number;
}

function startOfMondayWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const dayOfWeek = start.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  start.setDate(start.getDate() - daysSinceMonday);

  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function calendarDaySerial(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function daysBetween(start: Date, end: Date): number {
  return calendarDaySerial(end) - calendarDaySerial(start);
}

function getWeekLabel(index: number): string {
  if (index === 0) {
    return 'this week';
  }

  if (index === 1) {
    return 'last week';
  }

  return `${index} weeks ago`;
}

function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Label for an inline month-break divider. Current-year months stay bare
 * ("July") to keep nearby dividers quiet; once a break crosses into a
 * different year than `referenceDate`, the year is included ("July 2024")
 * so a divider 100+ weeks back is never ambiguous. The always-with-year
 * header eyebrow (getVisibleMonthLabel) is intentionally NOT subject to
 * this rule -- it is the persistent "where am I" anchor.
 */
export function formatMonthBreakLabel(date: Date, referenceDate: Date): string {
  if (date.getFullYear() === referenceDate.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'long' });
  }

  return formatMonthYear(date);
}

function getWeekRangeLabel(startDate: Date, endDate: Date): string {
  const startMonth = startDate.toLocaleDateString('en-US', { month: 'short' });
  const endMonth = endDate.toLocaleDateString('en-US', { month: 'short' });

  if (startDate.getMonth() !== endDate.getMonth() || startDate.getFullYear() !== endDate.getFullYear()) {
    return `${startMonth} ${startDate.getDate()} – ${endMonth} ${endDate.getDate()}`;
  }

  if (startDate.getDate() === endDate.getDate()) {
    return `${startMonth} ${startDate.getDate()}`;
  }

  return `${startMonth} ${startDate.getDate()}–${endDate.getDate()}`;
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
}

export function buildCalendarWeeks({
  referenceDate = new Date(),
  oldestMemoryDate,
  minimumWeeks = 4,
}: BuildCalendarWeeksInput = {}): CalendarWeek[] {
  const currentWeekStart = startOfMondayWeek(referenceDate);
  const parsedOldestDate = oldestMemoryDate ? parseIsoDate(oldestMemoryDate) : null;
  const oldestWeekStart = parsedOldestDate ? startOfMondayWeek(parsedOldestDate) : currentWeekStart;
  const weekDistance = Math.max(0, Math.floor(daysBetween(oldestWeekStart, currentWeekStart) / 7));
  const totalWeeks = Math.max(minimumWeeks, weekDistance + 1);
  const todayIso = toIsoDate(referenceDate);

  return Array.from({ length: totalWeeks }, (_, index) => {
    const startDate = addDays(currentWeekStart, -index * 7);
    const endDate = index === 0 ? referenceDate : addDays(startDate, 6);
    const dayCount = daysBetween(startDate, endDate) + 1;
    const days: CalendarDay[] = [];

    for (let dayOffset = dayCount - 1; dayOffset >= 0; dayOffset -= 1) {
      const date = addDays(startDate, dayOffset);
      const iso = toIsoDate(date);

      days.push({
        dow: date.toLocaleDateString('en-US', { weekday: 'short' }),
        n: date.getDate(),
        iso,
        today: iso === todayIso,
      });
    }

    // A week belongs to the month of its newest day; a break marks the first
    // week whose newest day falls in an older month than the week above it.
    const previousWeekEnd = index === 0
      ? null
      : index === 1
        ? referenceDate
        : addDays(addDays(currentWeekStart, -(index - 1) * 7), 6);

    return {
      index,
      label: getWeekLabel(index),
      rangeLabel: getWeekRangeLabel(startDate, endDate),
      monthBreak: previousWeekEnd && !isSameMonth(previousWeekEnd, endDate)
        ? formatMonthBreakLabel(endDate, referenceDate)
        : null,
      startIso: toIsoDate(startDate),
      endIso: toIsoDate(endDate),
      days,
    };
  });
}

export function getCalendarFetchRange(
  weeks: CalendarWeek[],
  visibleRange: CalendarVisibleWeekRange,
  bufferWeeks = 4,
): CalendarFetchRange | null {
  if (weeks.length === 0) {
    return null;
  }

  const firstVisible = Math.min(visibleRange.startIndex, visibleRange.endIndex);
  const lastVisible = Math.max(visibleRange.startIndex, visibleRange.endIndex);
  const firstIndex = Math.max(0, firstVisible - bufferWeeks);
  const lastIndex = Math.min(weeks.length - 1, lastVisible + bufferWeeks);

  return {
    startDate: weeks[lastIndex].startIso,
    endDate: weeks[firstIndex].endIso,
  };
}

/**
 * Months selectable in the calendar's month-jump picker, from the current
 * month back to the month containing `oldestMemoryDate` (inclusive), newest
 * first. With no memories yet (`oldestMemoryDate` null/undefined) this
 * returns a single entry -- the current month -- so callers can disable the
 * jump trigger rather than show a picker with nothing to jump to.
 */
export function getCalendarMonthOptions(
  referenceDate: Date,
  oldestMemoryDate?: string | null,
): CalendarMonthOption[] {
  const currentYear = referenceDate.getFullYear();
  const currentMonth = referenceDate.getMonth();

  const parsedOldest = oldestMemoryDate ? parseIsoDate(oldestMemoryDate) : null;
  const oldestYear = parsedOldest ? parsedOldest.getFullYear() : currentYear;
  const oldestMonth = parsedOldest ? parsedOldest.getMonth() : currentMonth;

  const options: CalendarMonthOption[] = [];
  let year = currentYear;
  let month = currentMonth;

  while (year > oldestYear || (year === oldestYear && month >= oldestMonth)) {
    const cursor = new Date(year, month, 1);

    options.push({
      year,
      month,
      label: cursor.toLocaleDateString('en-US', { month: 'long' }),
      iso: toIsoDate(cursor),
      isCurrent: year === currentYear && month === currentMonth,
    });

    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }

  return options;
}

/**
 * Row index (into the `weeks` array from buildCalendarWeeks) of the NEWEST
 * week belonging to the target month -- the first week in list order whose
 * newest day falls inside that month, per the same "a week belongs to the
 * month of its newest day" rule buildCalendarWeeks uses. That is exactly the
 * row where the target month's divider renders, so landing there with
 * `viewPosition: 0` puts the divider at the top of the viewport and the
 * entire selected month below it. In this reverse-chronological ribbon
 * that's what "jump to <month>" means: the week containing the 1st is the
 * month's OLDEST week, and landing there would show the previous month's
 * rows directly beneath. Selecting the current month resolves to index 0.
 *
 * Computed as one week older than the week containing the 1st of the
 * FOLLOWING month: that week always belongs to the following month (its
 * newest day is on or after the 1st), so the week just before it is the
 * newest week whose newest day is still inside the target month. Because
 * the newest week of a month is never older than the week of any date in
 * that month, every month offered by getCalendarMonthOptions (bounded by
 * the oldest memory date) resolves to an index inside the built weeks
 * array -- callers keep a defensive clamp regardless.
 */
export function getMonthJumpWeekIndex(
  referenceDate: Date,
  targetYear: number,
  targetMonth: number,
): number {
  // Current month: week 0's newest day is `referenceDate` itself, so the
  // current week always belongs to the current month even when its Sunday
  // would fall in the next one -- the general formula below can't see that
  // (it reasons about full Monday-Sunday weeks), hence the special case.
  if (targetYear === referenceDate.getFullYear() && targetMonth === referenceDate.getMonth()) {
    return 0;
  }

  const currentWeekStart = startOfMondayWeek(referenceDate);
  const nextMonthWeekStart = startOfMondayWeek(new Date(targetYear, targetMonth + 1, 1));
  const weekIndex = Math.round(daysBetween(nextMonthWeekStart, currentWeekStart) / 7) + 1;

  return Math.max(0, weekIndex);
}

// -- FlatList getItemLayout support -----------------------------------------
//
// Row heights aren't uniform: "this week" can have 1-7 days (only up to
// today), month-break weeks render an extra divider block, and -- the big
// one -- day rows WITH a memory render a 56px stamp (~72px row) while empty
// days render only the ~36px pill (~58px row). Which days have memories is
// unknowable up front (memory data is fetched in a window around the
// viewport), so these constants are a best-effort estimate matched to
// calendar.tsx's styles, tuned to the memory-row case. Three things keep
// long jumps accurate despite the estimate:
//   1. offsets include the (measured) ListHeaderComponent height --
//      getItemLayout offsets are in content coordinates, which include the
//      list header, so omitting it shifts every landing;
//   2. the screen measures each rendered week row via onLayout and feeds
//      real heights back through `measuredHeights` below (React Native
//      skips its own cell measurement whenever getItemLayout is provided,
//      so without this the static estimates would never be corrected);
//   3. the screen runs a bounded settle-and-correct pass after each jump
//      (see resolveCalendarJumpCorrection).
const DAY_ROW_HEIGHT = 72; // ribbonDay with a memory: 56px stamp + 8px vertical padding * 2 (empty rows are ~58px -- see note above)
const DAY_ROW_GAP = 6; // weekDays `gap`
const WEEK_LABEL_ROW_HEIGHT = 26; // weekLabelRow text (~14px line) + marginBottom 12
const MONTH_BREAK_HEIGHT = 60; // monthBreak: 28px text line + marginTop 6 + marginBottom 26
const WEEK_BOTTOM_PADDING = 28; // week container paddingBottom (padding, not margin, so onLayout measures it)

export function getCalendarWeekItemHeight(week: CalendarWeek): number {
  const dayCount = week.days.length;
  const daysHeight = dayCount * DAY_ROW_HEIGHT + Math.max(0, dayCount - 1) * DAY_ROW_GAP;
  const monthBreakHeight = week.monthBreak ? MONTH_BREAK_HEIGHT : 0;

  return monthBreakHeight + WEEK_LABEL_ROW_HEIGHT + daysHeight + WEEK_BOTTOM_PADDING;
}

/**
 * Height of one week row: the real measured height when the row has been
 * laid out (keyed by the week's startIso), the static estimate otherwise.
 */
export function getCalendarWeekHeight(
  week: CalendarWeek,
  measuredHeights?: ReadonlyMap<string, number>,
): number {
  return measuredHeights?.get(week.startIso) ?? getCalendarWeekItemHeight(week);
}

export function buildCalendarWeekOffsets(
  weeks: CalendarWeek[],
  listHeaderHeight = 0,
  measuredHeights?: ReadonlyMap<string, number>,
): number[] {
  const offsets: number[] = [];
  let cursor = listHeaderHeight;

  for (const week of weeks) {
    offsets.push(cursor);
    cursor += getCalendarWeekHeight(week, measuredHeights);
  }

  return offsets;
}

export function getCalendarItemLayout(
  weeks: CalendarWeek[],
  offsets: number[],
  index: number,
  measuredHeights?: ReadonlyMap<string, number>,
): { length: number; offset: number; index: number } {
  const week = weeks[index];

  return {
    length: week ? getCalendarWeekHeight(week, measuredHeights) : 0,
    offset: offsets[index] ?? 0,
    index,
  };
}

// -- Post-jump settle-and-correct --------------------------------------
//
// scrollToIndex lands on the height MODEL's offset, but the pixels on
// screen are laid out from real row heights, so a long jump can settle off
// target -- including by a CONSTANT sub-row amount that index-granularity
// checks can never see (landing 130px into the target week still reports
// the target as the top visible index). And because React Native trusts
// getItemLayout for every scrollToIndex and never self-measures cells while
// it is provided, an index-based corrective scroll just replays the same
// model error. The correction therefore works in PIXELS: once the jump
// settles, the target row has rendered, so the screen measures its TRUE
// position in content coordinates (measureLayout against the list's inner
// container -- see measureCalendarWeekOffset) and issues one non-animated
// scrollToOffset to exactly that. This pure state machine bounds the pass
// to MAX_JUMP_CORRECTION_PASSES corrective scrolls per jump; the screen
// cancels the whole thing the moment the user starts dragging.

export const MAX_JUMP_CORRECTION_PASSES = 2;

// A measured position within this many pixels of what was last commanded
// counts as landed -- covers sub-pixel layout rounding.
export const JUMP_OFFSET_TOLERANCE_PX = 2;

export interface CalendarJumpCorrection {
  targetIndex: number;
  attemptsLeft: number;
  /**
   * The content offset most recently commanded for this jump: the model
   * ESTIMATE for the initial scrollToIndex, then the measured offset after
   * each pixel correction. A fresh measurement within tolerance of this
   * means the landing is confirmed.
   */
  lastCommandedOffset: number | null;
}

export function startCalendarJumpCorrection(
  targetIndex: number,
  commandedOffset: number | null = null,
): CalendarJumpCorrection {
  return { targetIndex, attemptsLeft: MAX_JUMP_CORRECTION_PASSES, lastCommandedOffset: commandedOffset };
}

export interface CalendarJumpCorrectionResolution {
  /** Pixel-true corrective scroll target (content coordinates), or null. */
  scrollToOffset: number | null;
  /**
   * Target row wasn't rendered/measurable: re-issue an estimated
   * scrollToIndex to bring it into the render window, then re-settle.
   */
  retryIndex: number | null;
  next: CalendarJumpCorrection | null;
}

/**
 * Decide what to do when a jump's scroll settles, given the target row's
 * freshly MEASURED position in content coordinates (or null when the row
 * isn't rendered, e.g. the landing was so far off that the target never
 * entered the render window).
 */
export function resolveCalendarJumpCorrection(
  pending: CalendarJumpCorrection | null,
  measuredTargetOffset: number | null,
): CalendarJumpCorrectionResolution {
  if (!pending || pending.attemptsLeft <= 0) {
    return { scrollToOffset: null, retryIndex: null, next: null };
  }

  if (measuredTargetOffset == null) {
    return {
      scrollToOffset: null,
      retryIndex: pending.targetIndex,
      next: { ...pending, attemptsLeft: pending.attemptsLeft - 1 },
    };
  }

  if (
    pending.lastCommandedOffset != null
    && Math.abs(measuredTargetOffset - pending.lastCommandedOffset) <= JUMP_OFFSET_TOLERANCE_PX
  ) {
    // Measured geometry confirms the last commanded position -- landed.
    return { scrollToOffset: null, retryIndex: null, next: null };
  }

  return {
    scrollToOffset: measuredTargetOffset,
    retryIndex: null,
    next: {
      targetIndex: pending.targetIndex,
      attemptsLeft: pending.attemptsLeft - 1,
      lastCommandedOffset: measuredTargetOffset,
    },
  };
}

/**
 * Minimal structural view of a React Native view instance -- kept
 * structural so this module stays React-free and the function is trivially
 * mockable in tests.
 */
export interface MeasurableWeekView {
  measureLayout?: (
    relativeToRef: object,
    onSuccess: (x: number, y: number) => void,
    onFail?: () => void,
  ) => void;
}

/**
 * Under the New Architecture (Fabric), `measureLayout`'s relativeTo
 * argument must be an actual host-component REF -- numeric node HANDLES
 * (e.g. from getInnerViewNode()/findNodeHandle()) are rejected at runtime
 * with "ref.measureLayout must be called with a ref to a native
 * component". This guard keeps any non-ref shape from ever reaching
 * measureLayout; callers should source the ref from
 * `getScrollResponder().getInnerViewRef()`, which returns the inner
 * content view's host instance.
 */
export function isMeasurableHostRef(candidate: unknown): candidate is object {
  return typeof candidate === 'object' && candidate !== null;
}

/**
 * Measure a rendered week row's TRUE offset in the list's content
 * coordinates (measureLayout against the ScrollView's inner content view
 * REF -- see isMeasurableHostRef for why it must be a ref, not a node
 * handle). Calls back with null when the row isn't rendered, the ref isn't
 * available (or is a rejected handle shape), or native measurement fails --
 * callers treat null as "target not measurable, retry by index" (see
 * resolveCalendarJumpCorrection).
 */
export function measureCalendarWeekOffset(
  weekView: MeasurableWeekView | null | undefined,
  relativeToRef: unknown,
  onResult: (offset: number | null) => void,
): void {
  if (!weekView || typeof weekView.measureLayout !== 'function' || !isMeasurableHostRef(relativeToRef)) {
    onResult(null);
    return;
  }

  weekView.measureLayout(
    relativeToRef,
    (_x, y) => onResult(y),
    () => onResult(null),
  );
}

// -- Header month label -------------------------------------------------
//
// The header eyebrow tracks whichever week is topmost in the viewport
// rather than statically showing today's month, so it keeps answering
// "where am I" while the user scrolls back through history.

/**
 * Month/year label for the header eyebrow, derived from the topmost visible
 * week's newest day -- the same "a week belongs to the month of its newest
 * day" rule buildCalendarWeeks uses to place month-break dividers, so the
 * header and the divider text never disagree about which month a given week
 * counts as. Callers should key this off only the topmost visible index
 * (e.g. `visibleRange.startIndex`), not the whole visible range, so the
 * label doesn't recompute -- and can't flicker -- as the bottom of the
 * visible window shifts without the top row changing.
 */
export function getVisibleMonthLabel(
  weeks: CalendarWeek[],
  visibleRange: CalendarVisibleWeekRange,
): string {
  if (weeks.length === 0) {
    return '';
  }

  const topIndex = Math.max(0, Math.min(visibleRange.startIndex, visibleRange.endIndex));
  const week = weeks[topIndex] ?? weeks[0]!;
  const endDate = parseIsoDate(week.endIso);

  // week.endIso is always produced by toIsoDate internally, so this is
  // unreachable in practice -- guarded because parseIsoDate's signature
  // allows for malformed input.
  return endDate ? formatMonthYear(endDate) : '';
}
