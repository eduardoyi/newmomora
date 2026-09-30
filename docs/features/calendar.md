# Feature: Calendar view (Timeline)

**Status:** `done`
**Last updated:** 2026-09-29 (month grid lives in the Timeline, below its sticky control row; Year Film day markers)
**PRD reference:** [PRD §6 Journal & Calendar](../PRD.md)
**Plan:** [timeline-calendar-keepsakes.md](../plans/timeline-calendar-keepsakes.md) Phases A–C

## Overview

The calendar is a **view of the Timeline**, not a tab. The List/Calendar
switcher in the Timeline's sticky control row (where "Recently" used to be)
swaps what's below that row, the memory list, for a month grid: months
newest-first, each a Monday-start 7-column grid whose day tiles show that
day's newest memory. Tapping a day opens the list at that day. The full
behavior lives in [memories.md](./memories.md) under "Sticky control row +
jump to a month" and "Calendar view". This doc is the short index for the
calendar-specific pieces.

## Where things are

| Piece | Files |
|-------|-------|
| Grid month (a row of the Timeline's list) | `src/components/timeline/calendar-month-grid.tsx` (`CalendarGridMonth`) |
| Sticky control row (month label, Today, switcher, weekday letters) | `src/components/timeline/timeline-control-row.tsx` |
| Grid math (month shapes, exact offsets, fetch range, per-day summary) | `src/utils/calendar-grid.ts` |
| Day stamp (illustration / photo / video poster / sound / quote / hidden) | `src/components/memory-stamp.tsx` (`MemoryStamp`) |
| Month picker + per-month counts | `src/components/calendar-month-picker-sheet.tsx`, `src/utils/timeline-anchor.ts`, `src/hooks/useMemoryMonthCounts.ts` |
| Film markers | `filmDates` prop of `CalendarGridMonth`; `useFamilyYearFilms` (`src/hooks/useYearFilms.ts`) |
| Range data | `useCalendarMemoriesInRange` (`src/hooks/useCalendarMemories.ts`) → `fetchMemoriesInDateRange` (paged past 1000 rows, `id` tie-break) |
| View preference | `src/utils/timeline-view-preference.ts` (AsyncStorage `timeline.view`) |

## Year Film markers

A day with a Year Film (its `placement_date`: a birthday, a month-end or Dec 31)
shows a small primary-coloured dot in the top-right of its tile
(`calendar-grid-day-{iso}-film`); the Timeline passes the set of placement dates
to `CalendarGridMonth` as `filmDates`. A film day is **pressable even with no
memories** (tinted tile, accessibility label "September 30, film"), because
monthly recaps usually land on a memory-less month-end. The tap is the ordinary
day tap (switch to List anchored at that day, where the film card sits); it logs
only the existing `timeline_jumped` `calendar_day` event. See
[year-film.md](year-film.md) "Timeline".

## Extending

- **New stamp types:** add them to `MemoryStamp` (mirrors the
  `memory_type`/media-kind branching). Keep its `size` scaling so tiles stay
  legible at ~47pt.
- **A calendar-level filter** (e.g. by family member): thread it through
  `fetchMemoriesInDateRange` and `useCalendarMemoriesInRange`. The grid math
  depends only on dates.
- **Grid layout changes:** month heights must stay exact
  (`getGridMonthHeight`), and so must the control row's (`getControlRowHeight`).
  Calendar view's `getItemLayout` and one-hop month jumps rely on both, plus
  the measured top content.

## History

- 2026-07 → 2026-09-28: a separate **Calendar tab**, a day-per-row week
  ribbon with a fixed header, a month picker, and a pixel-anchored post-jump
  correction pass for its estimated row heights. It was removed on
  2026-09-29. The grid's exact heights make that correction machinery
  unnecessary, and its month picker and Today button moved to the Timeline
  (first a pinned top bar, then, from 2026-09-29, the sticky control row).
