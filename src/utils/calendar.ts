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

    return {
      index,
      label: getWeekLabel(index),
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
