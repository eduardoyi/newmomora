import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Linking } from 'react-native';

import KeepsakesScreen from '../../app/(app)/(tabs)/keepsakes';
import MemberKeepsakesScreen from '../../app/(app)/keepsakes/[memberId]';
import KeepsakeRecapsScreen from '../../app/(app)/keepsakes/recaps/[year]';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { useFamilyMemoryBooks, useMemoryBooks, type MemoryBookScopeRow } from '@/hooks/useMemoryBooks';
import { useFamilyYearFilms, useYearFilmsEnabled } from '@/hooks/useYearFilms';
import type { MemoryBookListRow } from '@/services/memory-books';
import type { YearFilm } from '@/services/year-films';

// Keepsakes (docs/plans/timeline-calendar-keepsakes.md C2-C5,
// docs/plans/year-film-p2.md Step 7): the tab's year sections and the
// per-child route both render KeepsakesBody. Shelves derive from ONE
// family-wide books query and the family films query (both mocked here), with
// the real buildMemoryBookRows / buildKeepsakeYears; the create/retry flow's
// per-child hook is mocked. "Today" is pinned to 2026-10-15.

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn(), navigate: jest.fn(), push: jest.fn() };
let mockMemberId = 'child-1';
let mockYear = '2026';

let mockGalleryImportEnabled = true;
jest.mock('@/utils/gallery-import-flags', () => ({
  get isGalleryImportFeatureEnabled() {
    return mockGalleryImportEnabled;
  },
}));

jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
  useLocalSearchParams: () => ({ memberId: mockMemberId, year: mockYear }),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
  useIsFocused: () => true,
}));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useMemoryBooks', () => ({
  ...jest.requireActual('@/hooks/useMemoryBooks'),
  useFamilyMemoryBooks: jest.fn(),
  useMemoryBooks: jest.fn(),
}));
jest.mock('@/hooks/useYearFilms', () => ({
  useFamilyYearFilms: jest.fn(),
  useYearFilmsEnabled: jest.fn(),
  useYearFilmPosters: jest.fn(() => ({})),
  invalidateYearFilmPoster: jest.fn(),
}));
jest.mock('@/utils/portrait-versions', () => ({
  ...jest.requireActual('@/utils/portrait-versions'),
  getLocalTodayIso: () => '2026-10-15',
}));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: undefined, isLoading: false, isError: false })) }));
jest.mock('@/services/memory-books', () => ({
  ...jest.requireActual('@/services/memory-books'),
  fetchExampleCoverAssetKey: jest.fn(async () => ({ data: null, error: null })),
}));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseFamilyMemoryBooks = useFamilyMemoryBooks as jest.MockedFunction<typeof useFamilyMemoryBooks>;
const mockedUseMemoryBooks = useMemoryBooks as jest.MockedFunction<typeof useMemoryBooks>;
const mockedUseFamilyYearFilms = useFamilyYearFilms as jest.MockedFunction<typeof useFamilyYearFilms>;
const mockedUseYearFilmsEnabled = useYearFilmsEnabled as jest.MockedFunction<typeof useYearFilmsEnabled>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { trackEvent: mockTrackEvent } = require('@/services/analytics') as { trackEvent: jest.Mock };

const lila = { id: 'child-1', family_id: 'family-1', name: 'Lila', date_of_birth: '2023-06-01', relationship: null };
const theo = { id: 'child-2', family_id: 'family-1', name: 'Theo', date_of_birth: '2025-02-01', relationship: 'child' };
const grandma = { id: 'grandma', family_id: 'family-1', name: 'Mirian', date_of_birth: '1955-01-01', relationship: 'grandparent' };
const niece = { id: 'niece', family_id: 'family-1', name: 'Elena', date_of_birth: '2021-01-01', relationship: 'cousin' };

