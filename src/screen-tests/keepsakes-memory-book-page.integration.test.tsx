import { act, fireEvent, render } from '@testing-library/react-native';

import MemoryBookProductScreen from '../../app/(app)/keepsakes/memory-book';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useKeepsakesOverview } from '@/hooks/useKeepsakesOverview';
import {
  buildMemoryBookRows,
  useFamilyMemoryBooks,
  useMemoryBooks,
} from '@/hooks/useMemoryBooks';
import { consumePendingKeepsakesToast } from '@/lib/keepsakes-toast';
import type { KeepsakesOverview } from '@/services/keepsakes';
import { memoryBookWebUrl, type MemoryBookListRow } from '@/services/memory-books';
import { openShopUrl } from '@/services/web-handoff';
import { splitScopeOptions } from '@/utils/keepsakes';
import { buildMemoryBookScopeOptions, memoryBookScopeKey } from '@/utils/memory-book-scope';

// Memory Book product page (docs/plans/keepsakes-redesign.md D4). "Today" is
// pinned to 2026-10-15. The per-child create hook is mocked with REAL row
// building, so statuses/labels/splits are the production ones.

const TODAY = '2026-10-15';
const mockRouter = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn(), navigate: jest.fn(), push: jest.fn() };
let mockParams: { memberId?: string } = {};
let mockGalleryImportEnabled = true;

jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/utils/gallery-import-flags', () => ({
  get isGalleryImportFeatureEnabled() {
    return mockGalleryImportEnabled;
  },
}));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useKeepsakesOverview', () => ({ useKeepsakesOverview: jest.fn() }));
jest.mock('@/hooks/useMemoryBooks', () => ({
  ...jest.requireActual('@/hooks/useMemoryBooks'),
  useFamilyMemoryBooks: jest.fn(),
  useMemoryBooks: jest.fn(),
}));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: undefined, isLoading: false, isError: false })) }));
jest.mock('@/services/web-handoff', () => ({ openShopUrl: jest.fn(() => Promise.resolve()) }));
jest.mock('@/utils/portrait-versions', () => ({
  ...jest.requireActual('@/utils/portrait-versions'),
  getLocalTodayIso: () => '2026-10-15',
}));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }) };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { trackEvent: mockTrackEvent } = require('@/services/analytics') as { trackEvent: jest.Mock };
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseFamilyMemoryBooks = useFamilyMemoryBooks as jest.MockedFunction<typeof useFamilyMemoryBooks>;
const mockedUseMemoryBooks = useMemoryBooks as jest.MockedFunction<typeof useMemoryBooks>;
const mockedUseOverview = useKeepsakesOverview as jest.MockedFunction<typeof useKeepsakesOverview>;
const mockedOpenShopUrl = openShopUrl as jest.MockedFunction<typeof openShopUrl>;

// Lila is 6: Year Six (2025-03-01 .. 2026-02-28) and Year Five are the two newest completed years.
const lila = { id: 'child-1', family_id: 'family-1', name: 'Lila Park', date_of_birth: '2020-03-01', relationship: 'child' };
const theo = { id: 'child-2', family_id: 'family-1', name: 'Theo', date_of_birth: '2025-02-01', relationship: 'child' };
const grandma = { id: 'grandma', family_id: 'family-1', name: 'Mirian', date_of_birth: '1955-01-01', relationship: 'grandparent' };

const YEAR_SIX = 'age_year:2025-03-01:2026-02-28';
const YEAR_FIVE = 'age_year:2024-03-01:2025-02-28';
const YEAR_SEVEN = 'age_year:2026-03-01:2027-02-28';
const EVERYTHING = 'everything:null:null';

function book(overrides: Partial<MemoryBookListRow> = {}): MemoryBookListRow {
  return {
    id: 'book-6',
    family_id: 'family-1',
    child_id: 'child-1',
    status: 'ready',
    scope_kind: 'age_year',
    scope_start_date: '2025-03-01',
    scope_end_date: '2026-02-28',
    scope_label: 'Year Six',
    failure_reason: null,
    cover_asset_key: null,
    created_at: '2026-10-15T09:00:00.000Z',
    updated_at: '2026-10-15T09:00:00.000Z',
    ...overrides,
  };
}

const generate = jest.fn();
const retryDispatch = jest.fn();

interface ChildSetup {
  books?: MemoryBookListRow[];
  eligibility?: Record<string, number | null>;
  dispatchErrors?: Record<string, string>;
  pendingKeys?: Record<string, boolean>;
}
let childSetups: Record<string, ChildSetup> = {};

