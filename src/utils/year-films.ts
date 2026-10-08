// Pure Year Film helpers (docs/plans/year-film-p2.md Step 4): titles and
// subtitles, Timeline placement and the "New" marker. No React, no I/O --
// unit-tested in year-films.test.ts.
import type { YearFilm } from '@/services/year-films';
import { ageYearLabel, formatMonthYear, parseDateParts } from '@/utils/memory-book-scope';

/** The slice of a family member the titles and Keepsakes grouping need. */
export interface YearFilmMember {
  id: string;
  name: string;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** A film is "New" for this long after it surfaced (backfilled history is
 * older than this, so it never is). */
export const NEW_FILM_WINDOW_DAYS = 14;

function possessive(name: string): string {
  const trimmed = name.trim();
  return /s$/i.test(trimmed) ? `${trimmed}'` : `${trimmed}'s`;
}

/**
 * "Tomás's Year Four" (birthday), "September recap" (monthly), "Your 2026"
 * (year-end). Names ending in s take a bare apostrophe ("Jesus' Year One").
 * A birthday film whose member is gone is "A birthday film". Uses the
 * member list of the FILM's family (a push can open a film before the family
 * switch completes).
 */
export function filmTitle(
  film: Pick<YearFilm, 'kind' | 'family_member_id' | 'age_year' | 'scope_start_date'>,
  members: readonly YearFilmMember[],
): string {
  switch (film.kind) {
    case 'birthday': {
      const member = members.find((m) => m.id === film.family_member_id);
      if (!member) return 'A birthday film';
      return film.age_year
        ? `${possessive(member.name)} ${ageYearLabel(film.age_year)}`
        : `${possessive(member.name)} birthday film`;
    }
    case 'family_month': {
      const { month } = parseDateParts(film.scope_start_date);
      return `${MONTH_NAMES[month - 1]} recap`;
    }
    case 'family_year': {
      const { year } = parseDateParts(film.scope_start_date);
      return `Your ${year}`;
    }
  }
}

function durationLabel(durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * "1 minute · Oct 2025 – Oct 2026" (birthday: scope start to placement month),
 * "1 minute · September 2026" (monthly), "2 minutes · 2026" (year-end). The
 * duration is rounded to whole minutes (under a minute reads "1 minute") and
 * omitted when unknown.
 */
export function filmSubtitle(
  film: Pick<YearFilm, 'kind' | 'scope_start_date' | 'placement_date' | 'duration_ms'>,
): string {
  let range: string;
  if (film.kind === 'birthday') {
    range = `${formatMonthYear(film.scope_start_date)} – ${formatMonthYear(film.placement_date)}`;
  } else if (film.kind === 'family_month') {
    const { year, month } = parseDateParts(film.scope_start_date);
    range = `${MONTH_NAMES[month - 1]} ${year}`;
  } else {
    range = String(parseDateParts(film.scope_start_date).year);
  }
  const duration = durationLabel(film.duration_ms);
  return duration ? `${duration} · ${range}` : range;
}

/** How a film is shown while it is (re)made. See `filmDisplayState`. */
export type FilmDisplayState = 'ready' | 'remaking' | 'updating' | 'hidden';

/** `year_films.status` values of a render cycle that is still running. */
const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set(['queued', 'curating', 'preparing', 'rendering']);

/**
 * What the app shows for a film row (RLS lets a member see any film that has
 * EVER been ready, including one being remade):
 * - `hidden`: blocked and the remake ended `failed`/`skipped` -- a blocked
 *   film that can't be remade has lost its video, so it is rendered nowhere;
 * - `remaking`: blocked (the old video contained content the family removed
 *   and is never served) -- a placeholder, no poster, not playable;
 * - `updating`: not blocked, `stale` and a render cycle is running -- the old
 *   film still plays, with an "Updating..." sticker;
 * - `ready`: everything else (including a stale film whose re-render
 *   `failed`: the old, good film keeps serving).
 * Hidden films are filtered out once, in `useFamilyYearFilms`.
 */
export function filmDisplayState(film: Pick<YearFilm, 'status' | 'blocked' | 'stale'>): FilmDisplayState {
  if (film.blocked) {
    return film.status === 'failed' || film.status === 'skipped' ? 'hidden' : 'remaking';
  }
  if (film.stale && IN_PROGRESS_STATUSES.has(film.status)) return 'updating';
  return 'ready';
}

/** The films list is refetched this often while a film is remaking/updating and the screen is focused. */
export const YEAR_FILMS_POLL_INTERVAL_MS = 20_000;

/** True while any film is `remaking` or `updating`: the list should keep polling. */
export function hasFilmInProgress(films: readonly Pick<YearFilm, 'status' | 'blocked' | 'stale'>[] | null | undefined): boolean {
  return (films ?? []).some((film) => {
    const state = filmDisplayState(film);
    return state === 'remaking' || state === 'updating';
  });
}

/** `refetchInterval` for the films query: the poll period, or `false` (stop). */
export function yearFilmsRefetchInterval(
  films: readonly Pick<YearFilm, 'status' | 'blocked' | 'stale'>[] | null | undefined,
  isFocused: boolean,
): number | false {
  return isFocused && hasFilmInProgress(films) ? YEAR_FILMS_POLL_INTERVAL_MS : false;
}

/** Same-day order in the newest-first Timeline: year above month above birthday. */
const KIND_RANK: Record<YearFilm['kind'], number> = { family_year: 0, family_month: 1, birthday: 2 };

function compareFilmsNewestFirst(a: YearFilm, b: YearFilm): number {
  if (a.placement_date !== b.placement_date) return a.placement_date < b.placement_date ? 1 : -1;
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type TimelineFilmItem<M> = { kind: 'memory'; memory: M } | { kind: 'film'; film: YearFilm };

export interface InterleaveFilmsOptions {
  /** More (newer) memory pages exist above the loaded window. */
  hasNewer: boolean;
  /** More (older) memory pages exist below the loaded window. */
  hasOlder: boolean;
  /** Anchored (month/day jump) window: every unloaded newer memory has
   * `memory_date > anchorDate`. Null/undefined for the normal paged feed. */
  anchorDate?: string | null;
}

/**
 * Merges films into a newest-first memory list. A film dated `d` goes BEFORE
 * the first loaded memory with `memory_date <= d` (so it is the day's latest
 * item and, newest-first, sits above that day's memories); on the same day
 * year > month > birthday.
 *
 * Only films whose position is provable from the loaded window are shown:
 * - above every loaded memory: only when `!hasNewer`, or anchored and
 *   `d <= anchorDate` (nothing unloaded can sort above it -- the month-jump
 *   case, where the recap caps the month's last day);
 * - below every loaded memory: only when `!hasOlder`;
 * - no memories loaded: only when `!hasNewer && !hasOlder`.
 * So a paged or anchored window never shows a film out of order.
 */
export function interleaveFilms<M extends { id: string; memory_date: string }>(
  memories: readonly M[],
  films: readonly YearFilm[],
  { hasNewer, hasOlder, anchorDate }: InterleaveFilmsOptions,
): TimelineFilmItem<M>[] {
  const sorted = [...films].sort(compareFilmsNewestFirst);
  const dateOf = (memory: M) => memory.memory_date.slice(0, 10);

  // slot -> films that sit directly above memories[slot] (memories.length = after the last).
  const slots = new Map<number, YearFilm[]>();
  const addToSlot = (slot: number, film: YearFilm) => {
    const list = slots.get(slot);
    if (list) list.push(film);
    else slots.set(slot, [film]);
  };

  for (const film of sorted) {
    const d = film.placement_date;
    if (memories.length === 0) {
      if (!hasNewer && !hasOlder) addToSlot(0, film);
      continue;
    }
    const index = memories.findIndex((memory) => dateOf(memory) <= d);
    if (index === -1) {
      if (!hasOlder) addToSlot(memories.length, film);
    } else if (index === 0) {
      if (!hasNewer || (anchorDate != null && d <= anchorDate)) addToSlot(0, film);
    } else {
      addToSlot(index, film);
    }
  }

  const result: TimelineFilmItem<M>[] = [];
  memories.forEach((memory, index) => {
    for (const film of slots.get(index) ?? []) result.push({ kind: 'film', film });
    result.push({ kind: 'memory', memory });
  });
  for (const film of slots.get(memories.length) ?? []) result.push({ kind: 'film', film });
  return result;
}

/**
 * "New" until watched, for 14 days after the film surfaced. Backfilled
 * history (surfaced long ago) is never new. Callers should not show the
 * marker while the views query is still loading.
 */
export function isNewFilm(film: Pick<YearFilm, 'id' | 'surface_at'>, viewedIds: ReadonlySet<string>, now: Date): boolean {
  if (viewedIds.has(film.id)) return false;
  const age = now.getTime() - new Date(film.surface_at).getTime();
  return age >= 0 && age <= NEW_FILM_WINDOW_DAYS * MS_PER_DAY;
}