function book(overrides: Partial<MemoryBookListRow>): MemoryBookListRow {
  return {
    id: 'book-1',
    family_id: 'family-1',
    child_id: 'child-1',
    status: 'ready',
    scope_kind: 'age_year',
    scope_start_date: '2023-06-01',
    scope_end_date: '2024-05-31',
    scope_label: 'Year One',
    failure_reason: null,
    cover_asset_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const yearOneReady = book({ id: 'book-1', status: 'ready' });
const yearTwoGenerating = book({
  id: 'book-2', status: 'generating', scope_start_date: '2024-06-01', scope_end_date: '2025-05-31',
  scope_label: 'Year Two', created_at: '2026-02-01T00:00:00.000Z',
});
const yearThreeFailed = book({
  id: 'book-3', status: 'failed', scope_start_date: '2025-06-01', scope_end_date: '2026-05-31',
  scope_label: 'Year Three', failure_reason: 'Outline generation failed', created_at: '2026-03-01T00:00:00.000Z',
});
const YEAR_ONE_KEY = 'age_year:2023-06-01:2024-05-31';
const YEAR_THREE_KEY = 'age_year:2025-06-01:2026-05-31';

function film(overrides: Partial<YearFilm> & { id: string }): YearFilm {
  return {
    family_id: 'family-1',
    kind: 'family_month',
    family_member_id: null,
    age_year: null,
    scope_start_date: '2026-09-01',
    scope_end_exclusive: '2026-10-01',
    scope_label: null,
    language: 'en',
    placement_date: '2026-09-30',
    duration_ms: 60000,
    surface_at: '2026-10-01T19:00:00.000Z',
    ready_at: '2026-10-01T18:00:00.000Z',
    edits_version: 0,
    status: 'ready',
    blocked: false,
    stale: false,
    ...overrides,
  } as YearFilm;
}

function recap(month: number): YearFilm {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(2026, month, 0).getDate();
  return film({
    id: `recap-${mm}`,
    kind: 'family_month',
    scope_start_date: `2026-${mm}-01`,
    placement_date: `2026-${mm}-${lastDay}`,
  });
}

const yearEndFilm = film({
  id: 'year-end-2025', kind: 'family_year', scope_start_date: '2025-01-01', placement_date: '2025-12-31',
});
const lilaBirthday2026 = film({
  id: 'birthday-lila-2026', kind: 'birthday', family_member_id: 'child-1', age_year: 4,
  scope_start_date: '2025-06-01', placement_date: '2026-06-02',
});
const lilaBirthday2025 = film({
  id: 'birthday-lila-2025', kind: 'birthday', family_member_id: 'child-1', age_year: 3,
  scope_start_date: '2024-06-01', placement_date: '2025-06-02',
});
const theoBirthday2026 = film({
  id: 'birthday-theo-2026', kind: 'birthday', family_member_id: 'child-2', age_year: 2,
  scope_start_date: '2025-02-01', placement_date: '2026-02-02',
});

const generate = jest.fn();

function mockFilms(films: YearFilm[], { upcoming = false, isLoading = false } = {}) {
  mockedUseFamilyYearFilms.mockReturnValue({
    films, isLoading, isFetched: true, isRefetching: false, isError: false, error: null, refetch: jest.fn(),
  } as unknown as ReturnType<typeof useFamilyYearFilms>);
  mockedUseYearFilmsEnabled.mockReturnValue({ enabled: upcoming, isLoading: false, isError: false });
}

function sheetRow(overrides: Partial<MemoryBookScopeRow>): MemoryBookScopeRow {
  return {
    key: 'age_year:2022-06-01:2023-05-31',
    option: { kind: 'age_year', label: 'Year Four', eraLine: 'Jun 2022 – May 2023', startDate: '2022-06-01', endDate: '2023-05-31', ageYear: 4 },
    book: null,
    status: 'available',
    eligibleCount: 45,
    disabledReason: null,
    dispatchError: null,
    isPending: false,
    ...overrides,
  };
}

function mockBooks(books: MemoryBookListRow[]) {
  const booksByChild = new Map<string, MemoryBookListRow[]>();
  for (const entry of books) {
    booksByChild.set(entry.child_id!, [...(booksByChild.get(entry.child_id!) ?? []), entry]);
  }
  mockedUseFamilyMemoryBooks.mockReturnValue({ booksByChild, isLoading: false, isError: false, refetch: jest.fn() } as never);
}

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGalleryImportEnabled = true;
  mockMemberId = 'child-1';
  mockYear = '2026';
  mockFilms([]);
  mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' } as ReturnType<typeof useFamily>);
  mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
  mockedUseMemoryBooks.mockReturnValue({
    rows: [sheetRow({})],
    isLoading: false,
    isError: false,
    isEligibilityLoading: false,
    exampleCoverAssetKey: null,
    generate,
    retryDispatch: jest.fn(),
    refresh: jest.fn(),
  } as ReturnType<typeof useMemoryBooks>);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
});