function overview(overrides: Partial<KeepsakesOverview> = {}): KeepsakesOverview {
  return {
    recap: null, has_viewers: false, year_moments: 34, holiday_pool: 28, holiday_min_pool: 20, holiday_ship_by_note: null,
    preview_key: null, book_preview_keys: {}, orders: [], card_front: null, ...overrides,
  };
}

function setup({
  role = 'owner',
  members = [lila, theo, grandma] as unknown[],
  ov = overview() as KeepsakesOverview | null,
  books = [] as MemoryBookListRow[],
}: { role?: string; members?: unknown[]; ov?: KeepsakesOverview | null; books?: MemoryBookListRow[] } = {}) {
  mockedUseFamily.mockReturnValue({ familyId: 'family-1', role, isLoading: false } as unknown as ReturnType<typeof useFamily>);
  mockedUseFamilyMembers.mockReturnValue({ members, isLoading: false } as unknown as ReturnType<typeof useFamilyMembers>);
  const booksByChild = new Map<string, MemoryBookListRow[]>();
  for (const b of books) booksByChild.set(b.child_id!, [...(booksByChild.get(b.child_id!) ?? []), b]);
  mockedUseFamilyMemoryBooks.mockReturnValue({
    booksByChild, isLoading: false, isError: false, refetch: jest.fn(),
  } as unknown as ReturnType<typeof useFamilyMemoryBooks>);
  mockedUseOverview.mockReturnValue({ overview: ov, isLoading: false, refetch: jest.fn() } as unknown as ReturnType<typeof useKeepsakesOverview>);
  mockedUseMemoryBooks.mockImplementation(({ childId, dateOfBirth }) => {
    const s = childSetups[childId ?? ''] ?? {};
    const options = buildMemoryBookScopeOptions(dateOfBirth ?? null, TODAY);
    const eligibility: Record<string, number | null> = {};
    for (const option of options) eligibility[memoryBookScopeKey(option)] = s.eligibility?.[memoryBookScopeKey(option)] ?? 40;
    const rows = buildMemoryBookRows(options, s.books ?? [], eligibility, s.dispatchErrors, s.pendingKeys);
    return {
      rows, isLoading: false, isError: false, isEligibilityLoading: false, exampleCoverAssetKey: null,
      generate, retryDispatch, refresh: jest.fn(),
    } as unknown as ReturnType<typeof useMemoryBooks>;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
  mockParams = {};
  mockGalleryImportEnabled = true;
  childSetups = {};
  consumePendingKeepsakesToast();
});

describe('memory book product page', () => {
  it('renders the layout with the two newest completed years, "See N more" and no prices', () => {
    setup({ ov: overview({ has_viewers: true }) });
    const { getByTestId, getByText, queryByTestId, toJSON } = render(<MemoryBookProductScreen />);

    expect(getByTestId('keepsakes-product-memory-book')).toBeTruthy();
    expect(getByText('MEMORY BOOK')).toBeTruthy();
    expect(getByText('A year of Lila, printed and bound.')).toBeTruthy();
    expect(getByText('Free to make')).toBeTruthy();
    expect(getByText('Which part of Lila’s story')).toBeTruthy();
    expect(getByTestId(`memory-book-scope-${YEAR_SIX}`)).toBeTruthy();
    expect(getByTestId(`memory-book-scope-${YEAR_FIVE}`)).toBeTruthy();
    // Older years / calendar years / in-progress year are folded.
    expect(queryByTestId(`memory-book-scope-${YEAR_SEVEN}`)).toBeNull();
    expect(queryByTestId(`memory-book-scope-${EVERYTHING}`)).toBeNull();
    expect(getByText('Viewers in your family won’t see this book. Your surprise is safe.')).toBeTruthy();
    expect(getByText('Layflat, 8.3×8.3 inches.')).toBeTruthy();
    expect(getByText('Ready to look through in a few minutes.')).toBeTruthy();
    expect(JSON.stringify(toJSON())).not.toMatch(/\$\d/);
  });

  it('omits the privacy note without viewers', () => {
    setup();
    expect(render(<MemoryBookProductScreen />).queryByTestId('keepsakes-product-privacy')).toBeNull();
  });

  it('expands the grouped rest under "See N more", newest first, with the cautions', () => {
    setup();
    const { getByTestId, getByText, getAllByText, queryByTestId } = render(<MemoryBookProductScreen />);
    const lilaOptions = buildMemoryBookScopeOptions(lila.date_of_birth, TODAY);
    const expected = splitScopeOptions(lilaOptions, [], TODAY).more.reduce((n, g) => n + g.choices.length, 0);
    expect(getByText(`See ${expected} more`)).toBeTruthy();

    fireEvent.press(getByTestId('memory-book-scope-more'));
    expect(getByText('Years of life')).toBeTruthy();
    expect(getByText('Calendar years')).toBeTruthy();
    expect(getAllByText('Everything').length).toBeGreaterThan(0);
    expect(getByTestId(`memory-book-scope-${YEAR_SEVEN}`)).toBeTruthy();
    expect(getByText('Not over yet. The book holds what you’ve saved so far.')).toBeTruthy();
    expect(getByText('2026 so far')).toBeTruthy();
    expect(getByText('The year isn’t over. The book holds what you’ve saved so far.')).toBeTruthy();
    // Newest first inside "Years of life": Year Seven before Year One.
    const ids = (getByTestId('memory-book-group-Years of life').findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('memory-book-scope-')) as { props: { testID: string } }[])
      .map((n) => n.props.testID);
    expect(ids[0]).toBe(`memory-book-scope-${YEAR_SEVEN}`);
    expect(ids[ids.length - 1]).toBe('memory-book-scope-age_year:2020-03-01:2021-02-28');

    fireEvent.press(getByTestId('memory-book-scope-more'));
    expect(queryByTestId(`memory-book-scope-${YEAR_SEVEN}`)).toBeNull();
  });

  it('labels a period that already has a book and defaults to the first one without', () => {
    childSetups['child-1'] = { books: [book()] };
    setup();
    const { getByText, getByTestId } = render(<MemoryBookProductScreen />);
    expect(getByText('already made')).toBeTruthy();
    // Default = the first visible without a book (Year Five).
    expect(getByText('Make Lila’s Year Five book')).toBeTruthy();

    fireEvent.press(getByTestId(`memory-book-scope-${YEAR_SIX}`));
    expect(getByText('Open Lila’s book')).toBeTruthy();
    fireEvent.press(getByTestId('memory-book-product-cta'));
    expect(mockedOpenShopUrl).toHaveBeenCalledWith(memoryBookWebUrl('book-6'));
    expect(generate).not.toHaveBeenCalled();
  });

  it('shows the eligibility line for the selected period', () => {
    childSetups['child-1'] = { eligibility: { [YEAR_SIX]: 52, [YEAR_FIVE]: 1 } };
    setup();
    const { getByText, getByTestId, queryByTestId } = render(<MemoryBookProductScreen />);
    expect(getByText('52 moments in this period.')).toBeTruthy();
    expect(queryByTestId('memory-book-thin')).toBeNull();
    fireEvent.press(getByTestId(`memory-book-scope-${YEAR_FIVE}`));
    expect(getByText('1 moment in this period.')).toBeTruthy();
  });

  describe('thin periods', () => {
    it('warns without blocking, and offers photo import', () => {
      childSetups['child-1'] = { eligibility: { [YEAR_SIX]: 12 } };
      setup();
      const { getByText, getByTestId } = render(<MemoryBookProductScreen />);
      expect(getByText('12 moments in this period.')).toBeTruthy();
      expect(getByText('Not many moments yet')).toBeTruthy();
      expect(getByTestId('memory-book-product-cta').props.accessibilityState).toMatchObject({ disabled: false });
      fireEvent.press(getByTestId('memory-book-import-photos'));
      expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import', params: { surface: 'keepsakes' } });
    });

    it('omits the import action when gallery import is unavailable', () => {
      mockGalleryImportEnabled = false;
      childSetups['child-1'] = { eligibility: { [YEAR_SIX]: 12 } };
      setup();
      const { getByText, queryByTestId } = render(<MemoryBookProductScreen />);
      expect(getByText('Not many moments yet')).toBeTruthy();
      expect(queryByTestId('memory-book-import-photos')).toBeNull();
    });
  });

  describe('the CTA', () => {
    it('started: sets the toast and leaves', async () => {
      setup();
      generate.mockResolvedValue('started');
      const { getByTestId } = render(<MemoryBookProductScreen />);
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'age_year', label: 'Year Six' }));
      expect(consumePendingKeepsakesToast()).toBe('We’re making your Year Six book…');
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });

    it('tracks keepsakes_create_book_tapped once per "Make" tap, with the number of children it can make for', async () => {
      setup(); // Lila and Theo are own children; the grandparent is not one
      generate.mockResolvedValue('exists');
      const { getByTestId } = render(<MemoryBookProductScreen />);
      expect(mockTrackEvent).not.toHaveBeenCalledWith('keepsakes_create_book_tapped', expect.anything());
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith('keepsakes_create_book_tapped', { children_count: 2 });
    });

    it('does not track "Try again" or "Open" taps', async () => {
      childSetups['child-1'] = {
        books: [
          book({ id: 'book-5', status: 'failed', scope_start_date: '2024-03-01', scope_end_date: '2025-02-28', scope_label: 'Year Five' }),
          book(),
        ],
      };
      setup();
      generate.mockResolvedValue('exists');
      const { getByTestId } = render(<MemoryBookProductScreen />);
      fireEvent.press(getByTestId(`memory-book-scope-${YEAR_FIVE}`)); // failed -> "Try again"
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      fireEvent.press(getByTestId(`memory-book-scope-${YEAR_SIX}`)); // ready -> "Open"
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).not.toHaveBeenCalledWith('keepsakes_create_book_tapped', expect.anything());
    });

    it('started with no history falls back to the Keepsakes tab', async () => {
      mockRouter.canGoBack.mockReturnValue(false);
      setup();
      generate.mockResolvedValue('started');
      const { getByTestId } = render(<MemoryBookProductScreen />);
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/keepsakes');
    });

    it('exists: stays on the page with no toast', async () => {
      setup();
      generate.mockResolvedValue('exists');
      const { getByTestId } = render(<MemoryBookProductScreen />);
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(mockRouter.back).not.toHaveBeenCalled();
      expect(consumePendingKeepsakesToast()).toBeNull();
    });

    it('error: stays and shows the row’s dispatch error', async () => {
      childSetups['child-1'] = { dispatchErrors: { [YEAR_SIX]: 'Could not start your book.' } };
      setup();
      generate.mockResolvedValue('error');
      const { getByTestId, getByText } = render(<MemoryBookProductScreen />);
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(mockRouter.back).not.toHaveBeenCalled();
      expect(consumePendingKeepsakesToast()).toBeNull();
      expect(getByText('Could not start your book.')).toBeTruthy();
    });

    it('ignores a second tap while the first is in flight', async () => {
      setup();
      let resolve!: (value: string) => void;
      generate.mockReturnValue(new Promise((r) => { resolve = r; }));
      const { getByTestId } = render(<MemoryBookProductScreen />);
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(generate).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolve('exists');
      });
    });

    it('failed: "Try again" makes a fresh book with generate', async () => {
      childSetups['child-1'] = { books: [book({ id: 'book-5', status: 'failed', scope_start_date: '2024-03-01', scope_end_date: '2025-02-28', scope_label: 'Year Five' })] };
      setup();
      generate.mockResolvedValue('started');
      const { getByTestId, getByText } = render(<MemoryBookProductScreen />);
      // Year Five is the default? It has a book now, so select it explicitly.
      fireEvent.press(getByTestId(`memory-book-scope-${YEAR_FIVE}`));
      expect(getByText('couldn’t be made')).toBeTruthy();
      expect(getByText('Try again')).toBeTruthy();
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ label: 'Year Five' }));
      expect(retryDispatch).not.toHaveBeenCalled();
    });

    it('queued with a dispatch error: "Try again" re-dispatches the same row', async () => {
      childSetups['child-1'] = {
        books: [book({ id: 'book-q', status: 'queued', scope_start_date: '2024-03-01', scope_end_date: '2025-02-28', scope_label: 'Year Five' })],
        dispatchErrors: { [YEAR_FIVE]: 'Network request failed' },
      };
      setup();
      const { getByTestId, getByText } = render(<MemoryBookProductScreen />);
      fireEvent.press(getByTestId(`memory-book-scope-${YEAR_FIVE}`));
      expect(getByText('Try again')).toBeTruthy();
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(retryDispatch).toHaveBeenCalledWith(expect.objectContaining({ label: 'Year Five' }), 'book-q');
      expect(generate).not.toHaveBeenCalled();
    });

    it('queued for more than 10 minutes: "Try again" re-dispatches', async () => {
      childSetups['child-1'] = {
        books: [book({
          id: 'book-old', status: 'queued', created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
          scope_start_date: '2024-03-01', scope_end_date: '2025-02-28', scope_label: 'Year Five',
        })],
      };
      setup();
      const { getByTestId } = render(<MemoryBookProductScreen />);
      fireEvent.press(getByTestId(`memory-book-scope-${YEAR_FIVE}`));
      await act(async () => {
        fireEvent.press(getByTestId('memory-book-product-cta'));
      });
      expect(retryDispatch).toHaveBeenCalledWith(expect.anything(), 'book-old');
    });

    it('healthy in-progress book: a disabled "Being made…"', () => {
      childSetups['child-1'] = {
        books: [book({
          id: 'book-gen', status: 'generating', scope_start_date: '2024-03-01', scope_end_date: '2025-02-28', scope_label: 'Year Five',
        })],
      };
      setup();
      const { getByTestId, getByText } = render(<MemoryBookProductScreen />);
      fireEvent.press(getByTestId(`memory-book-scope-${YEAR_FIVE}`));
      expect(getByText('Being made…')).toBeTruthy();
      expect(getByText('being made')).toBeTruthy();
      expect(getByTestId('memory-book-product-cta').props.accessibilityState).toMatchObject({ disabled: true });
    });
  });

  describe('children', () => {
    it('shows chips for own children only, hides them for one child, and preselects ?memberId=', () => {
      mockParams = { memberId: 'child-2' };
      setup();
      const { getByTestId, queryByTestId, getByText } = render(<MemoryBookProductScreen />);
      expect(getByTestId('memory-book-child-child-1')).toBeTruthy();
      expect(getByTestId('memory-book-child-child-2')).toBeTruthy();
      expect(queryByTestId('memory-book-child-grandma')).toBeNull();
      expect(getByText('A year of Theo, printed and bound.')).toBeTruthy();
    });

    it('hides the chips with a single child', () => {
      setup({ members: [lila, grandma] });
      const { queryByTestId } = render(<MemoryBookProductScreen />);
      expect(queryByTestId('memory-book-child-child-1')).toBeNull();
    });

    it('keeps per-child state apart: a dispatch error on one child never shows for another', () => {
      childSetups['child-1'] = { dispatchErrors: { [YEAR_SIX]: 'Lila’s error' } };
      setup();
      const { getByTestId, getByText, queryByText } = render(<MemoryBookProductScreen />);
      expect(getByText('Lila’s error')).toBeTruthy();

      fireEvent.press(getByTestId('memory-book-child-child-2'));
      expect(queryByText('Lila’s error')).toBeNull();
      expect(getByText('A year of Theo, printed and bound.')).toBeTruthy();
      expect(mockedUseMemoryBooks).toHaveBeenLastCalledWith(expect.objectContaining({ childId: 'child-2' }));

      fireEvent.press(getByTestId('memory-book-child-child-1'));
      expect(getByText('Lila’s error')).toBeTruthy();
    });

    it('resets the selected period when switching children', () => {
      setup();
      const { getByTestId, getByText } = render(<MemoryBookProductScreen />);
      fireEvent.press(getByTestId(`memory-book-scope-${YEAR_FIVE}`));
      expect(getByText('Make Lila’s Year Five book')).toBeTruthy();
      fireEvent.press(getByTestId('memory-book-child-child-2'));
      fireEvent.press(getByTestId('memory-book-child-child-1'));
      expect(getByText('Make Lila’s Year Six book')).toBeTruthy();
    });

    it('includes a non-child who already has books', () => {
      setup({ members: [lila, grandma], books: [book({ child_id: 'grandma' })] });
      expect(render(<MemoryBookProductScreen />).getByTestId('memory-book-child-grandma')).toBeTruthy();
    });

    it('with no own children it hints and sends the user to Family', () => {
      setup({ members: [grandma] });
      const { getByTestId, getByText } = render(<MemoryBookProductScreen />);
      expect(getByText('Add your child to make a book')).toBeTruthy();
      expect(getByText('Go to Family')).toBeTruthy();
      fireEvent.press(getByTestId('memory-book-product-cta'));
      expect(mockRouter.navigate).toHaveBeenCalledWith('/(app)/(tabs)/family');
    });
  });

  it('a viewer is sent back', () => {
    setup({ role: 'viewer' });
    render(<MemoryBookProductScreen />);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('back leaves the page', () => {
    setup();
    const { getByTestId } = render(<MemoryBookProductScreen />);
    fireEvent.press(getByTestId('keepsakes-product-back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});
