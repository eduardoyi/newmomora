import type { HolidayCardSummary } from '@/services/holiday-cards';
import type {
  KeepsakesCard,
  KeepsakesCardFront,
  KeepsakesOrder,
  KeepsakesOverview,
  KeepsakesUpcomingFilm,
} from '@/services/keepsakes';
import type { MemoryBookListRow } from '@/services/memory-books';
import type { YearFilm } from '@/services/year-films';
import { buildMemoryBookRows } from '@/hooks/useMemoryBooks';
import {
  DEFAULT_KEEPSAKES_FILTER,
  activeCardFront,
  applyKeepsakesFilter,
  availableYears,
  bookBadge,
  buildChildChips,
  buildRelevantBookRows,
  buildShelfItems,
  cardFrontFor,
  formatArrival,
  formatMonthDay,
  groupShelfByYear,
  isUpcomingFilmLocked,
  pastCardBadge,
  shelfCardFront,
  upcomingFilmCaptionMeta,
  upcomingFilmCaptionTitle,
  upcomingFilmHint,
  upcomingFilmTitle,
  monthNameOf,
  pickNeedsYou,
  reconcileKeepsakesFilter,
  splitScopeOptions,
  yearSummaryLabel,
  type BookRow,
  type ShelfItem,
} from '@/utils/keepsakes';
import { buildMemoryBookScopeOptions } from '@/utils/memory-book-scope';

const TODAY = '2026-10-07';

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
    placement_date: '2026-03-14',
    duration_ms: 62000,
    surface_at: '2026-03-15T09:00:00.000Z',
    ready_at: '2026-03-15T08:00:00.000Z',
    edits_version: 0,
    status: 'ready',
    blocked: false,
    stale: false,
    ...overrides,
  };
}

const monthFilm = (id: string, placement: string, overrides: Partial<YearFilm> = {}) =>
  film({ id, kind: 'family_month', family_member_id: null, age_year: null, placement_date: placement, ...overrides });

const yearEndFilm = (id: string, year: number) =>
  film({ id, kind: 'family_year', family_member_id: null, age_year: null, placement_date: `${year}-12-31` });

