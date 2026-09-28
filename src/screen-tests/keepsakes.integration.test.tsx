import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Linking } from 'react-native';

import KeepsakesScreen from '../../app/(app)/(tabs)/keepsakes';
import MemberKeepsakesScreen from '../../app/(app)/keepsakes/[memberId]';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyMemoryBooks, useMemoryBooks, type MemoryBookScopeRow } from '@/hooks/useMemoryBooks';
import type { MemoryBookListRow } from '@/services/memory-books';

// Keepsakes (docs/plans/timeline-calendar-keepsakes.md C2-C5): the tab's
// shelves and the per-child route both render MemoryBooksBody. Shelves derive
// from ONE family-wide books query (mocked here), with the real
// buildMemoryBookRows; the create/retry flow's per-child hook is mocked.

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn(), navigate: jest.fn(), push: jest.fn() };
let mockMemberId = 'child-1';

jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
  useLocalSearchParams: () => ({ memberId: mockMemberId }),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
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

const generate = jest.fn();

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
  mockMemberId = 'child-1';
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
  it('shows one shelf per own child (explicit role wins; any member with a book too)', () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [lila, theo, grandma, niece], isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockBooks([yearOneReady, book({ id: 'gb', child_id: 'grandma', scope_kind: 'everything', scope_start_date: null, scope_end_date: null, scope_label: 'Everything' })]);

    const { getByTestId, queryByTestId, getByText } = renderWithQuery(<KeepsakesScreen />);

    expect(getByTestId('memory-books-shelf-child-1')).toBeTruthy();
    expect(getByTestId('memory-books-shelf-child-2')).toBeTruthy();
    expect(getByTestId('memory-books-shelf-grandma')).toBeTruthy();
    // Under 13 but sorted as a cousin -- not an own child, no book.
    expect(queryByTestId('memory-books-shelf-niece')).toBeNull();
    // A child with no books gets a compact first-book tile.
    expect(getByText('Create Theo’s first book')).toBeTruthy();
    expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_opened', {});
  });

  it('shows ONE family pitch when nobody has a book, and asks whose book first', async () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [lila, theo], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockBooks([]);

    const { getByTestId, getAllByTestId, getByText } = renderWithQuery(<KeepsakesScreen />);
    expect(getAllByTestId('memory-books-empty')).toHaveLength(1);
    expect(getByText('Your family’s years, printed and bound.')).toBeTruthy();

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

  it('never shows books or a Create CTA to a viewer', () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as ReturnType<typeof useFamily>);
    mockBooks([yearOneReady]);
    const { getByTestId, queryByTestId } = renderWithQuery(<KeepsakesScreen />);
    expect(getByTestId('keepsakes-viewer-empty')).toBeTruthy();
    expect(queryByTestId(`memory-book-tile-${YEAR_ONE_KEY}`)).toBeNull();
    expect(queryByTestId('memory-books-create')).toBeNull();
  });
});
