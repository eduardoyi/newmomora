import type { MemoryBookListRow } from '@/services/memory-books';
import type { YearFilm } from '@/services/year-films';
import {
  YEAR_FILMS_POLL_INTERVAL_MS,
  buildKeepsakeYears,
  filmDisplayState,
  filmSubtitle,
  filmTitle,
  hasFilmInProgress,
  interleaveFilms,
  isNewFilm,
  yearFilmsRefetchInterval,
} from '@/utils/year-films';

function film(overrides: Partial<YearFilm> = {}): YearFilm {
  return {
    id: 'film-1',
    family_id: 'family-1',
    kind: 'birthday',
    family_member_id: 'tomas',
    age_year: 4,
    scope_start_date: '2025-10-14',
    scope_end_exclusive: '2026-10-16',
    scope_label: null,
    language: 'en',
    placement_date: '2026-10-14',
    duration_ms: 62000,
    surface_at: '2026-10-16T09:00:00.000Z',
    ready_at: '2026-10-16T08:00:00.000Z',
    edits_version: 0,
    status: 'ready',
    blocked: false,
    stale: false,
    ...overrides,
  };
}

const monthFilm = (id: string, placement: string, overrides: Partial<YearFilm> = {}) =>
  film({
    id,
    kind: 'family_month',
    family_member_id: null,
    age_year: null,
    scope_start_date: `${placement.slice(0, 8)}01`,
    placement_date: placement,
    ...overrides,
  });

const yearFilm = (id: string, year: number, overrides: Partial<YearFilm> = {}) =>
  film({
    id,
    kind: 'family_year',
    family_member_id: null,
    age_year: null,
    scope_start_date: `${year}-01-01`,
    placement_date: `${year}-12-31`,
    ...overrides,
  });

const members = [
  { id: 'tomas', name: 'Tomás' },
  { id: 'jesus', name: 'Jesus' },
];

describe('filmTitle', () => {
  it('titles a birthday film with the ordinal word', () => {
    expect(filmTitle(film(), members)).toBe("Tomás' Year Four");
    expect(filmTitle(film({ age_year: 1 }), members)).toBe("Tomás' Year One");
    expect(filmTitle(film({ age_year: 12 }), members)).toBe("Tomás' Year Twelve");
  });

  it('uses a bare apostrophe for names ending in s', () => {
    expect(filmTitle(film({ family_member_id: 'jesus', age_year: 2 }), members)).toBe("Jesus' Year Two");
  });

  it('falls back to a numeral past the ordinal words', () => {
    expect(filmTitle(film({ age_year: 25 }), members)).toBe("Tomás' Year 25");
  });

  it('handles a missing age year', () => {
    expect(filmTitle(film({ age_year: null }), members)).toBe("Tomás' birthday film");
  });

  it('falls back when the member is gone', () => {
    expect(filmTitle(film({ family_member_id: 'ghost' }), members)).toBe('A birthday film');
    expect(filmTitle(film({ family_member_id: null }), members)).toBe('A birthday film');
  });

  it('titles a monthly recap by month name', () => {
    expect(filmTitle(monthFilm('m', '2026-09-30'), members)).toBe('September recap');
    expect(filmTitle(monthFilm('m', '2026-01-31'), members)).toBe('January recap');
  });

  it('titles a year-end film', () => {
    expect(filmTitle(yearFilm('y', 2026), members)).toBe('Your 2026');
  });
});

describe('filmSubtitle', () => {
  it('shows duration and the era for a birthday film', () => {
    expect(filmSubtitle(film({ scope_start_date: '2025-10-14', placement_date: '2026-10-14', duration_ms: 62000 }))).toBe(
      '1 minute · Oct 2025 – Oct 2026',
    );
  });

  it('rounds duration to whole minutes, minimum one', () => {
    const base = film();
    expect(filmSubtitle({ ...base, duration_ms: 20000 }).startsWith('1 minute ·')).toBe(true);
    expect(filmSubtitle({ ...base, duration_ms: 89000 }).startsWith('1 minute ·')).toBe(true);
    expect(filmSubtitle({ ...base, duration_ms: 90000 }).startsWith('2 minutes ·')).toBe(true);
    expect(filmSubtitle({ ...base, duration_ms: 125000 }).startsWith('2 minutes ·')).toBe(true);
  });

  it('omits the duration when unknown', () => {
    expect(filmSubtitle(film({ duration_ms: null }))).toBe('Oct 2025 – Oct 2026');
  });

  it('names the month for a monthly recap', () => {
    expect(filmSubtitle(monthFilm('m', '2026-09-30', { duration_ms: 60000 }))).toBe('1 minute · September 2026');
  });

  it('shows just the year for a year-end film', () => {
    expect(filmSubtitle(yearFilm('y', 2026, { duration_ms: 130000 }))).toBe('2 minutes · 2026');
  });
});