function book(overrides: Partial<MemoryBookListRow> = {}): MemoryBookListRow {
  return {
    id: 'book-1',
    family_id: 'family-1',
    child_id: 'tomas',
    status: 'ready',
    scope_kind: 'age_year',
    scope_start_date: '2023-06-01',
    scope_end_date: '2024-05-31',
    scope_label: 'Year One',
    failure_reason: null,
    cover_asset_key: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

const tomas = { id: 'tomas', name: 'Teo', date_of_birth: '2023-06-01', relationship: 'child' };
const lucia = { id: 'lucia', name: 'Lucía', date_of_birth: '2021-02-10', relationship: 'child' };
const james = { id: 'james', name: 'James', date_of_birth: '2022-01-01', relationship: 'child' };

function booksMap(books: MemoryBookListRow[]) {
  const map = new Map<string, MemoryBookListRow[]>();
  for (const b of books) {
    const list = map.get(b.child_id!) ?? [];
    list.push(b);
    map.set(b.child_id!, list);
  }
  return map;
}

function rowsFor(books: MemoryBookListRow[], members = [tomas]): BookRow[] {
  return buildRelevantBookRows({ booksByChild: booksMap(books), members, todayIso: TODAY });
}

function card(overrides: Partial<HolidayCardSummary> = {}): HolidayCardSummary {
  return {
    enabled: true,
    cardId: 'card-1',
    year: 2026,
    status: 'ready',
    readiness: 'ready',
    lastFailureCode: null,
    ordered: false,
    language: 'en',
    ...overrides,
  };
}

function overview(overrides: Partial<KeepsakesOverview> = {}): KeepsakesOverview {
  return {
    recap: null,
    previous_recap: null,
    has_viewers: false,
    year_moments: 40,
    holiday_pool: 30,
    holiday_min_pool: 20,
    holiday_ship_by_note: null,
    preview_key: null,
    book_preview_keys: {},
    orders: [],
    card_front: null,
    cards: [],
    upcoming_films: [],
    ...overrides,
  };
}

const recap = (overrides: Partial<NonNullable<KeepsakesOverview['recap']>> = {}) => ({
  month_start: '2026-10-01',
  delivers_on: '2026-11-01',
  moments: 4,
  visuals: 2,
  min_moments: 10,
  min_visuals: 6,
  picture_key: null,
  ...overrides,
});

const order = (overrides: Partial<KeepsakesOrder> = {}): KeepsakesOrder => ({
  product: 'book',
  item_id: 'book-1',
  status: 'paid',
  shipped_at: null,
  ...overrides,
});

const pastFront = (cardId: string, year: number): KeepsakesCardFront => ({
  card_id: cardId,
  year,
  image_key: `family/${cardId}.jpg`,
  width: 4000,
  height: 3000,
  layout: 'bordered',
  orientation: 'landscape',
  focal: null,
  greeting: 'holidays',
  language: 'en',
  greeting_text: null,
  subline_text: null,
  greeting_position: 'bottom-left',
});

const cardEntry = (cardId: string, year: number, overrides: Partial<KeepsakesCard> = {}): KeepsakesCard => ({
  card_id: cardId,
  year,
  status: 'ready',
  ordered: false,
  front: pastFront(cardId, year),
  ...overrides,
});

const upcomingFilm = (overrides: Partial<KeepsakesUpcomingFilm> = {}): KeepsakesUpcomingFilm => ({
  kind: 'birthday',
  member_id: 'tomas',
  age_year: 4,
  film_date: '2026-11-20',
  scope_start: '2025-11-20',
  scope_end_excl: '2026-11-20',
  moments: 12,
  visuals: 7,
  min_moments: 15,
  min_visuals: 8,
  quarters: null,
  min_quarters: null,
  picture_key: null,
  ...overrides,
});

const yearUpcoming = (overrides: Partial<KeepsakesUpcomingFilm> = {}) =>
  upcomingFilm({
    kind: 'family_year',
    member_id: null,
    age_year: null,
    film_date: '2027-01-01',
    scope_start: '2026-01-01',
    scope_end_excl: '2027-01-01',
    quarters: 3,
    min_quarters: 3,
    moments: 40,
    visuals: 20,
    min_moments: 30,
    min_visuals: 15,
    ...overrides,
  });

function build(overrides: Partial<Parameters<typeof buildShelfItems>[0]> = {}) {
  return buildShelfItems({
    films: [],
    bookRows: [],
    cardSummary: null,
    overview: null,
    members: [tomas, lucia],
    role: 'owner',
    todayIso: TODAY,
    ...overrides,
  });
}

describe('date helpers', () => {
  it('formats months and days without Date', () => {
    expect(monthNameOf('2026-10-01')).toBe('October');
    expect(formatMonthDay('2026-11-01')).toBe('Nov 1');
    expect(formatMonthDay('2026-12-10')).toBe('Dec 10');
  });

  it('formatArrival says "today" on the day itself, else the month and day', () => {
    expect(formatArrival('2026-10-07', '2026-10-07')).toBe('today');
    expect(formatArrival('2026-10-08', '2026-10-07')).toBe('Oct 8');
    expect(formatArrival('2026-11-01', '2026-10-07')).toBe('Nov 1');
  });
});

describe('buildRelevantBookRows (book dedupe)', () => {
  it('gives one row and no banner when a failed book was retried into a ready one', () => {
    const failed = book({ id: 'old-failed', status: 'failed', updated_at: '2026-10-01T00:00:00.000Z', created_at: '2026-09-01T00:00:00.000Z' });
    const ready = book({ id: 'new-ready', status: 'ready', created_at: '2026-09-20T00:00:00.000Z' });
    const rows = rowsFor([ready, failed]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.book.id).toBe('new-ready');

    const items = build({ bookRows: rows });
    expect(items.filter((i) => i.kind === 'book')).toHaveLength(1);
    expect(
      pickNeedsYou({ cardSummary: null, bookRows: rows, members: [tomas], role: 'owner', todayIso: TODAY }),
    ).toBeNull();
  });

  it('prefers an in-flight retry over the older failure', () => {
    const rows = rowsFor([
      book({ id: 'old-failed', status: 'failed' }),
      book({ id: 'retry', status: 'queued' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('in_progress');
  });

  it('skips members who are neither an own child nor have books', () => {
    const grandma = { id: 'gran', name: 'Gran', date_of_birth: '1950-01-01', relationship: 'grandparent' };
    expect(rowsFor([], [grandma])).toHaveLength(0);
    expect(
      rowsFor(
        [book({ id: 'b', child_id: 'gran', scope_kind: 'everything', scope_start_date: null, scope_end_date: null, scope_label: 'Everything' })],
        [grandma],
      ),
    ).toHaveLength(1);
  });

  it('matches the rows KeepsakesBody derives per member', () => {
    const books = [book({ id: 'a' }), book({ id: 'b', scope_kind: 'everything', scope_start_date: null, scope_end_date: null, scope_label: 'Everything' })];
    const expected = buildMemoryBookRows(buildMemoryBookScopeOptions(tomas.date_of_birth, TODAY), books)
      .filter((row) => row.book)
      .map((row) => row.book!.id)
      .sort();
    expect(rowsFor(books).map((row) => row.book.id).sort()).toEqual(expected);
  });
});

describe('buildShelfItems', () => {
  it('files films, books and the card by their own year and orders newest first', () => {
    const items = build({
      films: [
        film({ id: 'f-old', placement_date: '2024-03-14' }),
        film({ id: 'f-new', placement_date: '2026-08-31', kind: 'family_month', family_member_id: null }),
      ],
      bookRows: rowsFor([book({ id: 'b-2024' })]),
      cardSummary: card(),
    });
    expect(items.map((i) => [i.id, i.year])).toEqual([
      ['card:card-1', 2026],
      ['film:f-new', 2026],
      ['book:b-2024', 2024], // ends 2024-05-31, after the 2024-03-14 film
      ['film:f-old', 2024],
    ]);
  });

  it('orders within a year: upcoming recap first, then date descending', () => {
    const items = build({
      films: [
        monthFilm('m-aug', '2026-08-31'),
        monthFilm('m-sep', '2026-09-30'),
        yearEndFilm('y-2025', 2025),
      ],
      cardSummary: card({ year: 2026 }),
      overview: overview({ recap: recap() }),
    });
    expect(items.map((i) => i.id)).toEqual([
      'upcoming-recap',
      'card:card-1', // Dec 1 2026 is the newest date
      'film:m-sep',
      'film:m-aug',
      'film:y-2025',
    ]);
  });

  it('files a book by scope_end_date, falling back to created_at for Everything', () => {
    const everything = book({
      id: 'b-all',
      scope_kind: 'everything',
      scope_start_date: null,
      scope_end_date: null,
      scope_label: 'Everything',
      created_at: '2026-06-02T10:00:00.000Z',
    });
    const items = build({ bookRows: rowsFor([book({ id: 'b-y1' }), everything]) });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId['book:b-y1']!.year).toBe(2024);
    expect(byId['book:b-all']!.year).toBe(2026);
    expect(byId['book:b-all']!.date).toBe('2026-06-02');
    expect(byId['book:b-all']!.memberId).toBe('tomas');
  });

  it('drops hidden films, keeps remaking and updating', () => {
    const items = build({
      films: [
        film({ id: 'hidden', blocked: true, status: 'failed' }),
        film({ id: 'remaking', blocked: true, status: 'rendering' }),
        film({ id: 'updating', stale: true, status: 'rendering' }),
        film({ id: 'ok' }),
      ],
    });
    const states = Object.fromEntries(
      items.filter((i) => i.kind === 'film').map((i) => [i.id, (i as Extract<ShelfItem, { kind: 'film' }>).displayState]),
    );
    expect(states).toEqual({ 'film:remaking': 'remaking', 'film:updating': 'updating', 'film:ok': 'ready' });
  });

  it('puts only birthday films under a child; recaps and year-end are family-wide', () => {
    const items = build({
      films: [film({ id: 'bday' }), monthFilm('m', '2026-09-30'), yearEndFilm('y', 2025)],
    });
    const owner = Object.fromEntries(items.map((i) => [i.id, i.memberId]));
    expect(owner).toEqual({ 'film:bday': 'tomas', 'film:m': null, 'film:y': null });
  });

  it('shows the card only in a non-make state, and files it Dec 1 of its year', () => {
    expect(build({ cardSummary: card({ cardId: null, year: null, status: null, readiness: null }) })).toHaveLength(0);
    expect(build({ cardSummary: null })).toHaveLength(0);
    const items = build({ cardSummary: card() });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'card', year: 2026, date: '2026-12-01', cardState: 'ready' });
  });

  it('drops a never-ordered previous-year card (the tile state maps it to make)', () => {
    expect(build({ cardSummary: card({ year: 2025 }), todayIso: '2026-01-15' })).toHaveLength(0);
  });

  it('keeps last year’s ordered card through Jan 31, on last year’s shelf', () => {
    const items = build({ cardSummary: card({ year: 2025, ordered: true }), todayIso: '2026-01-15' });
    expect(items).toHaveLength(1);
    expect(items[0]!.year).toBe(2025);
  });

  it('gives viewers films and the upcoming recap only', () => {
    const items = build({
      role: 'viewer',
      films: [film()],
      bookRows: rowsFor([book()]),
      cardSummary: card(),
      overview: overview({ recap: recap() }),
    });
    expect(items.map((i) => i.kind).sort()).toEqual(['film', 'upcoming-recap']);
  });

  it('places the upcoming recap by the owner-local year of month_start (forced open)', () => {
    // Owner is still in Dec 2026 while a device in an earlier zone reads Jan 2027... or vice versa:
    const items = build({
      todayIso: '2027-01-01',
      overview: overview({ recap: recap({ month_start: '2026-12-01', delivers_on: '2027-01-01' }) }),
      films: [film({ id: 'f27', placement_date: '2027-01-01' })],
    });
    const recapItem = items.find((i) => i.kind === 'upcoming-recap')!;
    expect(recapItem.year).toBe(2026);
    const years = groupShelfByYear(items, '2027-01-01');
    expect(years.find((y) => y.year === 2026)).toMatchObject({ isCurrent: false, isAlwaysOpen: true });
    expect(years.find((y) => y.year === 2027)).toMatchObject({ isCurrent: true, isAlwaysOpen: true });
  });

  describe('previous recap (last month’s, kept on the 1st until its film appears)', () => {
    const previous = (overrides: Partial<NonNullable<KeepsakesOverview['previous_recap']>> = {}) =>
      recap({ month_start: '2026-09-01', delivers_on: '2026-10-01', moments: 23, visuals: 9, ...overrides });

    it('is an upcoming-recap item filed on its own month’s shelf, flagged isPrevious', () => {
      const items = build({
        todayIso: '2026-10-01',
        overview: overview({ recap: recap({ delivers_on: '2026-11-01' }), previous_recap: previous() }),
      });
      const byId = Object.fromEntries(items.map((i) => [i.id, i]));
      expect(byId['upcoming-previous-recap']).toMatchObject({
        kind: 'upcoming-recap',
        isPrevious: true,
        year: 2026,
        date: '2026-10-01',
        memberId: null,
        badge: null,
      });
      expect(byId['upcoming-recap']).toMatchObject({ kind: 'upcoming-recap', isPrevious: false });
    });

    it('sorts BEFORE the current month’s recap tile on the same shelf', () => {
      const items = build({
        todayIso: '2026-10-01',
        films: [monthFilm('m-aug', '2026-08-31')],
        cardSummary: card({ year: 2026 }),
        overview: overview({ recap: recap({ delivers_on: '2026-11-01' }), previous_recap: previous() }),
      });
      expect(items.map((i) => i.id)).toEqual(['upcoming-previous-recap', 'upcoming-recap', 'card:card-1', 'film:m-aug']);
      const shelf = groupShelfByYear(items.slice().reverse(), '2026-10-01')[0]!;
      expect(shelf.items.map((i) => i.id).slice(0, 2)).toEqual(['upcoming-previous-recap', 'upcoming-recap']);
    });

    it('on Jan 1 December’s recap sits on last year’s shelf, which is forced open', () => {
      const items = build({
        todayIso: '2027-01-01',
        films: [film({ id: 'f27', placement_date: '2027-01-01' }), monthFilm('m-nov', '2026-11-30')],
        overview: overview({
          recap: recap({ month_start: '2027-01-01', delivers_on: '2027-02-01', moments: 0, visuals: 0 }),
          previous_recap: previous({ month_start: '2026-12-01', delivers_on: '2027-01-01' }),
        }),
      });
      expect(items.find((i) => i.id === 'upcoming-previous-recap')!.year).toBe(2026);
      expect(items.find((i) => i.id === 'upcoming-recap')!.year).toBe(2027);
      const years = groupShelfByYear(items, '2027-01-01');
      expect(years.find((y) => y.year === 2026)).toMatchObject({ isCurrent: false, isAlwaysOpen: true });
      expect(years.find((y) => y.year === 2026)!.items[0]!.id).toBe('upcoming-previous-recap');
      expect(years.find((y) => y.year === 2027)!.items[0]!.id).toBe('upcoming-recap');
    });

    it('viewers get it too, an absent previous_recap adds nothing, and it counts as Films', () => {
      const viewerItems = build({ role: 'viewer', overview: overview({ previous_recap: previous() }) });
      expect(viewerItems.map((i) => i.id)).toEqual(['upcoming-previous-recap']);
      expect(build({ overview: overview({ recap: recap() }) }).map((i) => i.id)).toEqual(['upcoming-recap']);
      expect(
        applyKeepsakesFilter(viewerItems, { ...DEFAULT_KEEPSAKES_FILTER, type: 'films' }).map((i) => i.id),
      ).toEqual(['upcoming-previous-recap']);
    });
  });

  describe('hands over to the real film (a stale overview never shows both)', () => {
    const prev = recap({ month_start: '2026-09-01', delivers_on: '2026-10-01', moments: 23, visuals: 9 });
    const ids = (items: ShelfItem[]) => items.map((i) => i.id);

    it('previous recap: present without the film, gone with the film of the same scope month', () => {
      const ov = overview({ previous_recap: prev });
      expect(ids(build({ todayIso: '2026-10-01', overview: ov }))).toEqual(['upcoming-previous-recap']);
      expect(ids(build({ todayIso: '2026-10-01', overview: ov, films: [monthFilm('m-aug', '2026-08-31', { scope_start_date: '2026-08-01' })] }))).toEqual([
        'upcoming-previous-recap',
        'film:m-aug',
      ]);
      expect(
        ids(build({ todayIso: '2026-10-01', overview: ov, films: [monthFilm('m-sep', '2026-09-30', { scope_start_date: '2026-09-01' })] })),
      ).toEqual(['film:m-sep']);
    });

    it('previous recap: a hidden film does not hand over, and the current recap is untouched', () => {
      const hidden = monthFilm('m-sep', '2026-09-30', { scope_start_date: '2026-09-01', blocked: true, status: 'failed' });
      expect(ids(build({ todayIso: '2026-10-01', overview: overview({ previous_recap: prev }), films: [hidden] }))).toEqual([
        'upcoming-previous-recap',
      ]);
      const sep = monthFilm('m-sep', '2026-09-30', { scope_start_date: '2026-09-01' });
      expect(ids(build({ todayIso: '2026-10-01', overview: overview({ recap: recap({ delivers_on: '2026-11-01' }), previous_recap: prev }), films: [sep] }))).toEqual([
        'upcoming-recap',
        'film:m-sep',
      ]);
    });

    it('birthday: gone once a visible birthday film of the same child and age is there', () => {
      const ov = overview({ upcoming_films: [upcomingFilm()] });
      const same = film({ id: 'b4', kind: 'birthday', family_member_id: 'tomas', age_year: 4 });
      const otherAge = film({ id: 'b3', kind: 'birthday', family_member_id: 'tomas', age_year: 3 });
      const otherChild = film({ id: 'l4', kind: 'birthday', family_member_id: 'lucia', age_year: 4 });
      expect(ids(build({ overview: ov }))).toEqual(['upcoming-film:birthday:tomas:2026-11-20']);
      expect(ids(build({ overview: ov, films: [same] }))).toEqual(['film:b4']);
      expect(ids(build({ overview: ov, films: [otherAge, otherChild] })).sort()).toEqual([
        'film:b3',
        'film:l4',
        'upcoming-film:birthday:tomas:2026-11-20',
      ]);
    });

    it('year-end: gone once a visible year-end film of that scope year is there', () => {
      const ov = overview({ upcoming_films: [yearUpcoming()] });
      const y2026 = film({ id: 'y26', kind: 'family_year', family_member_id: null, age_year: null, scope_start_date: '2026-01-01' });
      const y2025 = film({ id: 'y25', kind: 'family_year', family_member_id: null, age_year: null, scope_start_date: '2025-01-01' });
      expect(ids(build({ overview: ov }))).toEqual(['upcoming-film:family_year:family:2027-01-01']);
      expect(ids(build({ overview: ov, films: [y2026] }))).toEqual(['film:y26']);
      expect(ids(build({ overview: ov, films: [y2025] })).sort()).toEqual(['film:y25', 'upcoming-film:family_year:family:2027-01-01']);
    });
  });

  it('degrades with no overview: no upcoming tile and no order badges', () => {
    const items = build({ bookRows: rowsFor([book()]), overview: null });
    expect(items.some((i) => i.kind === 'upcoming-recap')).toBe(false);
    expect(items[0]!.badge).toBeNull();
  });
});

describe('the year-end film leads its year', () => {
  it('sits before the December recap even when the recap is newer or ties on date (and by id)', () => {
    const films = [
      monthFilm('a-nov', '2025-11-30'),
      monthFilm('a-dec', '2025-12-31'), // ties with the year film's date, and sorts before it by id
      yearEndFilm('z-year', 2025),
      monthFilm('b-newer', '2025-12-31', { scope_start_date: '2025-12-01' }),
    ];
    const items = build({ films });
    expect(items.map((i) => i.id)).toEqual(['film:z-year', 'film:a-dec', 'film:b-newer', 'film:a-nov']);
    // Same through the year grouping the library renders.
    expect(groupShelfByYear(items.slice().reverse(), TODAY)[0]!.items.map((i) => i.id)).toEqual([
      'film:z-year',
      'film:a-dec',
      'film:b-newer',
      'film:a-nov',
    ]);
  });

  it('still comes after the upcoming-recap tile and ahead of the card and books of its year', () => {
    const items = build({
      films: [monthFilm('m-dec', '2026-12-31'), yearEndFilm('y-2026', 2026)],
      bookRows: rowsFor([book({ id: 'b-26', scope_kind: 'everything', scope_start_date: null, scope_end_date: null, scope_label: 'Everything', created_at: '2026-05-31T10:00:00.000Z' })]),
      cardSummary: card({ year: 2026 }),
      overview: overview({ recap: recap() }),
    });
    expect(items.map((i) => i.id)).toEqual(['upcoming-recap', 'film:y-2026', 'film:m-dec', 'card:card-1', 'book:b-26']);
  });
});

const front: KeepsakesCardFront = {
  card_id: 'card-1',
  year: 2026,
  image_key: 'k',
  width: 4000,
  height: 3000,
  layout: 'bordered',
  orientation: 'landscape',
  focal: null,
  greeting: 'holidays',
  language: 'en',
  greeting_text: null,
  subline_text: null,
  greeting_position: 'bottom-left',
};

describe('cardFrontFor / activeCardFront', () => {
  it('returns the front only for the card it belongs to', () => {
    expect(cardFrontFor(overview({ card_front: front }), 'card-1')).toBe(front);
    expect(cardFrontFor(overview({ card_front: front }), 'card-2')).toBeNull();
    expect(cardFrontFor(overview({ card_front: front }), null)).toBeNull();
    expect(cardFrontFor(overview(), 'card-1')).toBeNull();
    expect(cardFrontFor(null, 'card-1')).toBeNull();
  });

  it('is active only while this season has a card (not "make", not hidden)', () => {
    const ov = overview({ card_front: front });
    expect(activeCardFront(ov, card(), TODAY)).toBe(front);
    expect(activeCardFront(ov, card({ ordered: true }), TODAY)).toBe(front);
    // No card yet.
    expect(activeCardFront(ov, card({ cardId: null, year: null }), TODAY)).toBeNull();
    // A card from a previous year that was never ordered counts as no card ("make").
    expect(activeCardFront(overview({ card_front: { ...front, year: 2025 } }), card({ year: 2025 }), TODAY)).toBeNull();
    // Out of season with no card: hidden.
    expect(activeCardFront(ov, card({ enabled: false, cardId: null, year: null }), TODAY)).toBeNull();
    expect(activeCardFront(ov, null, TODAY)).toBeNull();
  });
});

describe('badges', () => {
  const ready = () => rowsFor([book()])[0]!;

  it('books: queued/generating -> Being made (progress)', () => {
    for (const status of ['queued', 'generating'] as const) {
      const row = rowsFor([book({ status })])[0]!;
      expect(bookBadge(row, null)).toEqual({ label: 'Being made', tone: 'progress' });
    }
  });

  it('books: failed -> Couldn’t be made (needs you)', () => {
    const row = rowsFor([book({ status: 'failed' })])[0]!;
    expect(bookBadge(row, null)).toEqual({ label: 'Couldn’t be made', tone: 'needsYou' });
  });

  it('books: ready with no order has no badge', () => {
    expect(bookBadge(ready(), overview())).toBeNull();
  });

  it.each(['paid', 'rendering', 'submitted', 'in_production'])('books: ready + %s -> Ordered', (status) => {
    expect(bookBadge(ready(), overview({ orders: [order({ status })] }))).toEqual({ label: 'Ordered', tone: 'progress' });
  });

  it('books: shipped -> Shipped without a date; delivered -> none', () => {
    expect(bookBadge(ready(), overview({ orders: [order({ status: 'shipped' })] }))).toEqual({
      label: 'Shipped',
      tone: 'progress',
    });
    expect(bookBadge(ready(), overview({ orders: [order({ status: 'delivered' })] }))).toBeNull();
  });

  it('books: ignores an order for another item or a card order with the same id', () => {
    expect(bookBadge(ready(), overview({ orders: [order({ item_id: 'other' }), order({ product: 'card', status: 'shipped' })] }))).toBeNull();
  });

  it('cards: generating / ready / failed', () => {
    const badgeOf = (summary: HolidayCardSummary) => build({ cardSummary: summary })[0]!.badge;
    expect(badgeOf(card({ status: 'generating', readiness: 'generating' }))).toEqual({ label: 'Being made', tone: 'progress' });
    expect(badgeOf(card({ status: 'ready', readiness: 'film' }))).toEqual({ label: 'Being made', tone: 'progress' });
    expect(badgeOf(card())).toEqual({ label: 'Ready to order', tone: 'needsYou' });
    expect(badgeOf(card({ status: 'failed', readiness: 'failed' }))).toEqual({ label: 'Couldn’t be made', tone: 'needsYou' });
  });

  it('cards: ordered -> Ordered, or Shipped · {date} once the order shipped', () => {
    const ordered = card({ ordered: true });
    const cardOrder = (overrides: Partial<KeepsakesOrder>) =>
      order({ product: 'card', item_id: 'card-1', ...overrides });
    expect(build({ cardSummary: ordered, overview: null })[0]!.badge).toEqual({ label: 'Ordered', tone: 'progress' });
    expect(
      build({ cardSummary: ordered, overview: overview({ orders: [cardOrder({ status: 'in_production' })] }) })[0]!.badge,
    ).toEqual({ label: 'Ordered', tone: 'progress' });
    expect(
      build({
        cardSummary: ordered,
        overview: overview({ orders: [cardOrder({ status: 'shipped', shipped_at: '2026-12-12T12:00:00.000Z' })] }),
      })[0]!.badge,
    ).toEqual({ label: 'Shipped · Dec 12', tone: 'progress' });
    expect(
      build({ cardSummary: ordered, overview: overview({ orders: [cardOrder({ status: 'shipped' })] }) })[0]!.badge,
    ).toEqual({ label: 'Shipped', tone: 'progress' });
  });

  it('films carry no badge', () => {
    expect(build({ films: [film()] })[0]!.badge).toBeNull();
  });
});

describe('pickNeedsYou', () => {
  const pick = (overrides: Partial<Parameters<typeof pickNeedsYou>[0]> = {}) =>
    pickNeedsYou({
      cardSummary: null,
      bookRows: [],
      members: [tomas, lucia],
      role: 'owner',
      todayIso: TODAY,
      ...overrides,
    });
  const failedBook = (overrides: Partial<MemoryBookListRow> = {}) =>
    rowsFor([book({ status: 'failed', updated_at: '2026-10-01T10:00:00.000Z', ...overrides })], [tomas, lucia]);

  it('is null when nothing needs the user', () => {
    expect(pick()).toBeNull();
    expect(pick({ cardSummary: card({ status: 'generating', readiness: 'generating' }) })).toBeNull();
    expect(pick({ cardSummary: card({ ordered: true }) })).toBeNull();
  });

  it('card ready', () => {
    expect(pick({ cardSummary: card() })).toEqual({
      kind: 'card-ready',
      label: 'Your holiday card is ready to order',
      target: { type: 'card', cardId: 'card-1' },
    });
  });

  it('card failed', () => {
    expect(pick({ cardSummary: card({ status: 'failed', readiness: 'failed' }) })).toMatchObject({
      kind: 'card-failed',
      label: 'Your holiday card couldn’t be made',
    });
  });

  it('card banners stop when the season switch closes', () => {
    expect(pick({ cardSummary: card({ enabled: false }) })).toBeNull();
    expect(pick({ cardSummary: card({ enabled: false, status: 'failed', readiness: 'failed' }) })).toBeNull();
  });

  it('priority: card ready beats card failed beats a failed book', () => {
    const bookRows = failedBook();
    expect(pick({ cardSummary: card(), bookRows })!.kind).toBe('card-ready');
    expect(pick({ cardSummary: card({ status: 'failed', readiness: 'failed' }), bookRows })!.kind).toBe('card-failed');
    expect(pick({ cardSummary: null, bookRows })!.kind).toBe('book-failed');
  });

  it('failed book: names the child and targets the row', () => {
    const result = pick({ bookRows: failedBook() })!;
    expect(result.label).toBe('Teo’s book couldn’t be made');
    expect(result.target).toMatchObject({ type: 'book', memberId: 'tomas', bookId: 'book-1' });
    expect(result.target.type === 'book' && result.target.option.label).toBe('Year One');
  });

  it('names ending in s take a bare apostrophe', () => {
    const rows = rowsFor([book({ child_id: 'james', status: 'failed', scope_start_date: '2022-01-01', scope_end_date: '2022-12-31', scope_label: 'Year One', updated_at: '2026-10-01T10:00:00.000Z' })], [james]);
    expect(pick({ bookRows: rows, members: [james] })!.label).toBe('James’ book couldn’t be made');
  });

  it('picks the most recently updated failed book', () => {
    const older = book({ id: 'older', status: 'failed', updated_at: '2026-09-20T10:00:00.000Z' });
    const newer = book({
      id: 'newer',
      child_id: 'lucia',
      status: 'failed',
      scope_start_date: '2021-02-10',
      scope_end_date: '2022-02-09',
      updated_at: '2026-10-05T10:00:00.000Z',
    });
    const rows = rowsFor([older, newer], [tomas, lucia]);
    expect(pick({ bookRows: rows })!.target).toMatchObject({ bookId: 'newer' });
  });

  it('a failed book older than 30 days no longer raises the banner (but keeps its badge)', () => {
    const rows = failedBook({ updated_at: '2026-09-07T10:00:00.000Z' }); // exactly 30 days before TODAY
    expect(pick({ bookRows: rows })).toBeNull();
    expect(bookBadge(rows[0]!, null)).toEqual({ label: 'Couldn’t be made', tone: 'needsYou' });
    expect(pick({ bookRows: failedBook({ updated_at: '2026-09-08T10:00:00.000Z' }) })).not.toBeNull(); // 29 days
  });

  it('never for viewers', () => {
    expect(pick({ role: 'viewer', cardSummary: card(), bookRows: failedBook() })).toBeNull();
  });
});

describe('past-year holiday cards on their shelves', () => {
  it('files every ready card of the overview on its own year, newest first', () => {
    const items = build({
      cardSummary: card({ cardId: 'card-26', year: 2026 }),
      overview: overview({ cards: [cardEntry('card-26', 2026), cardEntry('card-25', 2025, { ordered: true }), cardEntry('card-24', 2024)] }),
    });
    expect(items.filter((i) => i.kind === 'card').map((i) => [i.id, i.year])).toEqual([
      ['card:card-26', 2026],
      ['card:card-25', 2025],
      ['card:card-24', 2024],
    ]);
  });

  it('keeps the current card on today’s logic and lists it once', () => {
    const items = build({
      cardSummary: card({ cardId: 'card-26', year: 2026, readiness: 'ready' }),
      overview: overview({ cards: [cardEntry('card-26', 2026)], card_front: pastFront('card-26', 2026) }),
    });
    const cards = items.filter((i) => i.kind === 'card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ isPast: false, cardState: 'ready', badge: { label: 'Ready to order', tone: 'needsYou' } });
  });

  it('falls back to today’s behaviour when cards is empty (old server)', () => {
    const items = build({ cardSummary: card(), overview: overview({ cards: [] }) });
    expect(items.filter((i) => i.kind === 'card').map((i) => i.id)).toEqual(['card:card-1']);
    expect(build({ overview: overview({ cards: [] }) }).filter((i) => i.kind === 'card')).toEqual([]);
  });

  it('hides generating and failed past cards', () => {
    const items = build({
      overview: overview({
        cards: [cardEntry('g', 2025, { status: 'generating' }), cardEntry('f', 2024, { status: 'failed' }), cardEntry('r', 2023)],
      }),
    });
    expect(items.filter((i) => i.kind === 'card').map((i) => i.id)).toEqual(['card:r']);
  });

  it('badges a past card from the orders only: Shipped with a date, Ordered, or nothing', () => {
    const items = build({
      overview: overview({
        cards: [cardEntry('shipped', 2025), cardEntry('ordered', 2024), cardEntry('plain', 2023)],
        orders: [
          order({ product: 'card', item_id: 'shipped', status: 'shipped', shipped_at: '2025-12-12T18:00:00+00:00' }),
          order({ product: 'card', item_id: 'ordered', status: 'in_production' }),
        ],
      }),
    });
    const badge = (id: string) => items.find((i) => i.id === id)!.badge;
    expect(badge('card:shipped')).toMatchObject({ tone: 'progress' });
    expect(badge('card:shipped')!.label).toMatch(/^Shipped · Dec \d{1,2}$/);
    expect(badge('card:ordered')).toEqual({ label: 'Ordered', tone: 'progress' });
    expect(badge('card:plain')).toBeNull(); // never "Ready to order"
    expect(items.find((i) => i.id === 'card:plain')).toMatchObject({ isPast: true, cardState: 'ready' });
    expect(items.find((i) => i.id === 'card:ordered')).toMatchObject({ cardState: 'ordered' });
  });

  it('pastCardBadge trusts the ordered flag when no order row came back', () => {
    expect(pastCardBadge({ card_id: 'x', ordered: true }, overview())).toEqual({ label: 'Ordered', tone: 'progress' });
    expect(pastCardBadge({ card_id: 'x', ordered: false }, null)).toBeNull();
  });

  it('a past card draws its own front; the current one keeps the matching card_front', () => {
    const items = build({
      cardSummary: card({ cardId: 'card-26', year: 2026 }),
      overview: overview({
        cards: [cardEntry('card-26', 2026), cardEntry('card-25', 2025)],
        card_front: pastFront('card-26', 2026),
      }),
    });
    const ov = overview({ card_front: pastFront('card-26', 2026) });
    const past = items.find((i) => i.id === 'card:card-25')!;
    const current = items.find((i) => i.id === 'card:card-26')!;
    expect(past.kind === 'card' && shelfCardFront(past, ov)?.card_id).toBe('card-25');
    expect(current.kind === 'card' && shelfCardFront(current, ov)?.card_id).toBe('card-26');
  });

  it('never reaches the needs-you banner and is not a current card', () => {
    const summary = card({ cardId: 'card-26', year: 2026, readiness: 'generating' });
    const items = build({ cardSummary: summary, overview: overview({ cards: [cardEntry('card-25', 2025)] }) });
    expect(items.find((i) => i.id === 'card:card-25')).toMatchObject({ isPast: true });
    expect(pickNeedsYou({ cardSummary: summary, bookRows: [], members: [tomas], role: 'owner', todayIso: TODAY })).toBeNull();
  });

  it('a stale summary card (season over, unordered) shows as a ready past card, once', () => {
    // Summary still returns last year's unordered card; the tile state is "make" (not on the shelf as current).
    const items = build({
      cardSummary: card({ cardId: 'card-25', year: 2025, ordered: false }),
      overview: overview({ cards: [cardEntry('card-25', 2025)] }),
    });
    expect(items.filter((i) => i.kind === 'card')).toEqual([expect.objectContaining({ id: 'card:card-25', isPast: true })]);
  });

  it('viewers never get cards', () => {
    expect(build({ role: 'viewer', overview: overview({ cards: [cardEntry('card-25', 2025)] }) }).filter((i) => i.kind === 'card')).toEqual([]);
  });

  it('past cards take part in the Holiday cards type filter, the year filter, chips and the year summary', () => {
    const items = build({ overview: overview({ cards: [cardEntry('card-25', 2025), cardEntry('card-24', 2024)] }), films: [film({ id: 'f', placement_date: '2025-03-01' })] });
    expect(applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, type: 'cards' }).map((i) => i.id)).toEqual(['card:card-25', 'card:card-24']);
    expect(applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, year: 2024 }).map((i) => i.id)).toEqual(['card:card-24']);
    expect(availableYears(items)).toEqual([2025, 2024]);
    const years = groupShelfByYear(items, TODAY);
    expect(years.map((y) => [y.year, yearSummaryLabel(y.items, 'owner')])).toEqual([
      [2025, '2 keepsakes'],
      [2024, '1 keepsake'],
    ]);
  });
});

