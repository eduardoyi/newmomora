import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import MemoryBooksScreen from '../../app/(app)/family/[id]/memory-books';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemoryBooks, type MemoryBookScopeRow } from '@/hooks/useMemoryBooks';

const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  router: { back: mockBack },
  useLocalSearchParams: () => ({ id: 'child-1' }),
}));

jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useMemoryBooks', () => ({ useMemoryBooks: jest.fn() }));

jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseMemoryBooks = useMemoryBooks as jest.MockedFunction<typeof useMemoryBooks>;

const member = {
  id: 'child-1',
  family_id: 'family-1',
  name: 'Lila',
  date_of_birth: '2023-06-01',
};

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

const generate = jest.fn();
const retryDispatch = jest.fn();
const refresh = jest.fn();

function mockHook(rows: MemoryBookScopeRow[], overrides: Partial<ReturnType<typeof useMemoryBooks>> = {}) {
  mockedUseMemoryBooks.mockReturnValue({
    rows,
    isLoading: false,
    isError: false,
    isEligibilityLoading: false,
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
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
  });

  it('renders every scope option with a Create book action for a manager', () => {
    mockHook([row(), row({ key: 'everything:null:null', option: { kind: 'everything', label: 'Everything', eraLine: null, startDate: null, endDate: null } })]);

    const { getByTestId, getByText } = render(<MemoryBooksScreen />);

    expect(getByText('Year One')).toBeTruthy();
    expect(getByText('Jun 2023 – May 2024')).toBeTruthy();
    expect(getByTestId('memory-book-scope-age_year:2023-06-01:2024-05-31-generate')).toBeTruthy();
  });

  it('shows the thin-period reason and no button below the threshold', () => {
    mockHook([row({ status: 'thin', disabledReason: '12 memories in this period — books need about 30' })]);

    const { getByText, queryByTestId } = render(<MemoryBooksScreen />);

    expect(getByText('12 memories in this period — books need about 30')).toBeTruthy();
    expect(queryByTestId('memory-book-scope-age_year:2023-06-01:2024-05-31-generate')).toBeNull();
  });

  it('calls generate() when Create book is tapped', async () => {
    mockHook([row()]);

    const { getByTestId } = render(<MemoryBooksScreen />);
    fireEvent.press(getByTestId('memory-book-scope-age_year:2023-06-01:2024-05-31-generate'));

    await waitFor(() => expect(generate).toHaveBeenCalledWith(row().option));
  });

  it('shows a progress state with a ~3 minute expectation for a queued/generating row', () => {
    mockHook([row({
      status: 'in_progress',
      book: {
        id: 'book-1', family_id: 'family-1', child_id: 'child-1', status: 'generating',
        scope_kind: 'age_year', scope_start_date: '2023-06-01', scope_end_date: '2024-05-31',
        scope_label: 'Year One', failure_reason: null, created_at: '2026-01-01T00:00:00.000Z',
      },
    })]);

    const { getByText } = render(<MemoryBooksScreen />);

    expect(getByText('Working on it — ready in about 3 minutes')).toBeTruthy();
  });

  it('opens the web viewer for a ready book', async () => {
    mockHook([row({
      status: 'ready',
      book: {
        id: 'book-1', family_id: 'family-1', child_id: 'child-1', status: 'ready',
        scope_kind: 'age_year', scope_start_date: '2023-06-01', scope_end_date: '2024-05-31',
        scope_label: 'Year One', failure_reason: null, created_at: '2026-01-01T00:00:00.000Z',
      },
    })]);

    const { getByTestId } = render(<MemoryBooksScreen />);
    fireEvent.press(getByTestId('memory-book-scope-age_year:2023-06-01:2024-05-31-view'));

    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('https://shop.usemomora.com/b/book-1'));
  });

  it('shows a Retry action for a failed book', async () => {
    mockHook([row({
      status: 'failed',
      book: {
        id: 'book-1', family_id: 'family-1', child_id: 'child-1', status: 'failed',
        scope_kind: 'age_year', scope_start_date: '2023-06-01', scope_end_date: '2024-05-31',
        scope_label: 'Year One', failure_reason: 'Outline generation failed', created_at: '2026-01-01T00:00:00.000Z',
      },
    })]);

    const { getByTestId, getByText } = render(<MemoryBooksScreen />);
    expect(getByText('Outline generation failed')).toBeTruthy();

    fireEvent.press(getByTestId('memory-book-scope-age_year:2023-06-01:2024-05-31-retry'));
    await waitFor(() => expect(generate).toHaveBeenCalled());
  });

  it('hides generation affordances for a non-manager viewer, but keeps existing book rows', () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as ReturnType<typeof useFamily>);
    mockHook([
      row(), // no book -- available, hidden for a viewer
      row({
        key: 'calendar_year:2024-01-01:2024-12-31',
        option: { kind: 'calendar_year', label: '2024', eraLine: null, startDate: '2024-01-01', endDate: '2024-12-31', calendarYear: 2024 },
        status: 'ready',
        book: {
          id: 'book-2', family_id: 'family-1', child_id: 'child-1', status: 'ready',
          scope_kind: 'calendar_year', scope_start_date: '2024-01-01', scope_end_date: '2024-12-31',
          scope_label: '2024', failure_reason: null, created_at: '2026-01-01T00:00:00.000Z',
        },
      }),
    ]);

    const { queryByText, getByText } = render(<MemoryBooksScreen />);

    expect(queryByText('Year One')).toBeNull();
    expect(getByText('2024')).toBeTruthy();
    expect(getByText('View your book')).toBeTruthy();
  });
});
