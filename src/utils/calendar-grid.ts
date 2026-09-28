// Timeline month grid (docs/plans/timeline-calendar-keepsakes.md B2). Pure
// date + layout math -- no React -- so month shapes, exact item offsets and
// the per-day memory summary are unit-testable. Local dates throughout
// (new Date(y, m, d)), never millisecond arithmetic, so DST never shifts a day.
import type { MemoryWithTags } from '@/services/memories';
import type { CalendarFetchRange } from '@/utils/calendar';
import { toIsoDate } from '@/utils/dates';
import { toMonthKey, type TimelineMonthOption } from '@/utils/timeline-anchor';

export interface GridDay {
  iso: string;
  day: number;
  isToday: boolean;
  isFuture: boolean;
}

export interface GridMonth {
  key: string; // 'YYYY-MM'
  year: number;
  month: number; // 0-11
  title: string; // 'March 2025'
  // Monday-start rows of 7; null = a blank cell outside the month.
  weeks: (GridDay | null)[][];
}

export const GRID_COLUMNS = 7;
export const GRID_HORIZONTAL_PADDING = 16;
export const GRID_GAP = 4;
export const GRID_MONTH_TITLE_HEIGHT = 44;
export const GRID_MONTH_BOTTOM_PADDING = 20;

export function buildGridMonth(year: number, month: number, todayIso: string): GridMonth {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // getDay(): 0 = Sunday. Monday-start: Mon -> 0 ... Sun -> 6.
  const leadingBlanks = (first.getDay() + 6) % 7;

  const cells: (GridDay | null)[] = Array.from({ length: leadingBlanks }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = toIsoDate(new Date(year, month, day));
    cells.push({ iso, day, isToday: iso === todayIso, isFuture: iso > todayIso });
  }
  while (cells.length % GRID_COLUMNS !== 0) {
    cells.push(null);
  }

  const weeks: (GridDay | null)[][] = [];
  for (let index = 0; index < cells.length; index += GRID_COLUMNS) {
    weeks.push(cells.slice(index, index + GRID_COLUMNS));
  }

  return {
    key: toMonthKey(first),
    year,
    month,
    title: first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    weeks,
  };
}

/** One grid month per picker option -- same range, same newest-first order. */
export function buildGridMonths(options: readonly TimelineMonthOption[], todayIso: string): GridMonth[] {
  return options.map((option) => buildGridMonth(option.year, option.month, todayIso));
}

export function getGridTileSize(windowWidth: number): number {
  const available = windowWidth - GRID_HORIZONTAL_PADDING * 2 - GRID_GAP * (GRID_COLUMNS - 1);
  return Math.max(24, Math.floor(available / GRID_COLUMNS));
}

export function getGridMonthHeight(month: GridMonth, tileSize: number): number {
  const rows = month.weeks.length;
  return GRID_MONTH_TITLE_HEIGHT + rows * tileSize + (rows - 1) * GRID_GAP + GRID_MONTH_BOTTOM_PADDING;
}

/** Content offset of every month; heights are exact, so getItemLayout is too. */
export function buildGridMonthOffsets(months: readonly GridMonth[], tileSize: number): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const month of months) {
    offsets.push(offset);
    offset += getGridMonthHeight(month, tileSize);
  }
  return offsets;
}

/**
 * Date range to fetch for the visible months plus `buffer` months either
 * side. `months` is newest-first, so the start date comes from the highest
 * index.
 */
export function getGridFetchRange(
  months: readonly GridMonth[],
  firstVisibleIndex: number,
  lastVisibleIndex: number,
  buffer = 1,
): CalendarFetchRange | null {
  if (months.length === 0) {
    return null;
  }
  const newestIndex = Math.max(0, Math.min(firstVisibleIndex, lastVisibleIndex) - buffer);
  const oldestIndex = Math.min(months.length - 1, Math.max(firstVisibleIndex, lastVisibleIndex) + buffer);
  const newest = months[newestIndex]!;
  const oldest = months[oldestIndex]!;
  return {
    startDate: toIsoDate(new Date(oldest.year, oldest.month, 1)),
    endDate: toIsoDate(new Date(newest.year, newest.month + 1, 0)),
  };
}

export interface GridDaySummary {
  // The day's newest memory (rows arrive memory_date desc, created_at desc --
  // the Calendar ribbon's choice), shown as the tile's stamp.
  memory: MemoryWithTags;
  // Every non-blocked memory that day, including the stamp's own. Reported
  // memories count: they still appear (as a hidden notice) in the list.
  count: number;
}

export function summarizeGridDays(
  memories: readonly MemoryWithTags[],
  isUserBlocked: (userId: string | null) => boolean,
): Map<string, GridDaySummary> {
  const byDate = new Map<string, GridDaySummary>();
  for (const memory of memories) {
    if (isUserBlocked(memory.user_id)) {
      continue;
    }
    const existing = byDate.get(memory.memory_date);
    if (existing) {
      existing.count += 1;
    } else {
      byDate.set(memory.memory_date, { memory, count: 1 });
    }
  }
  return byDate;
}

/** "March 3, 2 memories" / "March 3, no memories" */
export function getGridDayAccessibilityLabel(day: GridDay, month: GridMonth, count: number): string {
  const date = new Date(month.year, month.month, day.day).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  if (count === 0) {
    return `${date}, no memories`;
  }
  return `${date}, ${count} ${count === 1 ? 'memory' : 'memories'}`;
}
