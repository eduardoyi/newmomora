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
import { useHolidayCard } from '@/hooks/useHolidayCard';
import { useKeepsakesOverview } from '@/hooks/useKeepsakesOverview';
import { useFamilyMemoryBooks, useMemoryBooks, type MemoryBookScopeRow } from '@/hooks/useMemoryBooks';
import { useFamilyYearFilms } from '@/hooks/useYearFilms';
import { setPendingKeepsakesToast } from '@/lib/keepsakes-toast';
import { invokeEdgeFunction } from '@/services/ai';
import type { HolidayCardSummary } from '@/services/holiday-cards';
import type { KeepsakesOverview } from '@/services/keepsakes';
import type { MemoryBookListRow } from '@/services/memory-books';
import { resetWebHandoffForTests } from '@/services/web-handoff';
import type { YearFilm } from '@/services/year-films';

// Keepsakes (docs/plans/keepsakes-redesign.md; the stack route is still
// docs/plans/timeline-calendar-keepsakes.md C5): the TAB renders KeepsakesTab
// (header, needs-you line, storefront, library) and the per-child route
// renders KeepsakesBody. Shelves derive from ONE family-wide books query, the
// family films query, the holiday card summary and the keepsakes overview
// (all mocked here), with the real pure helpers in utils/keepsakes.ts; the
// create/retry flow's per-child hook is mocked. "Today" is pinned to 2026-10-15.

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
jest.mock('@/hooks/useHolidayCard', () => ({ useHolidayCard: jest.fn() }));
jest.mock('@/hooks/useKeepsakesOverview', () => ({ useKeepsakesOverview: jest.fn() }));
jest.mock('@/components/family-member-avatar', () => ({ FamilyMemberAvatar: () => null }));
jest.mock('@/hooks/useYearFilms', () => ({
  useFamilyYearFilms: jest.fn(),
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
// openShopUrl asks the web-handoff Edge Function for a sign-in code.
jest.mock('@/services/ai', () => ({ invokeEdgeFunction: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseFamilyMemoryBooks = useFamilyMemoryBooks as jest.MockedFunction<typeof useFamilyMemoryBooks>;
const mockedUseMemoryBooks = useMemoryBooks as jest.MockedFunction<typeof useMemoryBooks>;
const mockedUseFamilyYearFilms = useFamilyYearFilms as jest.MockedFunction<typeof useFamilyYearFilms>;
const mockedUseHolidayCard = useHolidayCard as jest.MockedFunction<typeof useHolidayCard>;
const mockedUseKeepsakesOverview = useKeepsakesOverview as jest.MockedFunction<typeof useKeepsakesOverview>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { trackEvent: mockTrackEvent } = require('@/services/analytics') as { trackEvent: jest.Mock };

const lila = { id: 'child-1', family_id: 'family-1', name: 'Lila', date_of_birth: '2023-06-01', relationship: null };
const theo = { id: 'child-2', family_id: 'family-1', name: 'Theo', date_of_birth: '2025-02-01', relationship: 'child' };

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

function mockFilms(films: YearFilm[], { isLoading = false, isError = false } = {}) {
  mockedUseFamilyYearFilms.mockReturnValue({
    films, isLoading, isFetched: true, isRefetching: false, isError, error: null, refetch: jest.fn(),
  } as unknown as ReturnType<typeof useFamilyYearFilms>);
}

function overviewOf(overrides: Partial<KeepsakesOverview> = {}): KeepsakesOverview {
  return {
    recap: null,
    has_viewers: false,
    year_moments: 40,
    holiday_pool: 30,
    holiday_min_pool: 20,
    holiday_ship_by_note: null,
    preview_key: null,
    book_preview_keys: {},
    orders: [],
    ...overrides,
  };
}

function mockOverview(overview: KeepsakesOverview | null) {
  mockedUseKeepsakesOverview.mockReturnValue({
    overview, isLoading: false, refetch: jest.fn(),
  } as unknown as ReturnType<typeof useKeepsakesOverview>);
}

const createHolidayCard = jest.fn();

function holidaySummary(overrides: Partial<HolidayCardSummary> = {}): HolidayCardSummary {
  return {
    enabled: true, cardId: null, year: null, status: null, readiness: null, lastFailureCode: null, ordered: false, language: 'en',
    ...overrides,
  };
}

function mockHolidayCard(summary: HolidayCardSummary | null) {
  mockedUseHolidayCard.mockReturnValue({
    summary, isLoading: false, isError: false, refetch: jest.fn(), create: createHolidayCard, isCreating: false,
  } as unknown as ReturnType<typeof useHolidayCard>);
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

const mockedInvokeEdgeFunction = invokeEdgeFunction as jest.MockedFunction<typeof invokeEdgeFunction>;
const HANDOFF_CODE = 'Ab-_'.repeat(10) + 'Abc';

beforeEach(() => {
  jest.clearAllMocks();
  resetWebHandoffForTests();
  mockedInvokeEdgeFunction.mockResolvedValue({ data: { code: HANDOFF_CODE }, error: null });
  mockGalleryImportEnabled = true;
  mockMemberId = 'child-1';
  mockYear = '2026';
  mockFilms([]);
  mockHolidayCard(null);
  mockOverview(overviewOf());
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
    await waitFor(() =>
      expect(Linking.openURL).toHaveBeenCalledWith(`https://shop.usemomora.com/b/book-1#h=${HANDOFF_CODE}`),
    );
    expect(mockedInvokeEdgeFunction).toHaveBeenCalledWith('web-handoff', { op: 'create' });
  });

  it('opens the plain web viewer URL when the sign-in handoff fails', async () => {
    mockedInvokeEdgeFunction.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
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

const freshFailedYearThree = book({
  id: 'book-3', status: 'failed', scope_start_date: '2025-06-01', scope_end_date: '2026-05-31',
  scope_label: 'Year Three', failure_reason: 'Outline generation failed',
  created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-10T00:00:00.000Z',
});

describe('Keepsakes tab', () => {
  describe('owner, full library', () => {
    it('renders header, storefront and library: this year open, past years folded', () => {
      mockedUseFamilyMembers.mockReturnValue({ members: [lila, theo], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
      mockHolidayCard(holidaySummary({ enabled: true }));
      mockOverview(overviewOf({ holiday_ship_by_note: 'Order by Dec 10 for Christmas delivery in the US.' }));
      mockFilms([recap(9), recap(8), yearEndFilm, lilaBirthday2025]);
      mockBooks([yearOneReady, yearThreeFailed]);

      const { getByTestId, getByText, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

      expect(getByTestId('keepsakes-header')).toBeTruthy();
      expect(getByText('Keepsakes')).toBeTruthy();
      // Storefront: the holiday card (in season) leads, then the Memory Book.
      expect(getByTestId('keepsakes-store-holiday-card')).toBeTruthy();
      expect(getByTestId('keepsakes-store-memory-book')).toBeTruthy();
      expect(getByText('Order by Dec 10 for Christmas delivery in the US.')).toBeTruthy();
      // The library: 2026 open (recaps + Year Three), the past years folded.
      expect(getByTestId('keepsakes-library')).toBeTruthy();
      expect(getByTestId('keepsakes-film-recap-09')).toBeTruthy();
      expect(getByTestId('keepsakes-film-recap-08')).toBeTruthy();
      expect(getByTestId(`memory-book-tile-${YEAR_THREE_KEY}`)).toBeTruthy();
      expect(getByTestId('keepsakes-year-toggle-2025')).toBeTruthy();
      expect(getByTestId('keepsakes-year-toggle-2024')).toBeTruthy();
      expect(queryByTestId('keepsakes-film-year-end-2025')).toBeNull();
      expect(queryByTestId(`memory-book-tile-${YEAR_ONE_KEY}`)).toBeNull();
      expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_opened', {});
    });

    it('lists the old tab\'s dead UI nowhere: no FAB, no pitch, no films intro, no first-book tile', () => {
      mockFilms([recap(9)]);
      mockBooks([]);
      const { queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(queryByTestId('memory-books-create')).toBeNull();
      expect(queryByTestId('memory-books-empty')).toBeNull();
      expect(queryByTestId('keepsakes-films-intro')).toBeNull();
      expect(queryByTestId('memory-books-first-book-child-1')).toBeNull();
    });

    it('never shows a price', () => {
      mockHolidayCard(holidaySummary({ enabled: true }));
      mockFilms([recap(9)]);
      mockBooks([yearOneReady, yearThreeFailed]);
      const { toJSON } = renderWithQuery(<KeepsakesScreen />);
      expect(JSON.stringify(toJSON())).not.toMatch(/\$\d/);
    });

    it('opens a past year in place, folds it again, and tracks each toggle', () => {
      mockFilms([recap(9), yearEndFilm]);
      mockBooks([]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

      expect(queryByTestId('keepsakes-film-year-end-2025')).toBeNull();
      fireEvent.press(getByTestId('keepsakes-year-toggle-2025'));
      expect(getByTestId('keepsakes-film-year-end-2025')).toBeTruthy();
      expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_year_toggled', { year: 2025, open: true });

      fireEvent.press(getByTestId('keepsakes-year-toggle-2025'));
      expect(queryByTestId('keepsakes-film-year-end-2025')).toBeNull();
      expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_year_toggled', { year: 2025, open: false });
    });

    it('opens the player with source=keepsakes from a film poster', () => {
      mockFilms([recap(9)]);
      mockBooks([]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);
      fireEvent.press(getByTestId('keepsakes-film-recap-09'));
      expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/recap-09?source=keepsakes');
    });

    it('ends a year of more than three monthly recaps with the "All recaps" tile, which opens the grid', () => {
      mockFilms([recap(5), recap(6), recap(7), recap(8), recap(9)]);
      mockBooks([]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);
      // The row still shows every month.
      for (const month of ['05', '06', '07', '08', '09']) expect(getByTestId(`keepsakes-film-recap-${month}`)).toBeTruthy();
      fireEvent.press(getByTestId('keepsakes-recaps-2026'));
      expect(mockRouter.push).toHaveBeenCalledWith('/(app)/keepsakes/recaps/2026');
    });

    it('has no "All recaps" tile with three recaps or fewer', () => {
      mockFilms([recap(7), recap(8), recap(9)]);
      mockBooks([]);
      expect(renderWithQuery(<KeepsakesScreen />).queryByTestId('keepsakes-recaps-2026')).toBeNull();
    });

    it('shows a remaking film as a non-pressable placeholder and an updating film as a playable poster with a badge', () => {
      mockFilms([
        film({ id: 'recap-09', kind: 'family_month', scope_start_date: '2026-09-01', placement_date: '2026-09-30', blocked: true, stale: true, status: 'rendering' }),
        film({ id: 'recap-08', kind: 'family_month', scope_start_date: '2026-08-01', placement_date: '2026-08-31', stale: true, status: 'curating' }),
        film({ id: 'recap-07', kind: 'family_month', scope_start_date: '2026-07-01', placement_date: '2026-07-31' }),
      ]);
      mockBooks([]);
      const { getByTestId, getByText, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

      expect(getByTestId('keepsakes-film-recap-09-remaking')).toBeTruthy();
      expect(getByText('Remaking…')).toBeTruthy();
      expect(queryByTestId('keepsakes-film-recap-09')).toBeNull();
      fireEvent.press(getByTestId('keepsakes-film-recap-09-remaking'));
      expect(mockRouter.push).not.toHaveBeenCalled();

      expect(getByTestId('keepsakes-film-recap-08-updating')).toHaveTextContent('Updating…');
      fireEvent.press(getByTestId('keepsakes-film-recap-08'));
      expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/recap-08?source=keepsakes');

      expect(queryByTestId('keepsakes-film-recap-07-updating')).toBeNull();
      expect(queryByTestId('keepsakes-film-recap-07-remaking')).toBeNull();
    });
  });

  describe('badges, orders and the needs-you line', () => {
    it('badges books by state; a paid order reads "Ordered", a shipped one "Shipped"', () => {
      mockFilms([]);
      mockBooks([yearOneReady, yearTwoGenerating, freshFailedYearThree]);
      mockOverview(overviewOf({ orders: [{ product: 'book', item_id: 'book-1', status: 'shipped', shipped_at: null }] }));
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);

      // Year Two (2025) is generating; Year One (2024) shipped; Year Three (2026) failed.
      expect(getByTestId('keepsakes-badge-book:book-3')).toHaveTextContent('Couldn’t be made');
      fireEvent.press(getByTestId('keepsakes-year-toggle-2025'));
      expect(getByTestId('keepsakes-badge-book:book-2')).toHaveTextContent('Being made');
      fireEvent.press(getByTestId('keepsakes-year-toggle-2024'));
      expect(getByTestId('keepsakes-badge-book:book-1')).toHaveTextContent('Shipped');
    });

    it('a ready holiday card sits on this year\'s shelf with a "Ready to order" badge and opens the shop', async () => {
      mockHolidayCard(holidaySummary({ cardId: 'card-1', year: 2026, status: 'ready', readiness: 'ready' }));
      mockFilms([recap(9)]);
      mockBooks([]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);

      expect(getByTestId('keepsakes-badge-card:card-1')).toHaveTextContent('Ready to order');
      fireEvent.press(getByTestId('keepsakes-card-card-1'));
      await waitFor(() =>
        expect(Linking.openURL).toHaveBeenCalledWith(`https://shop.usemomora.com/c/card-1#h=${HANDOFF_CODE}`),
      );
    });

    it('a shipped card reads "Shipped · {date}"', () => {
      mockHolidayCard(holidaySummary({ cardId: 'card-1', year: 2026, status: 'ready', ordered: true }));
      mockOverview(overviewOf({ orders: [{ product: 'card', item_id: 'card-1', status: 'shipped', shipped_at: '2026-10-12T12:00:00.000Z' }] }));
      mockBooks([]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(getByTestId('keepsakes-badge-card:card-1')).toHaveTextContent('Shipped · Oct 12');
    });

    it('a ready card raises the needs-you line, which opens the shop', async () => {
      mockHolidayCard(holidaySummary({ cardId: 'card-1', year: 2026, status: 'ready', readiness: 'ready' }));
      mockBooks([]);
      const { getByTestId, getByText } = renderWithQuery(<KeepsakesScreen />);
      expect(getByText('Your holiday card is ready to order')).toBeTruthy();
      fireEvent.press(getByTestId('keepsakes-needs-you'));
      await waitFor(() =>
        expect(Linking.openURL).toHaveBeenCalledWith(`https://shop.usemomora.com/c/card-1#h=${HANDOFF_CODE}`),
      );
    });

    it('a recently failed book raises the needs-you line, which opens the retry sheet; confirming makes a fresh book', async () => {
      mockBooks([freshFailedYearThree]);
      const { getByTestId, getByText } = renderWithQuery(<KeepsakesScreen />);
      expect(getByText('Lila’s book couldn’t be made')).toBeTruthy();

      fireEvent.press(getByTestId('keepsakes-needs-you'));
      await waitFor(() => expect(getByTestId('retry-book-sheet')).toBeTruthy());
      expect(mockedUseMemoryBooks).toHaveBeenCalledWith(expect.objectContaining({ childId: 'child-1' }));
      fireEvent.press(getByTestId('retry-book-confirm'));
      await waitFor(() => expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'age_year', startDate: '2025-06-01', endDate: '2026-05-31' }),
      ));
    });

    it('a superseded failure raises no banner (the retry made a ready book of the same scope)', () => {
      mockBooks([
        freshFailedYearThree,
        book({
          id: 'book-3b', status: 'ready', scope_start_date: '2025-06-01', scope_end_date: '2026-05-31',
          scope_label: 'Year Three', created_at: '2026-10-11T00:00:00.000Z', updated_at: '2026-10-11T00:05:00.000Z',
        }),
      ]);
      const { queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(queryByTestId('keepsakes-needs-you')).toBeNull();
    });

    it('a failed book on the shelf opens the retry sheet', async () => {
      mockBooks([yearThreeFailed]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);
      fireEvent.press(getByTestId(`memory-book-tile-${YEAR_THREE_KEY}`));
      await waitFor(() => expect(getByTestId('retry-book-sheet')).toBeTruthy());
    });

    it('a ready book opens the shop', async () => {
      mockBooks([yearOneReady]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);
      fireEvent.press(getByTestId('keepsakes-year-toggle-2024'));
      fireEvent.press(getByTestId(`memory-book-tile-${YEAR_ONE_KEY}`));
      await waitFor(() =>
        expect(Linking.openURL).toHaveBeenCalledWith(`https://shop.usemomora.com/b/book-1#h=${HANDOFF_CODE}`),
      );
    });
  });

  describe('storefront', () => {
    it('leaves the holiday card out of season; the Memory Book stays', () => {
      mockHolidayCard(holidaySummary({ enabled: false }));
      mockBooks([]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(queryByTestId('keepsakes-store-holiday-card')).toBeNull();
      expect(getByTestId('keepsakes-store-memory-book')).toBeTruthy();
    });

    it('opens a product page and tracks it', () => {
      mockHolidayCard(holidaySummary({ enabled: true }));
      mockBooks([]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);

      fireEvent.press(getByTestId('keepsakes-store-memory-book'));
      expect(mockRouter.push).toHaveBeenCalledWith('/(app)/keepsakes/memory-book');
      expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_product_opened', { product: 'memory-book' });

      fireEvent.press(getByTestId('keepsakes-store-holiday-card'));
      expect(mockRouter.push).toHaveBeenCalledWith('/(app)/keepsakes/holiday-card');
      expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_product_opened', { product: 'holiday-card' });
    });

    it('reads the holiday summary once, for owners and managers', () => {
      mockBooks([]);
      renderWithQuery(<KeepsakesScreen />);
      expect(mockedUseHolidayCard).toHaveBeenCalledWith('family-1', expect.objectContaining({ enabled: true }));
    });
  });

  describe('privacy line', () => {
    it('shows only when the family has a viewer', () => {
      mockOverview(overviewOf({ has_viewers: true }));
      mockFilms([recap(9)]);
      mockBooks([]);
      const on = renderWithQuery(<KeepsakesScreen />);
      expect(on.getByText('Books and cards are only visible to owners and managers.')).toBeTruthy();
      on.unmount();

      mockOverview(overviewOf({ has_viewers: false }));
      const off = renderWithQuery(<KeepsakesScreen />);
      expect(off.queryByTestId('keepsakes-privacy')).toBeNull();
    });
  });

  describe('upcoming recap', () => {
    const lockedRecap = {
      month_start: '2026-10-01', delivers_on: '2026-11-01', moments: 6, visuals: 4,
      min_moments: 10, min_visuals: 6, picture_key: null,
    };

    it('shows the locked tile with progress on the current year\'s shelf', () => {
      mockOverview(overviewOf({ recap: lockedRecap }));
      mockBooks([]);
      const { getByTestId, getByText, getAllByText } = renderWithQuery(<KeepsakesScreen />);
      expect(getByTestId('keepsakes-year-2026')).toBeTruthy();
      expect(getByTestId('keepsakes-upcoming-recap')).toBeTruthy();
      // On the tile and in the caption under it.
      expect(getAllByText('October recap')).toHaveLength(2);
      expect(getByText('4 more moments this month')).toBeTruthy();
      expect(getByText('6 of 10 moments')).toBeTruthy();
    });

    it('is labelled from the owner-local month, not the device date, and filed under its year (open)', () => {
      mockOverview(overviewOf({ recap: { ...lockedRecap, month_start: '2027-01-01', delivers_on: '2027-02-01', moments: 12, visuals: 7 } }));
      mockBooks([]);
      const { getByTestId, getByText, getAllByText, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(getAllByText('January recap').length).toBeGreaterThan(0);
      expect(getByText('arrives')).toBeTruthy();
      expect(getByText('Feb 1')).toBeTruthy();
      // Filed under 2027 and never folded.
      expect(getByTestId('keepsakes-year-2027')).toBeTruthy();
      expect(queryByTestId('keepsakes-year-toggle-2027')).toBeNull();
      expect(getByTestId('keepsakes-upcoming-recap')).toBeTruthy();
    });

    it('is absent when the overview has no recap (or failed)', () => {
      mockOverview(null);
      mockFilms([recap(9)]);
      mockBooks([]);
      const { queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(queryByTestId('keepsakes-upcoming-recap')).toBeNull();
    });
  });

  describe('filter and child chips', () => {
    it('applies a year from the filter sheet, shows the active count and tracks it', () => {
      mockFilms([recap(9), yearEndFilm]);
      mockBooks([]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

      fireEvent.press(getByTestId('keepsakes-filter-button'));
      fireEvent.press(getByTestId('keepsakes-filter-year-2025'));
      fireEvent.press(getByTestId('keepsakes-filter-apply'));

      expect(getByTestId('keepsakes-film-year-end-2025')).toBeTruthy();
      expect(queryByTestId('keepsakes-year-2026')).toBeNull();
      expect(getByTestId('keepsakes-filter-dot')).toHaveTextContent('1');
      expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_filter_applied', { type: 'all', has_year: true, has_child: false });
    });

    it('a type filter that matches nothing offers a reset', () => {
      mockFilms([recap(9)]);
      mockBooks([]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

      fireEvent.press(getByTestId('keepsakes-filter-button'));
      fireEvent.press(getByTestId('keepsakes-filter-type-books'));
      fireEvent.press(getByTestId('keepsakes-filter-apply'));
      expect(getByTestId('keepsakes-filter-empty')).toBeTruthy();

      fireEvent.press(getByTestId('keepsakes-filter-empty-reset'));
      expect(queryByTestId('keepsakes-filter-empty')).toBeNull();
      expect(getByTestId('keepsakes-film-recap-09')).toBeTruthy();
    });

    it('child chips (two or more children) keep that child\'s items; family-wide films only show under All', () => {
      mockedUseFamilyMembers.mockReturnValue({ members: [lila, theo], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
      mockFilms([recap(9), lilaBirthday2026, theoBirthday2026]);
      mockBooks([]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

      fireEvent.press(getByTestId('keepsakes-chip-child-2'));
      expect(getByTestId('keepsakes-film-birthday-theo-2026')).toBeTruthy();
      expect(queryByTestId('keepsakes-film-birthday-lila-2026')).toBeNull();
      expect(queryByTestId('keepsakes-film-recap-09')).toBeNull();

      fireEvent.press(getByTestId('keepsakes-chip-all'));
      expect(getByTestId('keepsakes-film-recap-09')).toBeTruthy();
    });

    it('resets the filter and the open years when the family changes', () => {
      mockFilms([recap(9), yearEndFilm]);
      mockBooks([]);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      const view = render(<QueryClientProvider client={client}><KeepsakesScreen /></QueryClientProvider>);

      fireEvent.press(view.getByTestId('keepsakes-year-toggle-2025'));
      expect(view.getByTestId('keepsakes-film-year-end-2025')).toBeTruthy();

      mockedUseFamily.mockReturnValue({ familyId: 'family-2', role: 'manager' } as ReturnType<typeof useFamily>);
      view.rerender(<QueryClientProvider client={client}><KeepsakesScreen /></QueryClientProvider>);
      expect(view.queryByTestId('keepsakes-film-year-end-2025')).toBeNull();
      expect(view.getByTestId('keepsakes-year-toggle-2025')).toBeTruthy();
    });
  });

  describe('loading, errors and focus', () => {
    it('shows a spinner until the data has loaded', () => {
      mockFilms([], { isLoading: true });
      mockBooks([]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(getByTestId('keepsakes-loading')).toBeTruthy();
      expect(queryByTestId('keepsakes-store-memory-book')).toBeNull();
    });

    it('shows an inline error with a retry when films fail', () => {
      const refetch = jest.fn();
      mockedUseFamilyYearFilms.mockReturnValue({
        films: [], isLoading: false, isFetched: true, isRefetching: false, isError: true, error: null, refetch,
      } as unknown as ReturnType<typeof useFamilyYearFilms>);
      mockBooks([]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(getByTestId('keepsakes-error')).toBeTruthy();
      fireEvent.press(getByTestId('keepsakes-retry-load'));
      expect(refetch).toHaveBeenCalled();
    });

    it('degrades without the overview: the library and storefront still render', () => {
      mockOverview(null);
      mockFilms([recap(9)]);
      mockBooks([yearThreeFailed]);
      const { getByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(getByTestId('keepsakes-library')).toBeTruthy();
      expect(getByTestId('keepsakes-store-memory-book')).toBeTruthy();
    });

    it('passes the tab focus state to the films hook so polling stops when the tab is blurred', () => {
      mockBooks([]);
      renderWithQuery(<KeepsakesScreen />);
      expect(mockedUseFamilyYearFilms).toHaveBeenCalledWith('family-1', { isFocused: true });
      expect(mockedUseKeepsakesOverview).toHaveBeenCalledWith('family-1', { isFocused: true });
    });

    it('refetches the films and the card summary each time the tab is focused', () => {
      const refetchFilms = jest.fn();
      mockedUseFamilyYearFilms.mockReturnValue({
        films: [], isLoading: false, isFetched: true, isRefetching: false, isError: false, error: null, refetch: refetchFilms,
      } as unknown as ReturnType<typeof useFamilyYearFilms>);
      const refetchHoliday = jest.fn();
      mockedUseHolidayCard.mockReturnValue({
        summary: null, isLoading: false, isError: false, refetch: refetchHoliday, create: createHolidayCard, isCreating: false,
      } as unknown as ReturnType<typeof useHolidayCard>);
      mockBooks([]);
      renderWithQuery(<KeepsakesScreen />);
      expect(refetchFilms).toHaveBeenCalled();
      expect(refetchHoliday).toHaveBeenCalled();
    });
  });

  describe('toast from a product page', () => {
    it('shows once, then is gone on the next visit', () => {
      mockBooks([]);
      setPendingKeepsakesToast('We’re making your Year Four book…');
      const first = renderWithQuery(<KeepsakesScreen />);
      expect(first.getByText('We’re making your Year Four book…')).toBeTruthy();
      first.unmount();

      const second = renderWithQuery(<KeepsakesScreen />);
      expect(second.queryByText('We’re making your Year Four book…')).toBeNull();
    });
  });

  describe('owner, brand-new family', () => {
    it('shows the storefront and the "first one is on its way" line, with no filter and no old pitch', () => {
      mockHolidayCard(holidaySummary({ enabled: false }));
      mockFilms([]);
      mockBooks([]);
      const { getByTestId, getByText, queryByTestId } = renderWithQuery(<KeepsakesScreen />);

      expect(getByTestId('keepsakes-store-memory-book')).toBeTruthy();
      expect(getByText('Films show up here on their own. Your first one is on its way.')).toBeTruthy();
      expect(queryByTestId('keepsakes-filter-button')).toBeNull();
      expect(queryByTestId('memory-books-empty')).toBeNull();
      expect(queryByTestId('keepsakes-films-intro')).toBeNull();
    });
  });

  describe('viewer', () => {
    beforeEach(() => {
      mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as ReturnType<typeof useFamily>);
    });

    it('is "Family films": films only, no storefront, no banner, no order badges, filter in the header', () => {
      mockHolidayCard(holidaySummary({ cardId: 'card-1', year: 2026, status: 'ready', readiness: 'ready' }));
      mockFilms([lilaBirthday2026, recap(9)]);
      mockBooks([yearThreeFailed]);
      mockOverview(overviewOf({
        has_viewers: null,
        recap: { month_start: '2026-10-01', delivers_on: '2026-11-01', moments: 6, visuals: 4, min_moments: 10, min_visuals: 6, picture_key: null },
      }));
      const { getByTestId, getByText, queryByTestId, queryByText } = renderWithQuery(<KeepsakesScreen />);

      expect(getByText('Family films')).toBeTruthy();
      expect(queryByText('Keepsakes')).toBeNull();
      expect(queryByText('Your keepsakes')).toBeNull();
      expect(getByTestId('keepsakes-library')).toBeTruthy();
      expect(getByTestId('keepsakes-film-birthday-lila-2026')).toBeTruthy();
      expect(getByTestId('keepsakes-film-recap-09')).toBeTruthy();
      expect(getByTestId('keepsakes-upcoming-recap')).toBeTruthy();
      expect(getByTestId('keepsakes-filter-button')).toBeTruthy();
      expect(queryByTestId('keepsakes-store')).toBeNull();
      expect(queryByTestId('keepsakes-needs-you')).toBeNull();
      expect(queryByTestId('keepsakes-privacy')).toBeNull();
      expect(queryByTestId(`memory-book-tile-${YEAR_THREE_KEY}`)).toBeNull();
      expect(queryByTestId('keepsakes-card-card-1')).toBeNull();
      expect(queryByTestId('memory-books-create')).toBeNull();
      // Nothing is fetched for books or cards.
      expect(mockedUseHolidayCard).not.toHaveBeenCalledWith('family-1', expect.objectContaining({ enabled: true }));
      expect(mockedUseFamilyMemoryBooks).toHaveBeenCalledWith(expect.objectContaining({ familyId: null }));
    });

    it('the header filter sheet offers years only', () => {
      mockFilms([recap(9), yearEndFilm]);
      mockBooks([]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      fireEvent.press(getByTestId('keepsakes-filter-button'));
      expect(queryByTestId('keepsakes-filter-type-books')).toBeNull();
      fireEvent.press(getByTestId('keepsakes-filter-year-2025'));
      fireEvent.press(getByTestId('keepsakes-filter-apply'));
      expect(getByTestId('keepsakes-film-year-end-2025')).toBeTruthy();
    });

    it('shows the gentle empty line when there are no films', () => {
      mockBooks([yearOneReady]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(getByTestId('keepsakes-viewer-empty')).toBeTruthy();
      expect(queryByTestId(`memory-book-tile-${YEAR_ONE_KEY}`)).toBeNull();
      expect(queryByTestId('keepsakes-filter-button')).toBeNull();
    });

    it('a viewer with only past-year films still gets the library', () => {
      mockFilms([yearEndFilm]);
      mockBooks([]);
      const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
      expect(getByTestId('keepsakes-library')).toBeTruthy();
      expect(queryByTestId('keepsakes-viewer-empty')).toBeNull();
      expect(getByTestId('keepsakes-year-toggle-2025')).toBeTruthy();
    });
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

describe('One child\'s keepsakes: a brand-new family (2026-10-02)', () => {
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
      const { getByTestId, getByText, queryByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
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
      const { getByTestId, queryByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
      fireEvent.press(getByTestId('memory-books-create'));

      fireEvent.press(await waitFor(() => getByTestId('create-book-show-options')));

      expect(queryByTestId('create-book-not-enough')).toBeNull();
      expect(getByTestId('create-book-row-age_year:2022-06-01:2023-05-31')).toBeTruthy();
    });

    it('hides the import offer when gallery import is off', async () => {
      mockGalleryImportEnabled = false;
      mockBooks([]);
      mockThinRows();
      const { getByTestId, queryByTestId } = renderWithQuery(<MemberKeepsakesScreen />);
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
    renderWithQuery(<MemberKeepsakesScreen />);

    await waitFor(() =>
      expect(useMediaUrl as jest.Mock).toHaveBeenCalledWith('portraits/lila.webp', undefined),
    );
  });
});
