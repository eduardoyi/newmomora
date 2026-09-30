// Pure Year Film helpers (docs/plans/year-film-p2.md Step 4): titles and
// subtitles, Timeline placement, the "New" marker and the Keepsakes year
// grouping. No React, no I/O -- unit-tested in year-films.test.ts.
import type { MemoryBookListRow } from '@/services/memory-books';
import type { YearFilm } from '@/services/year-films';
import { isOwnChild } from '@/utils/family-relationships';
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
 * "Enzo's Year Four" (birthday), "September recap" (monthly), "Your 2026"
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

export interface KeepsakeYearChild<M> {
  member: M;
  /** That child's birthday films ending this year, newest first. */
  films: YearFilm[];
  /** That child's books ending this year, newest created first. */
  books: MemoryBookListRow[];
}

export interface KeepsakeYear<M> {
  year: number;
  familyFilms: {
    /** The year-end film ("Your 2026"), if it exists. */
    yearEnd: YearFilm | null;
    /** Every monthly recap of the year, newest first. */
    recaps: YearFilm[];
  };
  children: KeepsakeYearChild<M>[];
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * The Keepsakes tab's year sections, newest year first. Items file under the
 * year they END: a film by `placement_date`, a book by `scope_end_date`
 * (an unbounded "everything" book, which has none, by `created_at`). The
 * current year always exists so the create tiles and the upcoming-recap card
 * have a home.
 *
 * Children follow the existing shelf rule (an own child, or anyone with a
 * book) plus anyone with a birthday film. A shelf child appears in the
 * current year always, and in an earlier year only when they have a film or
 * book that year. Members are returned in the order given. Films whose
 * member is gone have no shelf and are omitted.
 */
export function buildKeepsakeYears<M extends { id: string; relationship?: string | null; date_of_birth?: string | null }>(
  films: readonly YearFilm[],
  books: readonly MemoryBookListRow[],
  members: readonly M[],
  todayIso: string,
): KeepsakeYear<M>[] {
  const currentYear = yearOf(todayIso);
  const referenceDate = new Date(`${todayIso}T12:00:00`);

  const filmsByYear = new Map<number, YearFilm[]>();
  for (const film of [...films].sort(compareFilmsNewestFirst)) {
    const year = yearOf(film.placement_date);
    const list = filmsByYear.get(year);
    if (list) list.push(film);
    else filmsByYear.set(year, [film]);
  }

  const booksByYear = new Map<number, MemoryBookListRow[]>();
  for (const book of [...books].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))) {
    const year = yearOf(book.scope_end_date ?? book.created_at);
    const list = booksByYear.get(year);
    if (list) list.push(book);
    else booksByYear.set(year, [book]);
  }

  const shelfMemberIds = new Set<string>();
  for (const book of books) if (book.child_id) shelfMemberIds.add(book.child_id);
  for (const film of films) if (film.kind === 'birthday' && film.family_member_id) shelfMemberIds.add(film.family_member_id);
  const shelfMembers = members.filter((member) => shelfMemberIds.has(member.id) || isOwnChild(member, referenceDate));

  const years = new Set<number>([currentYear, ...filmsByYear.keys(), ...booksByYear.keys()]);

  return [...years]
    .sort((a, b) => b - a)
    .map((year) => {
      const yearFilms = filmsByYear.get(year) ?? [];
      const yearBooks = booksByYear.get(year) ?? [];
      const children: KeepsakeYearChild<M>[] = [];
      for (const member of shelfMembers) {
        const childFilms = yearFilms.filter((film) => film.kind === 'birthday' && film.family_member_id === member.id);
        const childBooks = yearBooks.filter((book) => book.child_id === member.id);
        if (year === currentYear || childFilms.length > 0 || childBooks.length > 0) {
          children.push({ member, films: childFilms, books: childBooks });
        }
      }
      return {
        year,
        familyFilms: {
          yearEnd: yearFilms.find((film) => film.kind === 'family_year') ?? null,
          recaps: yearFilms.filter((film) => film.kind === 'family_month'),
        },
        children,
      };
    });
}