describe('upcoming birthday and year-end films', () => {
  it('files each tile by film_date’s year, with the child’s memberId (year-end is family-wide)', () => {
    const items = build({ overview: overview({ upcoming_films: [upcomingFilm(), yearUpcoming()] }) });
    expect(items.map((i) => [i.id, i.year, i.memberId])).toEqual([
      ['upcoming-film:family_year:family:2027-01-01', 2027, null],
      ['upcoming-film:birthday:tomas:2026-11-20', 2026, 'tomas'],
    ]);
  });

  it('orders a shelf: upcoming recap, birthdays by film_date, upcoming year-end, year-end film, then date descending', () => {
    const items = build({
      films: [monthFilm('m-sep', '2026-09-30'), yearEndFilm('y-2026', 2026), monthFilm('m-aug', '2026-08-31')],
      overview: overview({
        recap: recap(),
        upcoming_films: [
          yearUpcoming({ film_date: '2026-12-31', scope_start: '2026-01-01' }),
          upcomingFilm({ member_id: 'lucia', film_date: '2026-12-10', age_year: 6 }),
          upcomingFilm({ member_id: 'tomas', film_date: '2026-11-20' }),
        ],
      }),
    });
    expect(items.map((i) => i.id)).toEqual([
      'upcoming-recap',
      'upcoming-film:birthday:tomas:2026-11-20',
      'upcoming-film:birthday:lucia:2026-12-10',
      'upcoming-film:family_year:family:2026-12-31',
      'film:y-2026',
      'film:m-sep',
      'film:m-aug',
    ]);
  });

  it('skips a birthday tile whose child is gone, but not the year-end tile', () => {
    const items = build({
      members: [lucia],
      overview: overview({ upcoming_films: [upcomingFilm({ member_id: 'tomas' }), yearUpcoming()] }),
    });
    expect(items.map((i) => i.kind)).toEqual(['upcoming-film']);
    expect(items[0]).toMatchObject({ memberId: null });
  });

  it('viewers see the tiles too', () => {
    const items = build({ role: 'viewer', overview: overview({ upcoming_films: [upcomingFilm(), yearUpcoming()] }) });
    expect(items).toHaveLength(2);
  });

  it('no badge, forced-open year, and not counted in the year summary', () => {
    const items = build({ overview: overview({ upcoming_films: [yearUpcoming()] }), films: [film({ id: 'old', placement_date: '2024-03-14' })] });
    expect(items.every((i) => i.badge === null)).toBe(true);
    const years = groupShelfByYear(items, TODAY);
    expect(years.map((y) => [y.year, y.isAlwaysOpen])).toEqual([
      [2027, true],
      [2024, false],
    ]);
    expect(yearSummaryLabel(years[0]!.items, 'owner')).toBe('0 keepsakes');
    expect(yearSummaryLabel(years[0]!.items, 'viewer')).toBe('0 films');
  });

  it('child chip shows the child’s birthday tile; year-end shows only under All; Films includes both', () => {
    const items = build({ overview: overview({ upcoming_films: [upcomingFilm(), yearUpcoming()] }) });
    expect(applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, memberId: 'tomas' }).map((i) => i.kind)).toEqual(['upcoming-film']);
    expect(applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, memberId: 'lucia' })).toEqual([]);
    expect(applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, type: 'films' })).toHaveLength(2);
    expect(applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, type: 'cards' })).toEqual([]);
    expect(applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, type: 'books' })).toEqual([]);
  });

  describe('locked / unlocked and the hint priority', () => {
    it('unlocked when every floor is met', () => {
      expect(isUpcomingFilmLocked(upcomingFilm({ moments: 15, visuals: 8 }))).toBe(false);
      expect(isUpcomingFilmLocked(yearUpcoming())).toBe(false);
    });

    it('moments short wins over pictures and seasons', () => {
      const f = upcomingFilm({ moments: 12, visuals: 2, quarters: 1, min_quarters: 3 });
      expect(isUpcomingFilmLocked(f)).toBe(true);
      expect(upcomingFilmHint(f)).toBe('3 more moments');
      expect(upcomingFilmHint({ ...f, moments: 14 })).toBe('1 more moment');
    });

    it('then pictures, then seasons', () => {
      expect(upcomingFilmHint(upcomingFilm({ moments: 20, visuals: 5, quarters: 1, min_quarters: 3 }))).toBe('3 more with a picture');
      const seasons = yearUpcoming({ quarters: 1, min_quarters: 3 });
      expect(isUpcomingFilmLocked(seasons)).toBe(true);
      expect(upcomingFilmHint(seasons)).toBe('2 more seasons');
      expect(upcomingFilmHint({ ...seasons, quarters: 2 })).toBe('Needs moments from one more season');
    });

    it('seasons only count when both numbers exist', () => {
      expect(isUpcomingFilmLocked(upcomingFilm({ moments: 15, visuals: 8, quarters: 0, min_quarters: null }))).toBe(false);
      expect(isUpcomingFilmLocked(upcomingFilm({ moments: 15, visuals: 8, quarters: null, min_quarters: 2 }))).toBe(false);
    });
  });

  describe('titles and captions', () => {
    const members = [tomas, { id: 'jesus', name: 'Jesus' }];

    it('birthday: "{Name} turns {age}" on the tile, "{Name}’s birthday film" in the caption', () => {
      expect(upcomingFilmTitle(upcomingFilm(), members)).toBe('Teo turns 4');
      expect(upcomingFilmCaptionTitle(upcomingFilm(), members)).toBe('Teo’s birthday film');
      expect(upcomingFilmCaptionTitle(upcomingFilm({ member_id: 'jesus' }), members)).toBe('Jesus’ birthday film');
      expect(upcomingFilmTitle(upcomingFilm({ member_id: 'gone' }), members)).toBeNull();
    });

    it('year-end: "Your {year}" from the window’s start year, like the finished film', () => {
      expect(upcomingFilmTitle(yearUpcoming(), members)).toBe('Your 2026');
      expect(upcomingFilmCaptionTitle(yearUpcoming(), members)).toBe('Your 2026');
    });

    it('caption meta: progress while locked, the date once unlocked', () => {
      expect(upcomingFilmCaptionMeta(upcomingFilm(), TODAY)).toBe('12 of 15 moments');
      expect(upcomingFilmCaptionMeta(upcomingFilm({ moments: 16, visuals: 9 }), TODAY)).toBe('arrives Nov 20 · 16 moments');
      expect(upcomingFilmCaptionMeta(yearUpcoming(), TODAY)).toBe('arrives Jan 1 · 40 moments');
    });

    it('caption meta: "arrives today" on the film date (the row exists, the reveal is later)', () => {
      expect(upcomingFilmCaptionMeta(upcomingFilm({ moments: 16, visuals: 9 }), '2026-11-20')).toBe('arrives today · 16 moments');
      expect(upcomingFilmCaptionMeta(upcomingFilm({ moments: 61, visuals: 41, min_moments: 60, min_visuals: 40 }), '2026-11-20')).toBe('arrives today · 61 moments');
      expect(upcomingFilmCaptionMeta(yearUpcoming({ film_date: '2026-12-30' }), '2026-12-30')).toBe('arrives today · 40 moments');
      // A locked tile still shows its progress, not a date.
      expect(upcomingFilmCaptionMeta(upcomingFilm(), '2026-11-20')).toBe('12 of 15 moments');
    });
  });
});