describe('One child\'s keepsakes (keepsakes/[memberId])', () => {
  it('renders a shelf tile per book state from the family-wide books query', () => {
    mockBooks([yearOneReady, yearTwoGenerating, yearThreeFailed]);
    const { getByTestId, getByText } = renderWithQuery(<MemberKeepsakesScreen />);

    expect(getByText('Lila’s keepsakes')).toBeTruthy();
    expect(getByTestId(`memory-book-tile-${YEAR_ONE_KEY}`)).toBeTruthy();
    expect(getByText('We’re making it')).toBeTruthy();
    expect(getByText('Didn’t finish')).toBeTruthy();
    expect(getByText('Tap to try again')).toBeTruthy();
    // The per-child flow hook isn't mounted until a flow starts.
    expect(mockedUseMemoryBooks).not.toHaveBeenCalled();
  });

  it('opens the web viewer for a ready book', async () => {
    mockBooks([yearOneReady]);
    const { getByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
    fireEvent.press(getByTestId(`memory-book-tile-${YEAR_ONE_KEY}`));
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('https://shop.usemomora.com/b/book-1'));
  });

  it('retries a failed book through the retry sheet', async () => {
    mockBooks([yearThreeFailed]);
    const { getByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
    fireEvent.press(getByTestId(`memory-book-tile-${YEAR_THREE_KEY}`));

    await waitFor(() => expect(getByTestId('retry-book-sheet')).toBeTruthy());
    expect(mockedUseMemoryBooks).toHaveBeenCalledWith(expect.objectContaining({ childId: 'child-1' }));
    fireEvent.press(getByTestId('retry-book-confirm'));

    await waitFor(() => expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'age_year', startDate: '2025-06-01', endDate: '2026-05-31' }),
    ));
  });

  it('creates a book from the CTA, with a toast', async () => {
    mockBooks([yearOneReady]);
    const { getByTestId, getByText } = renderWithQuery(<MemberKeepsakesScreen />);
    fireEvent.press(getByTestId('memory-books-create'));

    const suggestion = await waitFor(() => getByTestId('create-book-suggestion-age_year:2022-06-01:2023-05-31'));
    fireEvent.press(suggestion);

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ label: 'Year Four' }));
    await waitFor(() => expect(getByText('We’re making your Year Four book. We’ll let you know when it’s ready.')).toBeTruthy());
  });

  it('shows existing books read-only to a viewer', () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as ReturnType<typeof useFamily>);
    mockBooks([yearOneReady]);
    const { getByTestId, queryByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
    expect(getByTestId(`memory-book-tile-${YEAR_ONE_KEY}`)).toBeTruthy();
    expect(queryByTestId('memory-books-create')).toBeNull();
  });

  it('uses the personalized pitch when the child has no books', () => {
    mockBooks([]);
    const { getByTestId, getByText } = renderWithQuery(<MemberKeepsakesScreen />);
    expect(getByTestId('memory-books-empty')).toBeTruthy();
    expect(getByText('A year of Lila, printed and bound.')).toBeTruthy();
  });

  it('shows the child\'s birthday films above the books, newest first, and only theirs', () => {
    mockFilms([lilaBirthday2025, theoBirthday2026, lilaBirthday2026, recap(9)]);
    mockBooks([yearOneReady]);
    const { getByTestId, queryByTestId, getAllByTestId } = renderWithQuery(<MemberKeepsakesScreen />);

    expect(getByTestId('keepsakes-child-films')).toBeTruthy();
    expect(getAllByTestId(/^keepsakes-film-/).map((node) => node.props.testID)).toEqual([
      'keepsakes-film-birthday-lila-2026',
      'keepsakes-film-birthday-lila-2025',
    ]);
    expect(queryByTestId('keepsakes-film-birthday-theo-2026')).toBeNull();
    expect(getByTestId(`memory-book-tile-${YEAR_ONE_KEY}`)).toBeTruthy();

    fireEvent.press(getByTestId('keepsakes-film-birthday-lila-2026'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/birthday-lila-2026?source=keepsakes');
  });

  it('shows films with a first-book tile (not the pitch) when the child has films but no books', () => {
    mockFilms([lilaBirthday2026]);
    mockBooks([]);
    const { getByTestId, queryByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
    expect(getByTestId('keepsakes-film-birthday-lila-2026')).toBeTruthy();
    expect(getByTestId('memory-books-first-book-child-1')).toBeTruthy();
    expect(queryByTestId('memory-books-empty')).toBeNull();
  });

  it('shows a viewer the films (and no book UI)', () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as ReturnType<typeof useFamily>);
    mockFilms([lilaBirthday2026]);
    mockBooks([]);
    const { getByTestId, queryByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
    expect(getByTestId('keepsakes-film-birthday-lila-2026')).toBeTruthy();
    expect(queryByTestId('memory-books-first-book-child-1')).toBeNull();
    expect(queryByTestId('memory-books-create')).toBeNull();
  });

  it('goes to Family when a cold-start back has nothing to return to', () => {
    mockBooks([]);
    mockRouter.canGoBack.mockReturnValueOnce(false);
    const { getByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
    fireEvent.press(getByTestId('memory-books-back'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/family');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
});

describe('Keepsakes tab', () => {
  it('shows one shelf per own child, filed under the year (explicit role wins; any member with a book too)', () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [lila, theo, grandma, niece], isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockBooks([yearOneReady, book({ id: 'gb', child_id: 'grandma', scope_kind: 'everything', scope_start_date: null, scope_end_date: null, scope_label: 'Everything' })]);

    const { getByTestId, queryByTestId, getByText } = renderWithQuery(<KeepsakesScreen />);

    // Lila's Year One ends in 2024; the grandma's unbounded book files under its created_at year.
    expect(getByTestId('keepsakes-shelf-2024-child-1')).toBeTruthy();
    expect(getByTestId('keepsakes-shelf-2026-grandma')).toBeTruthy();
    // Theo is an own child with no book: the current year's shelf carries the first-book tile.
    expect(getByTestId('keepsakes-shelf-2026-child-2')).toBeTruthy();
    expect(getByText('Create Theo’s first book')).toBeTruthy();
    // Lila already has a book, so no first-book tile and no empty 2026 shelf for her.
    expect(queryByTestId('keepsakes-shelf-2026-child-1')).toBeNull();
    // Under 13 but sorted as a cousin -- not an own child, no book.
    expect(queryByTestId('keepsakes-shelf-2026-niece')).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_opened', {});
  });

  it('shows ONE family pitch when nobody has a book or a film, and asks whose book first', async () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila, theo], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockBooks([]);

    const { getByTestId, getAllByTestId, getByText, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
    expect(getAllByTestId('memory-books-empty')).toHaveLength(1);
    expect(getByText('Your family’s years, printed and bound.')).toBeTruthy();
    // No bare year title or first-book tiles next to the pitch.
    expect(queryByTestId('keepsakes-year-2026')).toBeNull();
    expect(queryByTestId('memory-books-first-book-child-1')).toBeNull();

    fireEvent.press(getByTestId('memory-books-create'));
    expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_create_book_tapped', { children_count: 2 });
    fireEvent.press(await waitFor(() => getByTestId('child-picker-child-2')));

    await waitFor(() => expect(getByTestId('create-book-sheet')).toBeTruthy());
    expect(mockedUseMemoryBooks).toHaveBeenCalledWith(expect.objectContaining({ childId: 'child-2' }));
  });

  it('skips the picker for a one-child family', async () => {
    mockBooks([]);
    const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
    fireEvent.press(getByTestId('memory-books-create'));
    await waitFor(() => expect(getByTestId('create-book-sheet')).toBeTruthy());
    expect(queryByTestId('child-picker-sheet')).toBeNull();
  });

  it('routes to Family when there is no child to make a book for', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [grandma], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockBooks([]);
    const { getByTestId, getByText } = renderWithQuery(<KeepsakesScreen />);
    expect(getByTestId('memory-books-no-child-hint')).toBeTruthy();
    fireEvent.press(getByText('Go to Family'));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/(app)/(tabs)/family');
  });

  it('opens a book from its year shelf and starts the retry flow for a failed one', async () => {
    mockBooks([yearOneReady, yearThreeFailed]);
    const { getByTestId } = renderWithQuery(<KeepsakesScreen />);
    // Year One ends 2024; Year Three ends 2026.
    expect(getByTestId('keepsakes-shelf-2024-child-1')).toBeTruthy();
    expect(getByTestId('keepsakes-shelf-2026-child-1')).toBeTruthy();

    fireEvent.press(getByTestId(`memory-book-tile-${YEAR_ONE_KEY}`));
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('https://shop.usemomora.com/b/book-1'));

    fireEvent.press(getByTestId(`memory-book-tile-${YEAR_THREE_KEY}`));
    await waitFor(() => expect(getByTestId('retry-book-sheet')).toBeTruthy());
  });

  it('files birthday films, the year-end film and recaps under their year sections', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockFilms([recap(9), lilaBirthday2026, yearEndFilm, lilaBirthday2025]);
    mockBooks([]);
    const { getByTestId, queryByTestId, queryByText } = renderWithQuery(<KeepsakesScreen />);

    expect(getByTestId('keepsakes-year-2026')).toBeTruthy();
    expect(getByTestId('keepsakes-year-2025')).toBeTruthy();
    // 2026: the September recap in Family films, Lila's birthday film on her shelf.
    expect(getByTestId('keepsakes-family-films-2026')).toBeTruthy();
    expect(getByTestId('keepsakes-film-recap-09')).toBeTruthy();
    expect(getByTestId('keepsakes-shelf-2026-child-1')).toBeTruthy();
    expect(getByTestId('keepsakes-film-birthday-lila-2026')).toBeTruthy();
    // 2025: year-end film + Lila's earlier birthday film.
    expect(getByTestId('keepsakes-film-year-end-2025')).toBeTruthy();
    expect(getByTestId('keepsakes-shelf-2025-child-1')).toBeTruthy();
    expect(getByTestId('keepsakes-film-birthday-lila-2025')).toBeTruthy();
    // Films replace the pitch; the create tile is still offered (no book yet).
    expect(queryByTestId('memory-books-empty')).toBeNull();
    expect(getByTestId('memory-books-first-book-child-1')).toBeTruthy();
    expect(queryByText('Your 2026')).toBeNull();
  });

  it('opens the player with source=keepsakes from a film tile', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockFilms([yearEndFilm]);
    mockBooks([]);
    const { getByTestId, getByText } = renderWithQuery(<KeepsakesScreen />);
    expect(getByText('Your 2025')).toBeTruthy();
    fireEvent.press(getByTestId('keepsakes-film-year-end-2025'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/year-end-2025?source=keepsakes');
  });

  it('shows the latest three recaps and a "See all" link only when there are more', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockFilms([recap(5), recap(6), recap(7), recap(8), recap(9)]);
    mockBooks([]);
    const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

    for (const shown of ['09', '08', '07']) expect(getByTestId(`keepsakes-film-recap-${shown}`)).toBeTruthy();
    for (const hidden of ['06', '05']) expect(queryByTestId(`keepsakes-film-recap-${hidden}`)).toBeNull();

    fireEvent.press(getByTestId('keepsakes-recaps-2026'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/keepsakes/recaps/2026');
  });

  it('has no "See all" link with three recaps or fewer', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockFilms([recap(7), recap(8), recap(9)]);
    mockBooks([]);
    const { queryByTestId } = renderWithQuery(<KeepsakesScreen />);
    expect(queryByTestId('keepsakes-recaps-2026')).toBeNull();
  });

  it('shows the dashed upcoming-recap card only when films are enabled', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockBooks([]);

    mockFilms([], { upcoming: false });
    const off = renderWithQuery(<KeepsakesScreen />);
    expect(off.queryByTestId('keepsakes-upcoming-recap')).toBeNull();
    off.unmount();

    mockFilms([], { upcoming: true });
    const on = renderWithQuery(<KeepsakesScreen />);
    expect(on.getByTestId('keepsakes-upcoming-recap')).toBeTruthy();
    expect(on.getByText('October recap · Nov 1')).toBeTruthy();
    // It lives in the current year only.
    expect(on.getByTestId('keepsakes-year-2026')).toBeTruthy();
  });

  it('shows a viewer the films but no book UI', () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as ReturnType<typeof useFamily>);
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockFilms([lilaBirthday2026, recap(9)], { upcoming: true });
    mockBooks([yearThreeFailed]);
    const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

    expect(getByTestId('keepsakes-film-birthday-lila-2026')).toBeTruthy();
    expect(getByTestId('keepsakes-film-recap-09')).toBeTruthy();
    expect(getByTestId('keepsakes-upcoming-recap')).toBeTruthy();
    expect(queryByTestId('keepsakes-viewer-empty')).toBeNull();
    expect(queryByTestId(`memory-book-tile-${YEAR_THREE_KEY}`)).toBeNull();
    expect(queryByTestId('memory-books-first-book-child-1')).toBeNull();
    expect(queryByTestId('memory-books-create')).toBeNull();
    expect(queryByTestId('memory-books-empty')).toBeNull();
  });

  it('shows a viewer the empty message only when there are no films', () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as ReturnType<typeof useFamily>);
    mockBooks([yearOneReady]);
    const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
    expect(getByTestId('keepsakes-viewer-empty')).toBeTruthy();
    expect(queryByTestId(`memory-book-tile-${YEAR_ONE_KEY}`)).toBeNull();
    expect(queryByTestId('memory-books-create')).toBeNull();
  });

  it('shows a remaking film as a non-pressable placeholder tile and an updating film as a playable tile with a badge', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockFilms([
      film({ id: 'recap-09', kind: 'family_month', scope_start_date: '2026-09-01', placement_date: '2026-09-30', blocked: true, stale: true, status: 'rendering' }),
      film({ id: 'recap-08', kind: 'family_month', scope_start_date: '2026-08-01', placement_date: '2026-08-31', stale: true, status: 'curating' }),
      film({ id: 'recap-07', kind: 'family_month', scope_start_date: '2026-07-01', placement_date: '2026-07-31' }),
    ]);
    mockBooks([]);
    const { getByTestId, getByText, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

    // Remaking: placeholder, same tile, no pressable tile, no updating badge.
    expect(getByTestId('keepsakes-film-recap-09-remaking')).toBeTruthy();
    expect(getByText('Remaking…')).toBeTruthy();
    expect(queryByTestId('keepsakes-film-recap-09')).toBeNull();
    fireEvent.press(getByTestId('keepsakes-film-recap-09-remaking'));
    expect(mockRouter.push).not.toHaveBeenCalled();

    // Updating: still a playable tile, with the badge.
    expect(getByTestId('keepsakes-film-recap-08-updating')).toHaveTextContent('Updating…');
    fireEvent.press(getByTestId('keepsakes-film-recap-08'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/recap-08?source=keepsakes');

    // A settled film has neither.
    expect(queryByTestId('keepsakes-film-recap-07-updating')).toBeNull();
    expect(queryByTestId('keepsakes-film-recap-07-remaking')).toBeNull();
  });

  it('passes the tab focus state to the films hook so polling stops when the tab is blurred', () => {
    mockBooks([]);
    renderWithQuery(<KeepsakesScreen />);
    expect(mockedUseFamilyYearFilms).toHaveBeenCalledWith('family-1', { isFocused: true });
  });

  it('refetches the films each time the tab is focused', () => {
    const refetch = jest.fn();
    mockedUseFamilyYearFilms.mockReturnValue({
      films: [], isLoading: false, isFetched: true, isRefetching: false, isError: false, error: null, refetch,
    } as unknown as ReturnType<typeof useFamilyYearFilms>);
    mockBooks([]);
    renderWithQuery(<KeepsakesScreen />);
    expect(refetch).toHaveBeenCalled();
  });
});

