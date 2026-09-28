# Feature: Calendar view (Timeline)

**Status:** `done`
**Last updated:** 2026-09-29 (Calendar tab removed; the month grid lives in the Timeline)
**PRD reference:** [PRD §6 Journal & Calendar](../PRD.md)
**Plan:** [timeline-calendar-keepsakes.md](../plans/timeline-calendar-keepsakes.md) Phases A–C

## Overview

The calendar is a **view of the Timeline**, not a tab. The pinned bar's
List/Calendar switcher swaps the memory list for a month grid: months
newest-first, each a Monday-start 7-column grid whose day tiles show that
day's newest memory. Tapping a day opens the list at that day. The full
behavior lives in [memories.md](./memories.md) under "Pinned header bar +
jump to a month" and "Calendar view". This doc is the short index for the
calendar-specific pieces.

## Where things are

| Piece | Files |
|-------|-------|
| Grid | `src/components/timeline/calendar-month-grid.tsx` (`CalendarMonthGrid`) |
| Grid math (month shapes, exact offsets, fetch range, per-day summary) | `src/utils/calendar-grid.ts` |
| Day stamp (illustration / photo / video poster / sound / quote / hidden) | `src/components/memory-stamp.tsx` (`MemoryStamp`) |
| Month picker + per-month counts | `src/components/calendar-month-picker-sheet.tsx`, `src/utils/timeline-anchor.ts`, `src/hooks/useMemoryMonthCounts.ts` |
| Range data | `useCalendarMemoriesInRange` (`src/hooks/useCalendarMemories.ts`) → `fetchMemoriesInDateRange` (paged past 1000 rows, `id` tie-break) |
| View preference | `src/utils/timeline-view-preference.ts` (AsyncStorage `timeline.view`) |

## Extending

- **New stamp types:** add them to `MemoryStamp` (mirrors the
  `memory_type`/media-kind branching). Keep its `size` scaling so tiles stay
  legible at ~47pt.
- **A calendar-level filter** (e.g. by family member): thread it through
  `fetchMemoriesInDateRange` and `useCalendarMemoriesInRange`. The grid math
  depends only on dates.
- **Grid layout changes:** month heights must stay exact
  (`getGridMonthHeight`). `getItemLayout` and one-hop `scrollToIndex` month
  jumps rely on it.

## History

- 2026-07 → 2026-09-28: a separate **Calendar tab**, a day-per-row week
  ribbon with a fixed header, a month picker, and a pixel-anchored post-jump
  correction pass for its estimated row heights. It was removed on
  2026-09-29. The grid's exact heights make that correction machinery
  unnecessary, and its month picker and Today button moved to the Timeline's
  pinned bar.