describe('applyKeepsakesFilter and friends', () => {
  const items = build({
    films: [
      film({ id: 'bday-tomas', family_member_id: 'tomas', placement_date: '2026-03-14' }),
      film({ id: 'bday-lucia', family_member_id: 'lucia', placement_date: '2025-02-10' }),
      monthFilm('m', '2026-09-30'),
    ],
    bookRows: rowsFor([book()], [tomas, lucia]),
    cardSummary: card(),
    overview: overview({ recap: recap() }),
  });

  it('defaults to everything', () => {
    expect(applyKeepsakesFilter(items, DEFAULT_KEEPSAKES_FILTER)).toEqual(items);
  });

  it('a child chip keeps only that child’s items; family-wide items show only under All', () => {
    const ids = applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, memberId: 'tomas' }).map((i) => i.id);
    expect(ids.sort()).toEqual(['book:book-1', 'film:bday-tomas']);
  });

  it('type filters by kind; the upcoming recap counts as Films', () => {
    const kinds = (type: 'films' | 'books' | 'cards') =>
      applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, type }).map((i) => i.kind);
    expect(new Set(kinds('films'))).toEqual(new Set(['film', 'upcoming-recap']));
    expect(kinds('books')).toEqual(['book']);
    expect(kinds('cards')).toEqual(['card']);
  });

  it('year keeps only that year; filters combine', () => {
    expect(applyKeepsakesFilter(items, { ...DEFAULT_KEEPSAKES_FILTER, year: 2025 }).map((i) => i.id)).toEqual(['film:bday-lucia']);
    expect(
      applyKeepsakesFilter(items, { memberId: 'tomas', type: 'films', year: 2026 }).map((i) => i.id),
    ).toEqual(['film:bday-tomas']);
    expect(applyKeepsakesFilter(items, { memberId: 'lucia', type: 'books', year: null })).toEqual([]);
  });

  it('lists the years that have items, newest first', () => {
    expect(availableYears(items)).toEqual([2026, 2025, 2024]);
  });

  it('reconcile drops a child or year that no longer exists', () => {
    const f = { memberId: 'tomas', type: 'films' as const, year: 2026 };
    expect(reconcileKeepsakesFilter(f, items)).toBe(f);
    expect(reconcileKeepsakesFilter({ ...f, memberId: 'gone', year: 1999 }, items)).toEqual({
      memberId: null,
      type: 'films',
      year: null,
    });
  });

  it('child chips: members with items, hidden below two', () => {
    const chips = buildChildChips(items, [tomas, lucia, james]);
    expect(chips.map((m) => m.id)).toEqual(['tomas', 'lucia']);
    expect(buildChildChips(items.filter((i) => i.memberId !== 'lucia'), [tomas, lucia])).toEqual([]);
  });
});

