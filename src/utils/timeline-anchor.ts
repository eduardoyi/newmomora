// Date-anchored Timeline helpers (docs/plans/timeline-calendar-keepsakes.md
// Phase A). Pure -- no React, no network -- so the page-param chaining and the
// month-picker math are unit-testable on their own.
import type { InfiniteData } from '@tanstack/react-query';

import type { MemoriesPage, MemoriesPageCursor } from '@/services/memories';
import type { CalendarMonthOption } from '@/utils/calendar';
import { parseIsoDate, toIsoDate } from '@/utils/dates';

/**
 * Page params for an ANCHORED Timeline query. Tagged with a direction because
 * react-query refetches an infinite query by replaying pageParams[0] and then
 * chaining getNextPageParam forward -- after a fetchPreviousPage, pageParams[0]
 * is a NEWER cursor, and an untagged cursor would be misread as an older one.
 * The queryFn dispatches on `dir`, never on react-query's `direction`.
 */
export type AnchoredPageParam =
  | { dir: 'anchor' }
  | { dir: 'older'; cursor: MemoriesPageCursor; inclusive?: boolean }
  | { dir: 'newer'; cursor: MemoriesPageCursor };

export const ANCHOR_PAGE_PARAM: AnchoredPageParam = { dir: 'anchor' };

export function isAnchoredPageParam(value: unknown): value is AnchoredPageParam {
  return Boolean(value) && typeof value === 'object' && 'dir' in (value as object);
}

/**
 * Older-direction continuation after `lastPage`. A page with rows continues
 * from its oldest row (`nextCursor`). An EMPTY newer page (its newer rows were
 * deleted between the existence check and the fetch) can only sit at the top
 * of the list, so its continuation is the page below it: everything from its
 * own starting cursor downward, cursor row included.
 */
export function getAnchoredNextPageParam(
  lastPage: MemoriesPage,
  lastPageParam: AnchoredPageParam,
): AnchoredPageParam | undefined {
  if (lastPage.nextCursor) {
    return { dir: 'older', cursor: lastPage.nextCursor };
  }

  if (lastPageParam.dir === 'newer' && lastPage.memories.length === 0) {
    return { dir: 'older', cursor: lastPageParam.cursor, inclusive: true };
  }

  return undefined;
}

export function getAnchoredPreviousPageParam(firstPage: MemoriesPage): AnchoredPageParam | undefined {
  return firstPage.prevCursor ? { dir: 'newer', cursor: firstPage.prevCursor } : undefined;
}

/**
 * Keeps only the anchor page (reset to its initial param) ahead of a
 * pull-to-refresh -- the anchored equivalent of trimming the feed to page 1,
 * so a refresh is one page's cost and always re-derives from the anchor.
 */
export function trimAnchoredPagesToAnchor(
  data: InfiniteData<MemoriesPage, unknown> | undefined,
): InfiniteData<MemoriesPage, unknown> | undefined {
  if (!data) {
    return data;
  }

  const anchorIndex = data.pageParams.findIndex(
    (param) => isAnchoredPageParam(param) && param.dir === 'anchor',
  );
  const anchorPage = anchorIndex >= 0 ? data.pages[anchorIndex] : undefined;

  if (!anchorPage) {
    return data;
  }

  return { pages: [anchorPage], pageParams: [ANCHOR_PAGE_PARAM] };
}

// ── Month picker ────────────────────────────────────────────────────────────

/** 'YYYY-MM' for an ISO date string (or a Date). */
export function toMonthKey(value: string | Date): string {
  const date = typeof value === 'string' ? parseIsoDate(value) : value;
  if (!date) {
    return '';
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export type MonthCounts = Record<string, number>;

export function buildMonthCounts(
  rows: readonly { memory_date: string; user_id: string }[],
  isUserBlocked: (userId: string) => boolean = () => false,
): MonthCounts {
  const counts: MonthCounts = {};

  for (const row of rows) {
    if (isUserBlocked(row.user_id)) {
      continue;
    }
    const key = toMonthKey(row.memory_date);
    if (key) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  return counts;
}

export interface TimelineMonthOption extends CalendarMonthOption {
  count: number;
}

/**
 * Every month from the newest month that matters -- the current month, or a
 * later one when a memory is future-dated (unvalidated dates, bad import
 * EXIF) -- back to the oldest month with a memory, newest first, each with
 * its memory count. With no memories, just the current month.
 */
export function getTimelineMonthOptions(referenceDate: Date, counts: MonthCounts): TimelineMonthOption[] {
  const currentKey = toMonthKey(referenceDate);
  const keys = Object.keys(counts).filter((key) => counts[key]! > 0).sort();
  const oldestKey = keys[0] ?? currentKey;
  const newestKey = keys.length > 0 && keys[keys.length - 1]! > currentKey ? keys[keys.length - 1]! : currentKey;
  const startKey = oldestKey < currentKey ? oldestKey : currentKey;

  const [newestYear, newestMonth] = newestKey.split('-').map(Number) as [number, number];
  const options: TimelineMonthOption[] = [];
  let year = newestYear;
  let month = newestMonth - 1;

  for (;;) {
    const cursor = new Date(year, month, 1);
    const key = toMonthKey(cursor);
    if (key < startKey) {
      break;
    }

    options.push({
      year,
      month,
      label: cursor.toLocaleDateString('en-US', { month: 'long' }),
      iso: toIsoDate(cursor),
      isCurrent: key === currentKey,
      count: counts[key] ?? 0,
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
 * Anchor date for a picked month: its last day, so the list starts at the
 * month's newest memory. The current month means "today's feed" (null).
 */
export function getMonthAnchorDate(option: Pick<CalendarMonthOption, 'year' | 'month' | 'isCurrent'>): string | null {
  if (option.isCurrent) {
    return null;
  }
  return toIsoDate(new Date(option.year, option.month + 1, 0));
}

/** Pinned-bar month label -- always with the year ("March 2026"). */
export function formatTimelineMonthLabel(value: string | Date): string {
  const date = typeof value === 'string' ? parseIsoDate(value) : value;
  return date ? date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
}
