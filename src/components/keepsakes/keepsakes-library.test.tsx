import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, within } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import { StyleSheet } from 'react-native';

import { KeepsakesLibrary } from '@/components/keepsakes/keepsakes-library';
import type { KeepsakesCardFront, KeepsakesOverview, KeepsakesUpcomingFilm } from '@/services/keepsakes';
import type { YearFilm } from '@/services/year-films';
import { DEFAULT_KEEPSAKES_FILTER, type ShelfItem } from '@/utils/keepsakes';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('@/components/family-member-avatar', () => ({ FamilyMemberAvatar: () => null }));
jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(() => ({ url: undefined, isLoading: false, isError: false })),
}));
jest.mock('@/hooks/useYearFilms', () => ({
  useYearFilmPosters: jest.fn(() => ({})),
  invalidateYearFilmPoster: jest.fn(),
}));

const lila = { id: 'c1', name: 'Lila Park' };
const theo = { id: 'c2', name: 'Theo' };

function filmItem(id: string, year: number, month: number, extra: Partial<YearFilm> = {}, memberId: string | null = null): ShelfItem {
  const mm = String(month).padStart(2, '0');
  const film = {
    id,
    family_id: 'f1',
    kind: 'family_month',
    family_member_id: null,
    age_year: null,
    scope_start_date: `${year}-${mm}-01`,
    placement_date: `${year}-${mm}-28`,
    duration_ms: 60000,
    ready_at: `${year}-${mm}-28T10:00:00Z`,
    status: 'ready',
    blocked: false,
    stale: false,
    ...extra,
  } as YearFilm;
  return { kind: 'film', id: `film:${id}`, year, date: film.placement_date, memberId, badge: null, film, displayState: 'ready' };
}