describe('groupShelfByYear and yearSummaryLabel', () => {
  it('groups newest year first and flags the all-recaps tile above 3 monthly recaps', () => {
    const three = [monthFilm('a', '2026-07-31'), monthFilm('b', '2026-08-31'), monthFilm('c', '2026-09-30')];
    let years = groupShelfByYear(build({ films: three }), TODAY);
    expect(years[0]).toMatchObject({ year: 2026, recapCount: 3, showAllRecapsTile: false });

    years = groupShelfByYear(build({ films: [...three, monthFilm('d', '2026-06-30')], }), TODAY);
    expect(years[0]).toMatchObject({ recapCount: 4, showAllRecapsTile: true });
    // Birthday films and year-end films are not recaps.
    years = groupShelfByYear(build({ films: [...three, film(), yearEndFilm('y', 2026)] }), TODAY);
    expect(years[0]).toMatchObject({ recapCount: 3, showAllRecapsTile: false });
  });

  it('marks the current year and past years', () => {
    const years = groupShelfByYear(build({ films: [film({ placement_date: '2024-03-14' }), film({ id: 'x', placement_date: '2026-03-14' })] }), TODAY);
    expect(years.map((y) => [y.year, y.isCurrent, y.isAlwaysOpen])).toEqual([
      [2026, true, true],
      [2024, false, false],
    ]);
  });

  it('summarises a year: keepsakes for owners, films for viewers, upcoming not counted', () => {
    const all = build({
      films: [film(), monthFilm('m', '2026-09-30')],
      bookRows: rowsFor([book({ scope_kind: 'everything', scope_start_date: null, scope_end_date: null, scope_label: 'Everything', created_at: '2026-05-31T10:00:00.000Z' })]),
      overview: overview({ recap: recap() }),
    });
    expect(yearSummaryLabel(all, 'owner')).toBe('3 keepsakes');
    expect(yearSummaryLabel(all, 'manager')).toBe('3 keepsakes');
    expect(yearSummaryLabel(all, 'viewer')).toBe('2 films');
    expect(yearSummaryLabel(all.filter((i) => i.kind === 'film').slice(0, 1), 'owner')).toBe('1 keepsake');
    expect(yearSummaryLabel(all.filter((i) => i.kind === 'film').slice(0, 1), 'viewer')).toBe('1 film');
  });
});