interface TestMemory {
  id: string;
  memory_date: string;
}
const mem = (id: string, memory_date: string): TestMemory => ({ id, memory_date });
const ids = (items: ReturnType<typeof interleaveFilms<TestMemory>>) =>
  items.map((item) => (item.kind === 'memory' ? item.memory.id : item.film.id));

const OPEN = { hasNewer: false, hasOlder: false };

describe('interleaveFilms', () => {
  const memories = [mem('a', '2026-09-30'), mem('b', '2026-09-28'), mem('c', '2026-09-10')];

  it('puts a film between days, above the first memory on or before its date', () => {
    const f = film({ id: 'f', placement_date: '2026-09-29' });
    expect(ids(interleaveFilms(memories, [f], OPEN))).toEqual(['a', 'f', 'b', 'c']);
  });

  it('puts a film above that day\'s memories (the day\'s latest item)', () => {
    const f = film({ id: 'f', placement_date: '2026-09-28' });
    expect(ids(interleaveFilms(memories, [f], OPEN))).toEqual(['a', 'f', 'b', 'c']);
  });

  it('orders same-day films year > month > birthday, all above the day\'s memories', () => {
    const b = film({ id: 'bday', placement_date: '2026-12-31' });
    const m = monthFilm('month', '2026-12-31');
    const y = yearFilm('year', 2026);
    const dec = [mem('dec-late', '2026-12-31'), mem('dec-early', '2026-12-20')];
    expect(ids(interleaveFilms(dec, [b, m, y], OPEN))).toEqual(['year', 'month', 'bday', 'dec-late', 'dec-early']);
  });

  it('orders films sharing a slot newest-first', () => {
    const f1 = monthFilm('older', '2026-09-20');
    const f2 = monthFilm('newer', '2026-09-29');
    expect(ids(interleaveFilms(memories, [f1, f2], OPEN))).toEqual(['a', 'newer', 'b', 'older', 'c']);
  });

  it('shows a film above every loaded memory only when nothing newer exists', () => {
    const f = film({ id: 'f', placement_date: '2026-10-05' });
    expect(ids(interleaveFilms(memories, [f], { hasNewer: false, hasOlder: true }))).toEqual(['f', 'a', 'b', 'c']);
    expect(ids(interleaveFilms(memories, [f], { hasNewer: true, hasOlder: true }))).toEqual(['a', 'b', 'c']);
  });

  it('shows an above-window film when anchored and its date <= the anchor', () => {
    // A month jump anchors at the month's last day, where the recap sits.
    const recap = monthFilm('recap', '2026-09-30');
    const anchored = { hasNewer: true, hasOlder: true, anchorDate: '2026-09-30' };
    expect(ids(interleaveFilms(memories, [recap], anchored))).toEqual(['recap', 'a', 'b', 'c']);
  });

  it('hides an above-window film dated after the anchor', () => {
    const later = film({ id: 'later', placement_date: '2026-10-05' });
    const anchored = { hasNewer: true, hasOlder: true, anchorDate: '2026-09-30' };
    expect(ids(interleaveFilms(memories, [later], anchored))).toEqual(['a', 'b', 'c']);
  });

  it('ignores the anchor when the film is not above the window', () => {
    const f = film({ id: 'f', placement_date: '2026-09-29' });
    const anchored = { hasNewer: true, hasOlder: true, anchorDate: '2026-09-30' };
    expect(ids(interleaveFilms(memories, [f], anchored))).toEqual(['a', 'f', 'b', 'c']);
  });

  it('shows a film below every loaded memory only when nothing older exists', () => {
    const f = film({ id: 'f', placement_date: '2026-01-05' });
    expect(ids(interleaveFilms(memories, [f], { hasNewer: false, hasOlder: false }))).toEqual(['a', 'b', 'c', 'f']);
    expect(ids(interleaveFilms(memories, [f], { hasNewer: false, hasOlder: true }))).toEqual(['a', 'b', 'c']);
  });

  it('shows every film when no memories exist and nothing is unloaded', () => {
    const fs = [monthFilm('m', '2026-09-30'), yearFilm('y', 2025)];
    expect(ids(interleaveFilms<TestMemory>([], fs, OPEN))).toEqual(['m', 'y']);
  });

  it('shows no films for an empty window with unloaded pages', () => {
    const fs = [monthFilm('m', '2026-09-30')];
    expect(interleaveFilms<TestMemory>([], fs, { hasNewer: true, hasOlder: false })).toEqual([]);
    expect(interleaveFilms<TestMemory>([], fs, { hasNewer: false, hasOlder: true })).toEqual([]);
  });

  it('keeps the memory order and returns memories unchanged with no films', () => {
    expect(ids(interleaveFilms(memories, [], OPEN))).toEqual(['a', 'b', 'c']);
  });

  it('tolerates timestamp-shaped memory dates', () => {
    const stamped = [mem('a', '2026-09-30T12:00:00.000Z'), mem('b', '2026-09-28T08:00:00.000Z')];
    const f = film({ id: 'f', placement_date: '2026-09-29' });
    expect(ids(interleaveFilms(stamped, [f], OPEN))).toEqual(['a', 'f', 'b']);
  });

  it('does not mutate its inputs', () => {
    const fs = [monthFilm('m1', '2026-09-20'), monthFilm('m2', '2026-09-29')];
    const before = fs.map((f) => f.id);
    interleaveFilms(memories, fs, OPEN);
    expect(fs.map((f) => f.id)).toEqual(before);
    expect(memories.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('isNewFilm', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const surfaced = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400000).toISOString();

  it('is new when unviewed and surfaced within 14 days', () => {
    expect(isNewFilm(film({ surface_at: surfaced(1) }), new Set(), now)).toBe(true);
    expect(isNewFilm(film({ surface_at: surfaced(14) }), new Set(), now)).toBe(true);
  });

  it('is not new once viewed', () => {
    expect(isNewFilm(film({ id: 'x', surface_at: surfaced(1) }), new Set(['x']), now)).toBe(false);
  });

  it('is not new when older than 14 days (backfilled history)', () => {
    expect(isNewFilm(film({ surface_at: surfaced(15) }), new Set(), now)).toBe(false);
    expect(isNewFilm(film({ surface_at: '2025-01-01T00:00:00.000Z' }), new Set(), now)).toBe(false);
  });

  it('is not new before it has surfaced', () => {
    expect(isNewFilm(film({ surface_at: surfaced(-1) }), new Set(), now)).toBe(false);
  });
});

function book(overrides: Partial<MemoryBookListRow> = {}): MemoryBookListRow {
  return {
    id: 'book-1',
    family_id: 'family-1',
    child_id: 'tomas',
    status: 'ready',
    scope_kind: 'age_year',
    scope_start_date: '2025-06-01',
    scope_end_date: '2026-05-31',
    scope_label: 'Year Three',
    failure_reason: null,
    cover_asset_key: null,
    created_at: '2026-06-02T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildKeepsakeYears', () => {
  const kids = [
    { id: 'tomas', name: 'Tomás', relationship: 'child', date_of_birth: '2022-10-14' },
    { id: 'mia', name: 'Mia', relationship: 'child', date_of_birth: '2024-02-02' },
    { id: 'mom', name: 'Mom', relationship: 'parent', date_of_birth: '1990-01-01' },
  ];
  const today = '2026-09-29';

  it('always includes the current year, with a shelf per own child', () => {
    const years = buildKeepsakeYears([], [], kids, today);
    expect(years).toHaveLength(1);
    expect(years[0].year).toBe(2026);
    expect(years[0].familyFilms).toEqual({ yearEnd: null, recaps: [] });
    expect(years[0].children.map((c) => c.member.id)).toEqual(['tomas', 'mia']);
  });

  it('files films under the year of their placement date, newest year first', () => {
    const films = [
      film({ id: 'b26', placement_date: '2026-10-14' }),
      yearFilm('y25', 2025),
      monthFilm('m-sep', '2026-09-30'),
      monthFilm('m-aug', '2026-08-31'),
      monthFilm('m-dec25', '2025-12-31'),
    ];
    const years = buildKeepsakeYears(films, [], kids, today);
    expect(years.map((y) => y.year)).toEqual([2026, 2025]);
    const y26 = years[0];
    expect(y26.familyFilms.yearEnd).toBeNull();
    expect(y26.familyFilms.recaps.map((f) => f.id)).toEqual(['m-sep', 'm-aug']);
    expect(y26.children.find((c) => c.member.id === 'tomas')!.films.map((f) => f.id)).toEqual(['b26']);
    const y25 = years[1];
    expect(y25.familyFilms.yearEnd?.id).toBe('y25');
    expect(y25.familyFilms.recaps.map((f) => f.id)).toEqual(['m-dec25']);
  });

  it('sorts recaps newest first and birthday films newest first per child', () => {
    const films = [
      monthFilm('jan', '2026-01-31'),
      monthFilm('mar', '2026-03-31'),
      monthFilm('feb', '2026-02-28'),
      film({ id: 'b-early', placement_date: '2026-01-10' }),
      film({ id: 'b-late', placement_date: '2026-06-10' }),
    ];
    const [y26] = buildKeepsakeYears(films, [], kids, today);
    expect(y26.familyFilms.recaps.map((f) => f.id)).toEqual(['mar', 'feb', 'jan']);
    expect(y26.children.find((c) => c.member.id === 'tomas')!.films.map((f) => f.id)).toEqual(['b-late', 'b-early']);
  });

  it('files a book under the year its scope ends, else its creation year', () => {
    const books = [
      book({ id: 'ends-2026', scope_end_date: '2026-05-31', created_at: '2026-06-02T00:00:00.000Z' }),
      book({ id: 'ends-2025', scope_end_date: '2025-05-31', created_at: '2026-06-03T00:00:00.000Z' }),
      book({ id: 'everything', scope_kind: 'everything', scope_start_date: null, scope_end_date: null, created_at: '2024-04-01T00:00:00.000Z' }),
    ];
    const years = buildKeepsakeYears([], books, kids, today);
    expect(years.map((y) => y.year)).toEqual([2026, 2025, 2024]);
    expect(years[0].children.find((c) => c.member.id === 'tomas')!.books.map((b) => b.id)).toEqual(['ends-2026']);
    expect(years[1].children.map((c) => c.books.map((b) => b.id))).toEqual([['ends-2025']]);
    expect(years[2].children.map((c) => c.books.map((b) => b.id))).toEqual([['everything']]);
  });

  it('lists a past year\'s children only when they have something that year', () => {
    const films = [film({ id: 'b25', placement_date: '2025-10-14' })];
    const years = buildKeepsakeYears(films, [], kids, today);
    const y25 = years.find((y) => y.year === 2025)!;
    expect(y25.children.map((c) => c.member.id)).toEqual(['tomas']);
  });

  it('applies the shelf rule: own children or anyone with a book', () => {
    const books = [book({ child_id: 'mom', scope_end_date: '2026-05-31' })];
    const [y26] = buildKeepsakeYears([], books, kids, today);
    expect(y26.children.map((c) => c.member.id)).toEqual(['tomas', 'mia', 'mom']);
    expect(y26.children.find((c) => c.member.id === 'mom')!.books).toHaveLength(1);
  });

  it('treats an unsorted member under 13 as a child, and an adult as not', () => {
    const unsorted = [
      { id: 'kid', name: 'Kid', relationship: null, date_of_birth: '2020-01-01' },
      { id: 'adult', name: 'Adult', relationship: null, date_of_birth: '1985-01-01' },
    ];
    const [y26] = buildKeepsakeYears([], [], unsorted, today);
    expect(y26.children.map((c) => c.member.id)).toEqual(['kid']);
  });

  it('omits birthday films whose member is gone', () => {
    const films = [film({ id: 'orphan', family_member_id: 'ghost', placement_date: '2025-10-14' })];
    const years = buildKeepsakeYears(films, [], kids, today);
    expect(years.flatMap((y) => y.children.flatMap((c) => c.films))).toEqual([]);
  });

  it('sorts a child\'s books newest created first', () => {
    const books = [
      book({ id: 'old', created_at: '2026-01-02T00:00:00.000Z' }),
      book({ id: 'new', created_at: '2026-06-02T00:00:00.000Z' }),
    ];
    const [y26] = buildKeepsakeYears([], books, kids, today);
    expect(y26.children.find((c) => c.member.id === 'tomas')!.books.map((b) => b.id)).toEqual(['new', 'old']);
  });
});

describe('filmDisplayState', () => {
  it.each(['queued', 'curating', 'preparing', 'rendering'])(
    'a blocked film in %s is remaking',
    (status) => {
      expect(filmDisplayState(film({ blocked: true, stale: true, status }))).toBe('remaking');
    },
  );

  it('a blocked film whose remake failed or was skipped is hidden (its video is gone)', () => {
    expect(filmDisplayState(film({ blocked: true, stale: true, status: 'failed' }))).toBe('hidden');
    expect(filmDisplayState(film({ blocked: true, stale: true, status: 'skipped' }))).toBe('hidden');
  });

  it('a blocked film is never ready, whatever its status says', () => {
    expect(filmDisplayState(film({ blocked: true, status: 'ready' }))).toBe('remaking');
  });

  it.each(['queued', 'curating', 'preparing', 'rendering'])(
    'a stale, unblocked film in %s is updating (the old film still plays)',
    (status) => {
      expect(filmDisplayState(film({ blocked: false, stale: true, status }))).toBe('updating');
    },
  );

  it('a stale film whose re-render failed keeps serving the old film', () => {
    expect(filmDisplayState(film({ stale: true, status: 'failed' }))).toBe('ready');
    expect(filmDisplayState(film({ stale: true, status: 'skipped' }))).toBe('ready');
  });

  it('a settled film is ready, and a non-stale film mid-cycle is ready too', () => {
    expect(filmDisplayState(film({ status: 'ready', stale: false, blocked: false }))).toBe('ready');
    expect(filmDisplayState(film({ status: 'rendering', stale: false, blocked: false }))).toBe('ready');
    expect(filmDisplayState(film({ status: 'ready', stale: true, blocked: false }))).toBe('ready');
  });
});

describe('film polling condition', () => {
  const remaking = film({ id: 'r', blocked: true, stale: true, status: 'rendering' });
  const updating = film({ id: 'u', stale: true, status: 'queued' });
  const plain = film({ id: 'p' });
  const hidden = film({ id: 'h', blocked: true, stale: true, status: 'failed' });

  it('polls while any film is remaking or updating', () => {
    expect(hasFilmInProgress([plain, remaking])).toBe(true);
    expect(hasFilmInProgress([updating])).toBe(true);
  });

  it('does not poll for ready, hidden or missing data', () => {
    expect(hasFilmInProgress([plain, hidden])).toBe(false);
    expect(hasFilmInProgress([])).toBe(false);
    expect(hasFilmInProgress(undefined)).toBe(false);
    expect(hasFilmInProgress(null)).toBe(false);
  });

  it('refetches every 20 s only when a film is in progress AND the screen is focused', () => {
    expect(YEAR_FILMS_POLL_INTERVAL_MS).toBe(20_000);
    expect(yearFilmsRefetchInterval([remaking], true)).toBe(20_000);
    expect(yearFilmsRefetchInterval([updating], true)).toBe(20_000);
    expect(yearFilmsRefetchInterval([remaking], false)).toBe(false);
    expect(yearFilmsRefetchInterval([plain], true)).toBe(false);
    expect(yearFilmsRefetchInterval(undefined, true)).toBe(false);
  });
});