function bookItem(id: string, year: number, memberId: string): ShelfItem {
  return {
    kind: 'book',
    id: `book:${id}`,
    year,
    date: `${year}-05-31`,
    memberId,
    badge: { label: 'Being made', tone: 'progress' },
    row: {
      key: `age_year:${id}`,
      option: { kind: 'age_year', label: 'Year One', eraLine: null, startDate: '2023-06-01', endDate: '2024-05-31', ageYear: 1 },
      book: { id, child_id: memberId, cover_asset_key: null, updated_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', scope_start_date: '2023-06-01', scope_end_date: '2024-05-31' },
      status: 'in_progress',
      eligibleCount: null,
      disabledReason: null,
      dispatchError: null,
      isPending: false,
    },
  } as unknown as ShelfItem;
}

function cardItem(cardId: string, year: number): ShelfItem {
  return {
    kind: 'card',
    isPast: false,
    id: `card:${cardId}`,
    year,
    date: `${year}-12-01`,
    memberId: null,
    badge: { label: 'Ready to order', tone: 'needsYou' },
    cardId,
    cardState: 'ready',
    summary: {
      enabled: true, cardId, year, status: 'ready', readiness: 'ready', lastFailureCode: null, ordered: false, language: 'es',
    },
  };
}

const cardFront: KeepsakesCardFront = {
  card_id: 'card-1',
  year: 2026,
  image_key: 'family/front.jpg',
  width: 4000,
  height: 3000,
  layout: 'full-bleed',
  orientation: 'landscape',
  focal: null,
  greeting: 'christmas',
  language: 'en',
  greeting_text: 'Merry Everything',
  subline_text: null,
  greeting_position: 'top-left',
};

const overview: KeepsakesOverview = {
  recap: null, previous_recap: null, has_viewers: true, year_moments: null, holiday_pool: null, holiday_min_pool: null,
  holiday_ship_by_note: null, preview_key: null, book_preview_keys: {}, orders: [], card_front: null,
  cards: [], upcoming_films: [],
};

function renderLibrary(overrides: Partial<ComponentProps<typeof KeepsakesLibrary>> = {}) {
  const props: ComponentProps<typeof KeepsakesLibrary> = {
    items: [
      filmItem('jun26', 2026, 6),
      bookItem('b1', 2024, 'c1'),
      filmItem('mar24', 2024, 3, {}, null),
    ],
    members: [lila, theo] as never,
    role: 'owner',
    overview,
    todayIso: '2026-10-15',
    filter: DEFAULT_KEEPSAKES_FILTER,
    onSelectChild: jest.fn(),
    onOpenFilter: jest.fn(),
    onResetFilter: jest.fn(),
    openYears: new Set<number>(),
    onToggleYear: jest.fn(),
    onBookPress: jest.fn(),
    ...overrides,
  };
  const client = new QueryClient();
  return {
    props,
    ...render(
      <QueryClientProvider client={client}>
        <KeepsakesLibrary {...props} />
      </QueryClientProvider>,
    ),
  };
}

function pastCardItem(cardId: string, year: number, front: KeepsakesCardFront | null, badge: ShelfItem['badge'] = null): ShelfItem {
  return {
    kind: 'card',
    isPast: true,
    id: `card:${cardId}`,
    year,
    date: `${year}-12-01`,
    memberId: null,
    badge,
    cardId,
    cardState: badge ? 'ordered' : 'ready',
    front,
  };
}

function upcomingFilmItem(overrides: Partial<KeepsakesUpcomingFilm> = {}): ShelfItem {
  const upcoming: KeepsakesUpcomingFilm = {
    kind: 'birthday', member_id: 'c1', age_year: 4, film_date: '2026-11-20', scope_start: '2025-11-20',
    scope_end_excl: '2026-11-20', moments: 12, visuals: 9, min_moments: 15, min_visuals: 8,
    quarters: null, min_quarters: null, picture_key: null, ...overrides,
  };
  return {
    kind: 'upcoming-film',
    id: `upcoming-film:${upcoming.kind}:${upcoming.member_id ?? 'family'}:${upcoming.film_date}`,
    year: Number(upcoming.film_date.slice(0, 4)),
    date: upcoming.film_date,
    memberId: upcoming.kind === 'birthday' ? upcoming.member_id : null,
    badge: null,
    upcoming,
  };
}

describe('KeepsakesLibrary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('current year open with its films; a past year folds into a summary row', () => {
    const { getByTestId, queryByTestId, getByText } = renderLibrary();
    expect(getByTestId('keepsakes-library')).toBeTruthy();
    expect(getByTestId('keepsakes-film-jun26')).toBeTruthy();
    expect(getByTestId('keepsakes-year-2024')).toBeTruthy();
    expect(getByText('2024')).toBeTruthy();
    expect(getByText(' · 2 keepsakes')).toBeTruthy();
    expect(queryByTestId('keepsakes-film-mar24')).toBeNull();
    expect(queryByTestId('memory-book-tile-age_year:b1')).toBeNull();
    // The current year has no toggle: it is always open.
    expect(queryByTestId('keepsakes-year-toggle-2026')).toBeNull();
  });

  it('tapping a folded year asks to open it; an open past year shows its items and asks to fold', () => {
    const closed = renderLibrary();
    fireEvent.press(closed.getByTestId('keepsakes-year-toggle-2024'));
    expect(closed.props.onToggleYear).toHaveBeenCalledWith(2024, true);
    closed.unmount();

    const open = renderLibrary({ openYears: new Set([2024]) });
    expect(open.getByTestId('keepsakes-film-mar24')).toBeTruthy();
    expect(open.getByTestId('memory-book-tile-age_year:b1')).toBeTruthy();
    fireEvent.press(open.getByTestId('keepsakes-year-toggle-2024'));
    expect(open.props.onToggleYear).toHaveBeenCalledWith(2024, false);
  });

  it('a filtered year is forced open and not toggleable', () => {
    const { getByTestId, queryByTestId } = renderLibrary({ filter: { ...DEFAULT_KEEPSAKES_FILTER, year: 2024 } });
    expect(getByTestId('keepsakes-film-mar24')).toBeTruthy();
    expect(queryByTestId('keepsakes-year-toggle-2024')).toBeNull();
  });

  it('shows a badge under the book', () => {
    const { getByText } = renderLibrary({ openYears: new Set([2024]) });
    expect(getByText('Being made')).toBeTruthy();
  });

  it('owner header: eyebrow, filter button with only the sheet fields counted', () => {
    const none = renderLibrary({ filter: { memberId: 'c1', type: 'all', year: null } });
    expect(none.getByText('Your keepsakes')).toBeTruthy();
    expect(none.queryByTestId('keepsakes-filter-dot')).toBeNull();
    none.unmount();

    const two = renderLibrary({ filter: { memberId: null, type: 'films', year: 2026 } });
    expect(two.getByTestId('keepsakes-filter-dot')).toHaveTextContent('2');
    fireEvent.press(two.getByTestId('keepsakes-filter-button'));
    expect(two.props.onOpenFilter).toHaveBeenCalled();
  });

  it('viewers have no section header or filter button (theirs is in the page header)', () => {
    const { queryByText, queryByTestId } = renderLibrary({ role: 'viewer', items: [filmItem('jun26', 2026, 6)] });
    expect(queryByText('Your keepsakes')).toBeNull();
    expect(queryByTestId('keepsakes-filter-button')).toBeNull();
  });

  it('privacy line only when the family has a viewer', () => {
    const withViewers = renderLibrary();
    expect(withViewers.getByText('Books and cards are only visible to owners and managers.')).toBeTruthy();
    withViewers.unmount();
    const without = renderLibrary({ overview: { ...overview, has_viewers: false } });
    expect(without.queryByTestId('keepsakes-privacy')).toBeNull();
    without.unmount();
    const noOverview = renderLibrary({ overview: null });
    expect(noOverview.queryByTestId('keepsakes-privacy')).toBeNull();
  });

  it('child chips appear with two or more children that have items and select a child', () => {
    const items = [filmItem('jun26', 2026, 6), bookItem('b1', 2026, 'c1'), bookItem('b2', 2026, 'c2')];
    const { getByTestId, getByText, props } = renderLibrary({ items });
    expect(getByTestId('keepsakes-chip-all')).toBeTruthy();
    expect(getByText('Lila')).toBeTruthy();
    fireEvent.press(getByTestId('keepsakes-chip-c2'));
    expect(props.onSelectChild).toHaveBeenCalledWith('c2');
    fireEvent.press(getByTestId('keepsakes-chip-all'));
    expect(props.onSelectChild).toHaveBeenCalledWith(null);
  });

  it('hides the chips with fewer than two children', () => {
    const { queryByTestId } = renderLibrary({ items: [filmItem('jun26', 2026, 6), bookItem('b1', 2026, 'c1')] });
    expect(queryByTestId('keepsakes-chip-all')).toBeNull();
  });

  it('a filter that matches nothing offers a reset', () => {
    const { getByTestId, props } = renderLibrary({ filter: { memberId: null, type: 'cards', year: null } });
    expect(getByTestId('keepsakes-filter-empty')).toBeTruthy();
    fireEvent.press(getByTestId('keepsakes-filter-empty-reset'));
    expect(props.onResetFilter).toHaveBeenCalled();
  });

  it('empty library: the owner line, or the viewer-empty message', () => {
    const owner = renderLibrary({ items: [] });
    expect(owner.getByText('Films show up here on their own. Your first one is on its way.')).toBeTruthy();
    expect(owner.queryByTestId('keepsakes-filter-button')).toBeNull();
    owner.unmount();

    const viewer = renderLibrary({ items: [], role: 'viewer' });
    expect(viewer.getByTestId('keepsakes-viewer-empty')).toBeTruthy();
    expect(viewer.getByText('Books and films your family makes will show up here.')).toBeTruthy();
  });

  it('ends a year with more than three monthly recaps with the "All {year} recaps" tile', () => {
    const items = [1, 2, 3, 4].map((m) => filmItem(`m${m}`, 2026, m));
    const many = renderLibrary({ items });
    fireEvent.press(many.getByTestId('keepsakes-recaps-2026'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/keepsakes/recaps/2026');
    many.unmount();

    const few = renderLibrary({ items: items.slice(0, 3) });
    expect(few.queryByTestId('keepsakes-recaps-2026')).toBeNull();
  });

  it('opens a film from its poster', () => {
    const { getByTestId } = renderLibrary();
    fireEvent.press(getByTestId('keepsakes-film-jun26'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/jun26?source=keepsakes');
  });

  it('a failed-book tap is forwarded; the library shows no price', () => {
    const item = bookItem('b1', 2026, 'c1') as Extract<ShelfItem, { kind: 'book' }>;
    const { getByTestId, props, toJSON } = renderLibrary({ items: [item] });
    // In progress is disabled; a failed row would go through onBookPress.
    expect(getByTestId('memory-book-tile-age_year:b1')).toBeTruthy();
    expect(props.onBookPress).not.toHaveBeenCalled();
    expect(JSON.stringify(toJSON())).not.toMatch(/\$\d/);
  });

  describe('the holiday card on the shelf', () => {
    it('shows the family’s real card front, landscape: a 179-wide item with a 150-wide card', () => {
      const { getByTestId, getByText } = renderLibrary({
        items: [cardItem('card-1', 2026)],
        overview: { ...overview, card_front: cardFront },
      });
      expect(getByTestId('keepsakes-item-card:card-1').props.style).toEqual({ width: 179 });
      expect(StyleSheet.flatten(getByTestId('keepsakes-card-card-1').props.style)).toMatchObject({ width: 179, height: 122 });
      expect(getByTestId('keepsakes-card-card-1-object-front')).toBeTruthy();
      expect(getByText('Merry Everything')).toBeTruthy();
      expect(within(getByTestId('keepsakes-card-card-1-object-front')).getByText('2026')).toBeTruthy();
    });

    it('a portrait card is 104 wide in a 132-wide item', () => {
      const { getByTestId } = renderLibrary({
        items: [cardItem('card-1', 2026)],
        overview: { ...overview, card_front: { ...cardFront, orientation: 'portrait', layout: 'bordered' } },
      });
      expect(getByTestId('keepsakes-item-card:card-1').props.style).toEqual({ width: 132 });
      expect(StyleSheet.flatten(getByTestId('keepsakes-card-card-1').props.style)).toMatchObject({ width: 132, height: 161 });
    });

    it.each([
      ['no overview', null],
      ['no card_front (old server)', overview],
      ['a different card’s front', { ...overview, card_front: { ...cardFront, card_id: 'other-card' } }],
    ])('falls back to the generic preview with %s (greeting in the summary language, just the year)', (_label, ov) => {
      const { getByTestId, getByText, queryByTestId } = renderLibrary({ items: [cardItem('card-1', 2026)], overview: ov });
      expect(queryByTestId('keepsakes-card-card-1-object-front')).toBeNull();
      expect(getByTestId('keepsakes-item-card:card-1').props.style).toEqual({ width: 132 });
      expect(getByText('Felices fiestas')).toBeTruthy();
      expect(within(getByTestId('keepsakes-card-card-1-object')).getByText('2026')).toBeTruthy();
    });
  });
  describe('past-year holiday cards', () => {
    it('a folded past year counts its card; opened, the card draws its own front with its badge', () => {
      const items = [
        filmItem('jun26', 2026, 6),
        pastCardItem('card-25', 2025, { ...cardFront, card_id: 'card-25', year: 2025 }, { label: 'Shipped · Dec 12', tone: 'progress' }),
      ];
      const folded = renderLibrary({ items });
      expect(folded.getByText(' · 1 keepsake')).toBeTruthy();
      expect(folded.queryByTestId('keepsakes-card-card-25')).toBeNull();
      folded.unmount();

      const open = renderLibrary({ items, openYears: new Set([2025]) });
      expect(open.getByTestId('keepsakes-item-card:card-25').props.style).toEqual({ width: 179 });
      expect(open.getByTestId('keepsakes-card-card-25-object-front')).toBeTruthy();
      expect(within(open.getByTestId('keepsakes-card-card-25-object-front')).getByText('2025')).toBeTruthy();
      expect(open.getByTestId('keepsakes-badge-card:card-25')).toHaveTextContent('Shipped · Dec 12');
    });

    it('an unordered past card has no badge; without a front it falls back to the generic preview', () => {
      const { getByTestId, queryByTestId } = renderLibrary({
        items: [pastCardItem('card-25', 2025, null)],
        openYears: new Set([2025]),
      });
      expect(queryByTestId('keepsakes-badge-card:card-25')).toBeNull();
      expect(queryByTestId('keepsakes-card-card-25-object-front')).toBeNull();
      expect(getByTestId('keepsakes-item-card:card-25').props.style).toEqual({ width: 132 });
    });
  });

  describe('upcoming birthday and year-end tiles', () => {
    it('render first on their year’s shelf, forced open, with a caption and no badge or count', () => {
      const { getByTestId, getByText, queryByTestId } = renderLibrary({
        items: [upcomingFilmItem({ film_date: '2027-01-15', scope_start: '2026-01-15' })],
        members: [lila, theo] as never,
      });
      expect(getByTestId('keepsakes-year-2027')).toBeTruthy();
      expect(queryByTestId('keepsakes-year-toggle-2027')).toBeNull();
      expect(getByTestId('keepsakes-upcoming-birthday-c1')).toBeTruthy();
      expect(getByText('Lila Park turns 4')).toBeTruthy();
      expect(getByText('Lila Park’s birthday film')).toBeTruthy();
      expect(getByText('12 of 15 moments')).toBeTruthy();
      expect(queryByTestId('keepsakes-badge-upcoming-film:birthday:c1:2027-01-15')).toBeNull();
      expect(within(getByTestId('keepsakes-year-2027')).queryByText(/keepsake/)).toBeNull();
    });

    it('year-end tile: "Your {year}" caption, no children chip needed', () => {
      const { getByTestId, getAllByText } = renderLibrary({
        items: [upcomingFilmItem({ kind: 'family_year', member_id: null, age_year: null, film_date: '2027-01-01', scope_start: '2026-01-01', quarters: 1, min_quarters: 3, moments: 40, visuals: 20, min_moments: 30, min_visuals: 15 })],
      });
      expect(getByTestId('keepsakes-upcoming-year-2026')).toBeTruthy();
      expect(getAllByText('Your 2026')).toHaveLength(2);
    });
  });
});