describe('splitScopeOptions', () => {
  const split = (dob: string | null, books: MemoryBookListRow[] = [], today = TODAY) => {
    const options = buildMemoryBookScopeOptions(dob, today);
    const rows = buildMemoryBookRows(options, books);
    return splitScopeOptions(options, rows, today);
  };
  const labels = (choices: { option: { label: string } }[]) => choices.map((c) => c.option.label);

  it('a newborn: visible = [Everything]; the in-progress year sits under more', () => {
    const result = split('2026-04-01');
    expect(labels(result.visible)).toEqual(['Everything']);
    const years = result.more.find((g) => g.title === 'Years of life')!;
    expect(labels(years.choices)).toEqual(['Year One']);
    expect(years.choices[0]!.caution).toBe('in_progress_year');
    expect(result.more.find((g) => g.title === 'Calendar years')).toBeDefined();
    expect(result.more.find((g) => g.title === 'Everything')).toBeUndefined();
    expect(result.defaultChoice!.option.label).toBe('Everything');
  });

  it('a 1-year-old: [Year One, Everything]', () => {
    const result = split('2025-05-01');
    expect(labels(result.visible)).toEqual(['Year One', 'Everything']);
    expect(result.defaultChoice!.option.label).toBe('Year One');
    // Year Two is in progress, so it is under more
    expect(labels(result.more.find((g) => g.title === 'Years of life')!.choices)).toEqual(['Year Two']);
  });

  it('a 6-year-old with Year Six and Year Five made: both visible and labeled, default moves on to Everything', () => {
    const dob = '2020-03-15';
    // Born 2020-03-15: Year Six ended 2026-03-14, so Year Seven is the one in progress.
    const yearSix = book({ id: 'y6', child_id: 'x', scope_start_date: '2025-03-15', scope_end_date: '2026-03-14', scope_label: 'Year Six' });
    const yearFive = book({ id: 'y5', child_id: 'x', scope_start_date: '2024-03-15', scope_end_date: '2025-03-14', scope_label: 'Year Five', status: 'queued' });
    const result = split(dob, [yearSix, yearFive]);
    expect(labels(result.visible)).toEqual(['Year Six', 'Year Five']);
    expect(result.visible.map((c) => c.statusLabel)).toEqual(['already made', 'being made']);
    expect(result.more.some((g) => g.title === 'Everything')).toBe(true);
    expect(result.defaultChoice!.option.label).toBe('Everything');
    // Older years and the in-progress year are under more
    expect(labels(result.more.find((g) => g.title === 'Years of life')!.choices)).toEqual([
      'Year One',
      'Year Two',
      'Year Three',
      'Year Four',
      'Year Seven',
    ]);
  });

  it('defaults to the first visible choice without a book', () => {
    const yearSix = book({ id: 'y6', child_id: 'x', scope_start_date: '2025-03-15', scope_end_date: '2026-03-14', scope_label: 'Year Six' });
    const result = split('2020-03-15', [yearSix]);
    expect(result.defaultChoice!.option.label).toBe('Year Five');
  });

  it('falls back to the first visible choice when everything has a book', () => {
    const dob = '2025-05-01';
    const yearOne = book({ id: 'y1', child_id: 'x', scope_start_date: '2025-05-01', scope_end_date: '2026-04-30', scope_label: 'Year One' });
    const everything = book({ id: 'all', child_id: 'x', scope_kind: 'everything', scope_start_date: null, scope_end_date: null, scope_label: 'Everything' });
    const result = split(dob, [yearOne, everything]);
    expect(result.defaultChoice!.option.label).toBe('Year One');
  });

  it('the current calendar year is never visible and carries the mid-year caution', () => {
    for (const dob of ['2026-04-01', '2025-05-01', '2020-03-15', '2010-01-01']) {
      const result = split(dob);
      expect(result.visible.some((c) => c.option.kind === 'calendar_year')).toBe(false);
      expect(result.visible.every((c) => c.caution === null)).toBe(true);
    }
    const calendar = split('2020-03-15').more.find((g) => g.title === 'Calendar years')!;
    expect(calendar.choices.find((c) => c.option.calendarYear === 2026)!.caution).toBe('mid_year');
    expect(calendar.choices.find((c) => c.option.calendarYear === 2025)!.caution).toBeNull();
  });

  it('without a date of birth only Everything is visible', () => {
    const result = split(null);
    expect(labels(result.visible)).toEqual(['Everything']);
    expect(result.more.map((g) => g.title)).toEqual(['Calendar years']);
  });
});
