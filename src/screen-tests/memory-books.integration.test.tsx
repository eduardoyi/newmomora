import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import MemoryBooksScreen from '../../app/(app)/family/[id]/memory-books';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { useMemoryBooks, type MemoryBookScopeRow } from '@/hooks/useMemoryBooks';
import type { MemoryBookListRow } from '@/services/memory-books';

const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  router: { back: mockBack },
  useLocalSearchParams: () => ({ id: 'child-1' }),
}));

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: () => null,
}));

jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useMemoryBooks', () => ({ useMemoryBooks: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: undefined, isLoading: false, isError: false })) }));

jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseMemoryBooks = useMemoryBooks as jest.MockedFunction<typeof useMemoryBooks>;
const mockedUseMediaUrl = useMediaUrl as jest.MockedFunction<typeof useMediaUrl>;

const member = {
  id: 'child-1',
  family_id: 'family-1',
  name: 'Lila',
  date_of_birth: '2023-06-01',
};

function book(overrides: Partial<MemoryBookListRow> = {}): MemoryBookListRow {
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

function row(overrides: Partial<MemoryBookScopeRow> = {}): MemoryBookScopeRow {
  return {
    key: 'age_year:2023-06-01:2024-05-31',
    option: {
      kind: 'age_year',
      label: 'Year One',
      eraLine: 'Jun 2023 – May 2024',
      startDate: '2023-06-01',
      endDate: '2024-05-31',
      ageYear: 1,
    },
    book: null,
    status: 'available',
    eligibleCount: 40,
    disabledReason: null,
    dispatchError: null,
    isPending: false,
    ...overrides,
  };
}

const yearOneReady = row({
  key: 'age_year:2023-06-01:2024-05-31',
  option: { kind: 'age_year', label: 'Year One', eraLine: 'Jun 2023 – May 2024', startDate: '2023-06-01', endDate: '2024-05-31', ageYear: 1 },
  status: 'ready',
  book: book({ id: 'book-1', status: 'ready', scope_label: 'Year One' }),
});

const yearTwoGenerating = row({
  key: 'age_year:2024-06-01:2025-05-31',
  option: { kind: 'age_year', label: 'Year Two', eraLine: 'Jun 2024 – May 2025', startDate: '2024-06-01', endDate: '2025-05-31', ageYear: 2 },
  status: 'in_progress',
  book: book({ id: 'book-2', status: 'generating', scope_kind: 'age_year', scope_start_date: '2024-06-01', scope_end_date: '2025-05-31', scope_label: 'Year Two' }),
});

const yearThreeFailed = row({
  key: 'age_year:2025-06-01:2026-05-31',
  option: { kind: 'age_year', label: 'Year Three', eraLine: 'Jun 2025 – May 2026', startDate: '2025-06-01', endDate: '2026-05-31', ageYear: 3 },
  status: 'failed',
  book: book({ id: 'book-3', status: 'failed', scope_kind: 'age_year', scope_start_date: '2025-06-01', scope_end_date: '2026-05-31', scope_label: 'Year Three', failure_reason: 'Outline generation failed' }),
});

const yearFourAvailable = row({
  key: 'age_year:2022-06-01:2023-05-31',
  option: { kind: 'age_year', label: 'Year Four', eraLine: 'Jun 2022 – May 2023', startDate: '2022-06-01', endDate: '2023-05-31', ageYear: 4 },
  status: 'available',
  book: null,
  eligibleCount: 45,
});

const everythingAvailable = row({
  key: 'everything:null:null',
  option: { kind: 'everything', label: 'Everything', eraLine: null, startDate: null, endDate: null },
  status: 'available',
  book: null,
  eligibleCount: 100,
});

const generate = jest.fn();
const retryDispatch = jest.fn();
const refresh = jest.fn();

function mockHook(rows: MemoryBookScopeRow[], overrides: Partial<ReturnType<typeof useMemoryBooks>> = {}) {
  mockedUseMemoryBooks.mockReturnValue({
    rows,
    isLoading: false,
    isError: false,
    isEligibilityLoading: false,
    exampleCoverAssetKey: null,
    generate,
    retryDispatch,
    refresh,
    ...overrides,
  } as ReturnType<typeof useMemoryBooks>);
}

describe('MemoryBooksScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' } as ReturnType<typeof useFamily>);
    mockedUseFamilyMembers.mockReturnValue({ members: [member], isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
    mockedUseMediaUrl.mockReturnValue({ url: undefined, isLoading: false, isError: false });
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
  });

  it('renders a shelf tile per book state', () => {
    mockHook([yearOneReady, yearTwoGenerating, yearThreeFailed]);

    const { getByTestId, getByText } = render(<MemoryBooksScreen />);

    expect(getByTestId(`memory-book-tile-${yearOneReady.key}`)).toBeTruthy();
    expect(getByTestId(`memory-book-tile-${yearTwoGenerating.key}`)).toBeTruthy();
    expect(getByTestId(`memory-book-tile-${yearThreeFailed.key}`)).toBeTruthy();
    expect(getByText('We’re making it')).toBeTruthy();
    expect(getByText('Didn’t finish')).toBeTruthy();
    expect(getByText('Tap to try again')).toBeTruthy();
  });

  it('opens the web viewer when a ready tile is tapped', async () => {
    mockHook([yearOneReady]);

    const { getByTestId } = render(<MemoryBooksScreen />);
    fireEvent.press(getByTestId(`memory-book-tile-${yearOneReady.key}`));

    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('https://shop.usemomora.com/b/book-1'));
  });

  it('opens the retry sheet for a failed tile, and confirming calls generate', async () => {
    mockHook([yearThreeFailed]);

    const { getByTestId } = render(<MemoryBooksScreen />);
    fireEvent.press(getByTestId(`memory-book-tile-${yearThreeFailed.key}`));

    const retrySheet = await waitFor(() => getByTestId('retry-book-sheet'));
    expect(retrySheet).toBeTruthy();

    fireEvent.press(getByTestId('retry-book-confirm'));

    await waitFor(() => expect(generate).toHaveBeenCalledWith(yearThreeFailed.option));
  });

  it('opens the create sheet from the Create a book CTA', async () => {
    mockHook([yearOneReady]);

    const { getByTestId } = render(<MemoryBooksScreen />);
    fireEvent.press(getByTestId('memory-books-create'));

    await waitFor(() => expect(getByTestId('create-book-sheet')).toBeTruthy());
  });

  it('calls generate and shows a toast when a suggestion is tapped', async () => {
    mockHook([yearOneReady, yearTwoGenerating, yearThreeFailed, yearFourAvailable, everythingAvailable]);

    const { getByTestId, getByText } = render(<MemoryBooksScreen />);
    fireEvent.press(getByTestId('memory-books-create'));

    const suggestion = await waitFor(() => getByTestId(`create-book-suggestion-${yearFourAvailable.key}`));
    fireEvent.press(suggestion);

    expect(generate).toHaveBeenCalledWith(yearFourAvailable.option);
    await waitFor(() => expect(getByText('We’re making your Year Four book. We’ll let you know when it’s ready.')).toBeTruthy());
  });

  it('expands to the grouped list and shows Created ✓ for an existing ready book', async () => {
    mockHook([yearOneReady, yearFourAvailable, everythingAvailable]);

    const { getByTestId, getByText } = render(<MemoryBooksScreen />);
    fireEvent.press(getByTestId('memory-books-create'));

    await waitFor(() => expect(getByTestId('create-book-sheet')).toBeTruthy());
    fireEvent.press(getByTestId('create-book-more-toggle'));

    await waitFor(() => expect(getByTestId(`create-book-row-${yearOneReady.key}`)).toBeTruthy());
    expect(getByText('Created ✓')).toBeTruthy();
  });

  it('hides the Create a book CTA for a non-manager viewer', () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as ReturnType<typeof useFamily>);
    mockHook([yearOneReady]);

    const { queryByTestId } = render(<MemoryBooksScreen />);

    expect(queryByTestId('memory-books-create')).toBeNull();
  });

  it('renders the personalized empty-state headline when there are no books', () => {
    mockHook([yearFourAvailable, everythingAvailable]);

    const { getByText, getByTestId } = render(<MemoryBooksScreen />);

    expect(getByTestId('memory-books-empty')).toBeTruthy();
    expect(getByText('A year of Lila, printed and bound.')).toBeTruthy();
  });
});