describe('Recaps grid (keepsakes/recaps/[year])', () => {
  it('lists that year\'s monthly recaps only, newest first, and logs the open', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockFilms([recap(5), recap(9), recap(7), yearEndFilm, lilaBirthday2026]);
    const { getByTestId, getAllByTestId, getByText, queryByTestId } = renderWithQuery(<KeepsakeRecapsScreen />);

    expect(getByText('2026 recaps')).toBeTruthy();
    expect(getAllByTestId(/^keepsakes-film-/).map((node) => node.props.testID)).toEqual([
      'keepsakes-film-recap-09',
      'keepsakes-film-recap-07',
      'keepsakes-film-recap-05',
    ]);
    expect(queryByTestId('keepsakes-film-year-end-2025')).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith('year_film_recaps_opened', { year: 2026 });

    fireEvent.press(getByTestId('keepsakes-film-recap-09'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/recap-09?source=keepsakes');
  });

  it('shows a remaking recap as a placeholder in its grid slot, not pressable', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockFilms([recap(9), film({ id: 'recap-08', blocked: true, stale: true, status: 'queued', placement_date: '2026-08-31', scope_start_date: '2026-08-01' })]);
    const { getByTestId, getAllByTestId } = renderWithQuery(<KeepsakeRecapsScreen />);
    expect(getAllByTestId(/^keepsakes-film-/).map((node) => node.props.testID)).toEqual([
      'keepsakes-film-recap-09',
      'keepsakes-film-recap-08-remaking',
    ]);
    fireEvent.press(getByTestId('keepsakes-film-recap-08-remaking'));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('shows an empty state for a year without recaps and goes back', () => {
    mockYear = '2019';
    mockFilms([recap(9)]);
    const { getByTestId } = renderWithQuery(<KeepsakeRecapsScreen />);
    expect(getByTestId('keepsakes-recaps-empty')).toBeTruthy();
    fireEvent.press(getByTestId('keepsakes-recaps-back'));
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('Keepsakes for a brand-new family (2026-10-02)', () => {
  it('explains what makes a film when films are not coming yet, above the book pitch', () => {
    mockBooks([]);
    const { getByTestId, getByText } = renderWithQuery(<KeepsakesScreen />);

    expect(getByTestId('keepsakes-films-intro')).toBeTruthy();
    expect(getByText('A little film of your month.')).toBeTruthy();
    // Lila already has a birthday, so no "add birthdays" nudge.
    expect(getByText(/Birthdays get their own film too\.$/)).toBeTruthy();
    expect(getByText('BOOKS')).toBeTruthy();
  });

  it('nudges for birthdays when no kid has one yet', () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [{ ...lila, date_of_birth: null, relationship: 'child' }],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockBooks([]);
    const { getByText } = renderWithQuery(<KeepsakesScreen />);

    expect(getByText(/once your kids’ birthdays are in Family/)).toBeTruthy();
  });

  it('leaves films to the dated upcoming-recap card once they are really coming', () => {
    mockFilms([], { upcoming: true });
    mockBooks([]);
    const { queryByTestId, getByTestId } = renderWithQuery(<KeepsakesScreen />);

    expect(queryByTestId('keepsakes-films-intro')).toBeNull();
    expect(getByTestId('keepsakes-upcoming-recap')).toBeTruthy();
  });

  describe('create-book drawer with nothing makeable yet', () => {
    function mockThinRows() {
      mockedUseMemoryBooks.mockReturnValue({
        rows: [
          sheetRow({ status: 'thin', eligibleCount: 0 }),
          sheetRow({
            key: 'everything',
            option: { kind: 'everything', label: 'Everything', eraLine: null } as never,
            status: 'thin',
            eligibleCount: 1,
          }),
        ],
        isLoading: false,
        isError: false,
        isEligibilityLoading: false,
        exampleCoverAssetKey: null,
        generate,
        retryDispatch: jest.fn(),
        refresh: jest.fn(),
      } as ReturnType<typeof useMemoryBooks>);
    }

    it('explains how far along they are instead of listing dead ends, and offers gallery import', async () => {
      mockBooks([]);
      mockThinRows();
      const { getByTestId, getByText, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      fireEvent.press(getByTestId('memory-books-create'));

      await waitFor(() => expect(getByTestId('create-book-not-enough')).toBeTruthy());
      expect(getByText('Lila’s first book needs a few more memories.')).toBeTruthy();
      expect(getByTestId('create-book-not-enough-count')).toHaveTextContent('1 of ~30');
      expect(queryByTestId('create-book-more-toggle')).toBeNull();

      fireEvent.press(getByTestId('create-book-import-photos'));
      expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import', params: { surface: 'keepsakes' } });
    });

    it('keeps the full list one tap away', async () => {
      mockBooks([]);
      mockThinRows();
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      fireEvent.press(getByTestId('memory-books-create'));

      fireEvent.press(await waitFor(() => getByTestId('create-book-show-options')));

      expect(queryByTestId('create-book-not-enough')).toBeNull();
      expect(getByTestId('create-book-row-age_year:2022-06-01:2023-05-31')).toBeTruthy();
    });

    it('hides the import offer when gallery import is off', async () => {
      mockGalleryImportEnabled = false;
      mockBooks([]);
      mockThinRows();
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      fireEvent.press(getByTestId('memory-books-create'));

      await waitFor(() => expect(getByTestId('create-book-not-enough')).toBeTruthy());
      expect(queryByTestId('create-book-import-photos')).toBeNull();
    });
  });

  it("uses the kid's portrait on the example cover until a photo or illustration exists", async () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [{ ...lila, resolvedPortraitVersion: { illustrated_profile_key: 'portraits/lila.webp' } }],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockBooks([]);
    renderWithQuery(<KeepsakesScreen />);

    await waitFor(() =>
      expect(useMediaUrl as jest.Mock).toHaveBeenCalledWith('portraits/lila.webp', undefined),
    );
  });
});
