import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FlatList } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Timeline date jump (docs/plans/timeline-calendar-keepsakes.md Phase A):
// the pinned bar's month trigger opens the picker (real sheet here, with
// per-month counts), a pick re-renders the list anchored at that month, and
// Today / the FAB / a Timeline tab re-press return to the feed. useMemories
// is mocked -- the anchored query itself is covered by
// useMemories.integration.test.tsx ("anchored mode").

const mockUseMemories = jest.fn();
const mockMonthCounts = jest.fn();
const mockRefreshIfStale = jest.fn();
let mockTabPressListener: (() => void) | undefined;
// Year Films (docs/plans/year-film-p2.md Step 5): the films query and the
// caller's views are mocked; FilmCard/FilmCover render for real (the poster
// hook is stubbed, the cover needs a QueryClientProvider).
let mockFilms: unknown[] = [];
let mockFilmsFetched = true;
let mockViewedIds = new Set<string>();
let mockViewsLoading = false;
const mockRefetchFilms = jest.fn();
const mockUseFamilyYearFilms = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = jest.requireActual('react') as typeof import('react');
    useEffect(callback, [callback]);
  },
  useNavigation: () => ({
    addListener: (_event: string, listener: () => void) => {
      mockTabPressListener = listener;
      return () => undefined;
    },
    isFocused: () => true,
  }),
}));
jest.mock('@/hooks/use-family', () => ({ useFamily: () => ({ role: 'owner', familyId: 'family-1' }) }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
jest.mock('@/hooks/useMemories', () => ({ useMemories: (options: unknown) => mockUseMemories(options) }));
jest.mock('@/hooks/useYearFilms', () => ({
  useFamilyYearFilms: (...args: unknown[]) => {
    mockUseFamilyYearFilms(...args);
    return { films: mockFilms, isFetched: mockFilmsFetched, refetch: mockRefetchFilms };
  },
  useYearFilmViews: () => ({ viewedIds: mockViewedIds, isLoading: mockViewsLoading }),
  useYearFilmPosters: () => ({}),
  invalidateYearFilmPoster: jest.fn(),
}));
jest.mock('@/hooks/useMemoryMonthCounts', () => ({
  useMemoryMonthCounts: () => ({ counts: mockMonthCounts(), isLoaded: true, refreshIfStale: mockRefreshIfStale }),
}));
jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: () => ({ members: [{ id: 'member-1', name: 'Enzo' }], isLoading: false }),
  useOnboardingStatus: () => ({ isLoading: false, needsFamilyMember: false }),
}));
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false, isError: false,
    isTargetReported: () => false, isUserBlocked: () => false,
    revealTarget: jest.fn(), refetch: jest.fn(),
  }),
}));
jest.mock('@/hooks/useLookingBackPackages', () => ({
  useLookingBackPackages: () => ({ packages: [], isRefetching: false, refetch: jest.fn() }),
}));
jest.mock('@/hooks/useLookingBackSession', () => ({
  useLookingBackSession: () => ({ clearCheckpoint: jest.fn(), savePackageSnapshot: jest.fn() }),
}));
jest.mock('@/hooks/useFamilyActivity', () => ({
  useFamilyActivityUnread: () => ({ unread: false, isLoading: false, refetch: jest.fn() }),
}));
jest.mock('@/hooks/useGalleryImport', () => ({
  useGalleryImportEntryStatus: () => ({
    readyCount: 0, checkpoint: null, run: null, state: 'none',
    driverState: { phase: 'idle' }, comingIndicator: { kind: 'none' },
  }),
}));
jest.mock('@/utils/gallery-import-flags', () => ({ isGalleryImportFeatureEnabled: false }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/components/memory-card', () => ({ MemoryCard: () => null }));
jest.mock('@/components/memory-fab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    MemoryFab: ({ onPress }: { onPress: () => void }) =>
      React.createElement(Pressable, { onPress, testID: 'memory-fab' }),
  };
});
jest.mock('@/components/pending-memory-uploads-banner', () => ({ PendingMemoryUploadsBanner: () => null }));
jest.mock('@/components/looking-back/package-rail', () => ({ LookingBackPackageRail: () => null }));
jest.mock('@/components/family-activity-sheet', () => ({ FamilyActivitySheet: () => null }));
// The Calendar view renders the real month items; only their data and
// media are mocked (the month component itself: calendar-month-grid.test.tsx).
const mockGridMemories = jest.fn(() => [] as unknown[]);
jest.mock('@/hooks/useCalendarMemories', () => ({
  useCalendarMemoriesInRange: () => ({ data: mockGridMemories(), refetch: jest.fn() }),
}));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: null })) }));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnail: jest.fn(() => null) }));

// eslint-disable-next-line import/first
import TimelineScreen from '../../app/(app)/(tabs)/timeline';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { router: mockRouter } = require('expo-router') as { router: { push: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const asyncStorageModule = require('@react-native-async-storage/async-storage');
const AsyncStorage = (asyncStorageModule.default ?? asyncStorageModule) as { getItem: jest.Mock; setItem: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { trackEvent: mockTrackEvent } = require('@/services/analytics') as { trackEvent: jest.Mock };

const now = new Date();
const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

const recentMemory = {
  id: 'recent', content: 'Today', memory_date: `${currentMonthKey}-01`, memory_type: 'text_only',
  taggedMembers: [], mediaAssets: [], user_id: 'user-1',
};
const marchMemory = {
  id: 'march', content: 'March', memory_date: '2025-03-20', memory_type: 'text_only',
  taggedMembers: [], mediaAssets: [], user_id: 'user-1',
};

function hookResult(memories: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    memories,
    isLoading: false,
    isRefetching: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchPreviousPage: jest.fn(),
    hasPreviousPage: false,
    isFetchingPreviousPage: false,
    ...overrides,
  };
}

function lastAnchorDate() {
  return (mockUseMemories.mock.calls.at(-1)?.[0] as { anchorDate: string | null }).anchorDate;
}

// The pinned control row overlay stays hidden (and untouchable) until the
// top content above it has been measured -- Jest runs no layout, so fire it.
function layoutTopContent(screen: ReturnType<typeof render>) {
  const top = screen.queryByTestId('timeline-top-sections');
  if (top) {
    fireEvent(top, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } } });
  }
}

// requestAnimationFrame is a 0ms timer under jest: let the ones the Timeline
// queued on its last render/layout fire before the environment is torn down.
afterAll(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

const queryClient = new QueryClient();

function timelineTree() {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <TimelineScreen />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  // FilmCover's poster queries hold a 55-minute gc timer.
  queryClient.clear();
});

beforeEach(() => {
  mockFilms = [];
  mockFilmsFetched = true;
  mockViewedIds = new Set();
  mockViewsLoading = false;
});

function renderTimeline() {
  const screen = render(timelineTree());
  layoutTopContent(screen);
  return screen;
}

async function jumpToMarch2025(screen: ReturnType<typeof renderTimeline>) {
  fireEvent.press(screen.getByTestId('timeline-month-trigger'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('month-picker-option-2025-03-01'));
  });
}

describe('Timeline month jump', () => {
  let fetchPreviousPage: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTabPressListener = undefined;
    fetchPreviousPage = jest.fn();
    mockMonthCounts.mockReturnValue({ [currentMonthKey]: 1, '2025-03': 4 });
    mockUseMemories.mockImplementation((options: { anchorDate: string | null }) =>
      options.anchorDate
        ? hookResult([marchMemory], { hasPreviousPage: true, fetchPreviousPage })
        : hookResult([recentMemory]),
    );
  });

  it('disables the month trigger when no other month has memories', () => {
    mockMonthCounts.mockReturnValue({ [currentMonthKey]: 3 });
    const screen = renderTimeline();
    expect(screen.getByTestId('timeline-month-trigger').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('labels the pinned bar with the current month and year on the feed', () => {
    const screen = renderTimeline();
    const label = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByTestId('timeline-today-button')).toBeNull();
  });

  it('shows counts, disables empty months, and anchors the list at the picked month\'s last day', async () => {
    const screen = renderTimeline();
    fireEvent.press(screen.getByTestId('timeline-month-trigger'));

    expect(mockRefreshIfStale).toHaveBeenCalled();
    expect(screen.getByTestId('month-picker-option-2025-03-01').props.accessibilityLabel)
      .toBe('March 2025, 4 memories');
    expect(screen.getByTestId('month-picker-option-2025-04-01').props.accessibilityState)
      .toMatchObject({ disabled: true });

    await act(async () => {
      fireEvent.press(screen.getByTestId('month-picker-option-2025-03-01'));
    });

    expect(lastAnchorDate()).toBe('2025-03-31');
    expect(screen.getByText('March 2025')).toBeTruthy();
    expect(screen.getByTestId('timeline-today-button')).toBeTruthy();
    // A jump hides the top content: the list starts at the (sticky) control row.
    expect(screen.queryByTestId('timeline-week-section')).toBeNull();
    expect(screen.queryByTestId('timeline-title-section')).toBeNull();
    expect(screen.getByTestId('timeline-control-row-slot')).toBeTruthy();
    expect(screen.queryByTestId('timeline-recently-section')).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith('timeline_jumped', {
      source: 'month_picker',
      months_back: expect.any(Number),
    });
  });

  it('extends an anchored list upward from onStartReached', async () => {
    const screen = renderTimeline();
    await jumpToMarch2025(screen);

    const list = screen.getByTestId('timeline-memory-list');
    // The first memory, never the control row's slot: FlatList's
    // minIndexForVisible 1, which the host ScrollView sees as 2 because the
    // list always has a header (the "Loading newer memories" strip here).
    expect(list.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 2 });
    // Pull-to-refresh is DISABLED (never removed -- removing it re-creates
    // Android's ScrollView at offset 0) until the newest memory has loaded.
    expect(list.props.refreshControl.props.enabled).toBe(false);
    expect(screen.getByTestId('timeline-newer-header')).toBeTruthy();
    act(() => {
      list.props.onStartReached({ distanceFromStart: 0 });
    });
    expect(fetchPreviousPage).toHaveBeenCalledTimes(1);
  });

  it('returns to the feed from the Today button', async () => {
    const screen = renderTimeline();
    await jumpToMarch2025(screen);

    fireEvent.press(screen.getByTestId('timeline-today-button'));

    expect(lastAnchorDate()).toBeNull();
    expect(screen.queryByTestId('timeline-today-button')).toBeNull();
    expect(screen.getByTestId('timeline-week-section')).toBeTruthy();
  });

  it('returns to the feed before starting a new memory from the FAB', async () => {
    const screen = renderTimeline();
    await jumpToMarch2025(screen);

    fireEvent.press(screen.getByTestId('memory-fab'));

    expect(lastAnchorDate()).toBeNull();
    expect(mockRouter.push).toHaveBeenCalled();
  });

  it('returns to the feed on a Timeline tab re-press', async () => {
    const screen = renderTimeline();
    await jumpToMarch2025(screen);

    act(() => {
      mockTabPressListener?.();
    });

    expect(lastAnchorDate()).toBeNull();
  });
});

// Calendar view (docs/plans/timeline-calendar-keepsakes.md Phase B + the
// sticky control row redesign): one list, the control row sticky, months
// below it in Calendar view.
describe('Timeline Calendar view', () => {
  const firstOfMonth = `${currentMonthKey}-01`;
  const todayIso = `${currentMonthKey}-${String(now.getDate()).padStart(2, '0')}`;

  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.getItem.mockResolvedValue(null);
    mockMonthCounts.mockReturnValue({ [currentMonthKey]: 1, '2025-03': 4 });
    // Anchored lists still have newer pages to load (so the top content stays
    // hidden after a jump until the newest memory is reached).
    mockUseMemories.mockImplementation((options: { anchorDate: string | null }) =>
      options.anchorDate
        ? hookResult([marchMemory], { hasPreviousPage: true })
        : hookResult([recentMemory]),
    );
    mockGridMemories.mockReturnValue([
      { ...recentMemory, id: 'grid-1', memory_date: firstOfMonth, emotion: 'joy', updated_at: 'x' },
    ]);
  });

  async function switchToCalendar(screen: ReturnType<typeof renderTimeline>) {
    await act(async () => {
      fireEvent.press(screen.getByTestId('timeline-view-calendar'));
    });
    layoutTopContent(screen);
  }

  it('swaps what is below the control row for month grids, keeping the top content, and remembers the choice', async () => {
    const screen = renderTimeline();
    expect(screen.getByTestId('timeline-memory-list')).toBeTruthy();

    await switchToCalendar(screen);

    expect(screen.getByTestId('calendar-grid')).toBeTruthy();
    expect(screen.queryByTestId('timeline-memory-list')).toBeNull();
    expect(screen.getByTestId(`calendar-grid-month-${currentMonthKey}`)).toBeTruthy();
    // Weekday letters ride in the sticky control row; the title and This week stay above.
    expect(screen.getByTestId('calendar-grid-weekdays')).toBeTruthy();
    expect(screen.getByTestId('timeline-title-section')).toBeTruthy();
    expect(screen.getByTestId('timeline-week-section')).toBeTruthy();
    expect(screen.getByTestId('timeline-view-calendar').props.accessibilityState).toMatchObject({ selected: true });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('timeline.view', 'calendar');
    expect(mockTrackEvent).toHaveBeenCalledWith('timeline_view_switched', { view: 'calendar' });
  });

  it('opens in Calendar when that was the saved view', async () => {
    AsyncStorage.getItem.mockResolvedValue('calendar');
    const screen = renderTimeline();
    expect(await screen.findByTestId('calendar-grid')).toBeTruthy();
  });

  it('opens the list at a tapped day, hiding the top content, without overwriting the saved view', async () => {
    const screen = renderTimeline();
    await switchToCalendar(screen);
    AsyncStorage.setItem.mockClear();

    fireEvent.press(screen.getByTestId(`calendar-grid-day-${firstOfMonth}`));

    expect(screen.getByTestId('timeline-memory-list')).toBeTruthy();
    const expectedAnchor = firstOfMonth === todayIso ? null : firstOfMonth;
    expect(lastAnchorDate()).toBe(expectedAnchor);
    if (expectedAnchor) {
      expect(screen.queryByTestId('timeline-title-section')).toBeNull();
    }
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith('timeline_jumped', {
      source: 'calendar_day',
      months_back: 0,
    });
  });

  it('shows Today once scrolled away, and scrolls back to the top with it', async () => {
    const scrollSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    const screen = renderTimeline();
    await switchToCalendar(screen);
    expect(screen.queryByTestId('timeline-today-button')).toBeNull();

    fireEvent.scroll(screen.getByTestId('calendar-grid'), {
      nativeEvent: {
        contentOffset: { x: 0, y: 5000 },
        contentSize: { height: 10000, width: 400 },
        layoutMeasurement: { height: 800, width: 400 },
      },
    });
    fireEvent.press(screen.getByTestId('timeline-today-button'));

    expect(scrollSpy).toHaveBeenCalledWith({ animated: true, offset: 0 });
    scrollSpy.mockRestore();
  });

  it('makes a month pick scroll the grid instead of anchoring the list', async () => {
    const scrollSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    const screen = renderTimeline();
    await switchToCalendar(screen);
    const anchorBefore = lastAnchorDate();

    fireEvent.press(screen.getByTestId('timeline-month-trigger'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('month-picker-option-2025-03-01'));
    });

    expect(scrollSpy).toHaveBeenCalledWith({ animated: false, offset: expect.any(Number) });
    expect(lastAnchorDate()).toBe(anchorBefore);
    expect(screen.getByTestId('calendar-grid')).toBeTruthy();
    expect(screen.getByText('March 2025')).toBeTruthy();
    scrollSpy.mockRestore();
  });
});

describe('Timeline control row geometry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.getItem.mockResolvedValue(null);
    mockMonthCounts.mockReturnValue({ [currentMonthKey]: 1, '2025-03': 4 });
  });

  function jumpToMarch(screen: ReturnType<typeof renderTimeline>) {
    fireEvent.press(screen.getByTestId('timeline-month-trigger'));
    act(() => {
      fireEvent.press(screen.getByTestId('month-picker-option-2025-03-01'));
    });
  }

  function scrollTo(screen: ReturnType<typeof renderTimeline>, y: number) {
    fireEvent.scroll(screen.getByTestId('timeline-memory-list'), {
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { height: 5000, width: 390 },
        layoutMeasurement: { height: 800, width: 390 },
      },
    });
  }

  it('labels the month from the card right under the row, never one hidden under it', () => {
    const may = { ...marchMemory, id: 'may', memory_date: '2025-05-02' };
    const april = { ...marchMemory, id: 'april', memory_date: '2025-04-20' };
    mockUseMemories.mockImplementation(() => hookResult([may, april], { hasPreviousPage: true }));
    const screen = renderTimeline();
    jumpToMarch(screen);

    // Anchored: the 48pt "Loading newer memories" strip, then the row's slot
    // [48, 112) (52 + 12 gap). May occupies [112, 412), April [412, 712).
    for (const [id, y] of [['may', 112], ['april', 412]] as const) {
      fireEvent(screen.getByTestId(`timeline-cell-${id}`), 'layout', {
        nativeEvent: { layout: { x: 0, y, width: 390, height: 300 } },
      });
    }

    scrollTo(screen, 250); // line just under the pinned row: 315 -> May
    expect(screen.getByText('May 2025')).toBeTruthy();

    // May's last 52pt are still on screen but under the pinned row -- April
    // is the card the reader sees first.
    scrollTo(screen, 360); // line 425 -> April
    expect(screen.getByText('April 2025')).toBeTruthy();
  });

  it('brings the top content back once an anchored list has loaded up to the newest memory', () => {
    mockUseMemories.mockImplementation((options: { anchorDate: string | null }) =>
      hookResult([marchMemory], options.anchorDate ? { hasPreviousPage: false } : {}),
    );
    const screen = renderTimeline();
    jumpToMarch(screen);

    expect(lastAnchorDate()).toBe('2025-03-31');
    // Nothing newer left to load: the list is back at today's top.
    expect(screen.getByTestId('timeline-title-section')).toBeTruthy();
    expect(screen.queryByTestId('timeline-today-button')).toBeNull();
    expect(screen.getByTestId('timeline-memory-list').props.refreshControl.props.enabled).toBe(true);
    expect(screen.queryByTestId('timeline-newer-header')).toBeNull();
  });

  it('keeps the control row outside the list, so it stays tappable when pinned', () => {
    const screen = renderTimeline();
    const list = screen.getByTestId('timeline-memory-list');
    expect(list.findAll((node) => node.props.testID === 'timeline-control-row')).toHaveLength(0);
    expect(list.props.stickyHeaderIndices ?? []).toEqual([]);
    expect(screen.getByTestId('timeline-control-row')).toBeTruthy();
  });
});

describe('Timeline list stays mounted across a jump', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.getItem.mockResolvedValue(null);
    mockMonthCounts.mockReturnValue({ [currentMonthKey]: 1, '2025-03': 4 });
  });

  it('keeps the same RefreshControl element type whether or not pull-to-refresh is allowed', () => {
    // Regression: swapping refreshControl in/out re-creates Android's native
    // ScrollView at offset 0 without a scroll event (jump "flashes" back to
    // today; row stuck pinned over the title).
    let hasPreviousPage = true;
    mockUseMemories.mockImplementation((options: { anchorDate: string | null }) =>
      hookResult([marchMemory], options.anchorDate ? { hasPreviousPage } : {}),
    );
    const screen = renderTimeline();
    fireEvent.press(screen.getByTestId('timeline-month-trigger'));
    act(() => {
      fireEvent.press(screen.getByTestId('month-picker-option-2025-03-01'));
    });
    const before = screen.getByTestId('timeline-memory-list').props.refreshControl;
    expect(before.props.enabled).toBe(false);

    hasPreviousPage = false;
    screen.rerender(timelineTree());
    const after = screen.getByTestId('timeline-memory-list').props.refreshControl;
    expect(after.type).toBe(before.type);
    expect(after.props.enabled).toBe(true);
  });
});

describe('Timeline jump lands exactly under the control row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.getItem.mockResolvedValue(null);
    mockMonthCounts.mockReturnValue({ [currentMonthKey]: 1, '2025-03': 4 });
  });

  it('scrolls the newest memory on or before the anchor date to sit right under the row', async () => {
    // The anchored list already holds a newer (April) page above March -- the
    // prepend that used to leave April's last card peeking under the row.
    const april = { ...marchMemory, id: 'april', memory_date: '2025-04-02' };
    mockUseMemories.mockImplementation((options: { anchorDate: string | null }) =>
      options.anchorDate ? hookResult([april, marchMemory], { hasPreviousPage: true }) : hookResult([recentMemory]),
    );
    const scrollSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    const screen = renderTimeline();
    fireEvent.press(screen.getByTestId('timeline-month-trigger'));
    act(() => {
      fireEvent.press(screen.getByTestId('month-picker-option-2025-03-01'));
    });

    // Strip [0, 48), row slot [48, 112), April [112, 712), March from 712.
    fireEvent(screen.getByTestId('timeline-cell-april'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 112, width: 390, height: 600 } },
    });
    fireEvent(screen.getByTestId('timeline-cell-march'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 712, width: 390, height: 300 } },
    });

    // March's top at the row's bottom edge (64 = 52 + 12 gap).
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ animated: false, offset: 712 - 64 }));
    scrollSpy.mockRestore();
  });
});

// Year Film cards in the Timeline (docs/plans/year-film-p2.md Step 5).
describe('Timeline Year Films', () => {
  const firstOfMonth = `${currentMonthKey}-01`;

  function yearFilm(overrides: Record<string, unknown> = {}) {
    return {
      id: 'film-mar',
      kind: 'family_month',
      family_member_id: null,
      age_year: null,
      placement_date: '2025-03-31',
      scope_start_date: '2025-03-01',
      duration_ms: 60000,
      // Surfaced long ago: backfilled history is never "New".
      surface_at: '2025-04-01T00:00:00.000Z',
      ready_at: '2025-04-01T01:00:00.000Z',
      ...overrides,
    };
  }

  // Cell test ids in render order: 'recent', 'film:film-mar', 'march', ...
  function cellOrder(screen: ReturnType<typeof renderTimeline>) {
    return screen
      .getAllByTestId(/^timeline-cell-/)
      .map((node) => String(node.props.testID).replace('timeline-cell-', ''));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.getItem.mockResolvedValue(null);
    mockMonthCounts.mockReturnValue({ [currentMonthKey]: 1, '2025-03': 4 });
    mockUseMemories.mockImplementation((options: { anchorDate: string | null }) =>
      options.anchorDate
        ? hookResult([marchMemory], { hasPreviousPage: true })
        : hookResult([recentMemory], { hasNextPage: true }),
    );
  });

  it('refreshes the films on screen focus and with pull-to-refresh', () => {
    const screen = renderTimeline();
    expect(mockRefetchFilms).toHaveBeenCalledWith({ cancelRefetch: false });
    mockRefetchFilms.mockClear();

    const onRefresh = screen.getByTestId('timeline-memory-list').props.refreshControl.props.onRefresh as () => void;
    act(() => onRefresh());
    expect(mockRefetchFilms).toHaveBeenCalledTimes(1);
  });

  it('interleaves a film between the memories it falls between, and only where the window proves its position', () => {
    // Feed: 'recent' (this month) then 'march'; more older pages exist.
    mockUseMemories.mockImplementation(() => hookResult([recentMemory, marchMemory], { hasNextPage: true }));
    mockFilms = [
      yearFilm(),
      // Older than every loaded memory while older pages remain: not shown.
      yearFilm({ id: 'film-old', placement_date: '2024-01-31', scope_start_date: '2024-01-01' }),
    ];
    const screen = renderTimeline();

    expect(cellOrder(screen)).toEqual(['recent', 'film:film-mar', 'march']);
    expect(screen.queryByTestId('timeline-film-film-old')).toBeNull();
    expect(screen.getByTestId('timeline-film-film-mar').props.accessibilityLabel).toBe('Play March recap');
  });

  it('polls the films only while the Timeline is focused (passes its focus state to the hook)', () => {
    renderTimeline();
    expect(mockUseFamilyYearFilms).toHaveBeenCalledWith('family-1', { isFocused: true });
  });

  it('keeps a remaking film in its place as a non-pressable placeholder', () => {
    mockUseMemories.mockImplementation(() => hookResult([recentMemory, marchMemory], { hasNextPage: true }));
    mockFilms = [yearFilm({ blocked: true, stale: true, status: 'rendering' })];
    const screen = renderTimeline();

    // Same cell, same order as the playable card.
    expect(cellOrder(screen)).toEqual(['recent', 'film:film-mar', 'march']);
    const placeholder = screen.getByTestId('timeline-film-film-mar-remaking');
    expect(placeholder.props.accessibilityRole).not.toBe('button');
    expect(screen.getByText('Remaking your film…')).toBeTruthy();
    expect(screen.getByText('This takes a few minutes')).toBeTruthy();
    expect(screen.queryByTestId('timeline-film-film-mar')).toBeNull();
    expect(screen.queryByTestId('timeline-film-film-mar-play')).toBeNull();
    fireEvent.press(placeholder);
    expect(mockRouter.push).not.toHaveBeenCalledWith('/(app)/year-film/film-mar?source=timeline');
  });

  it('shows an updating film as a playable card with an Updating sticker', () => {
    mockUseMemories.mockImplementation(() => hookResult([recentMemory, marchMemory]));
    mockFilms = [yearFilm({ blocked: false, stale: true, status: 'curating' })];
    const screen = renderTimeline();

    expect(screen.getByTestId('timeline-film-film-mar-updating')).toHaveTextContent('Updating…');
    fireEvent.press(screen.getByTestId('timeline-film-film-mar'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/film-mar?source=timeline');
  });

  it('shows a film below the last memory once no older pages remain', () => {
    mockUseMemories.mockImplementation(() => hookResult([recentMemory, marchMemory], { hasNextPage: false }));
    mockFilms = [yearFilm({ id: 'film-old', placement_date: '2024-01-31', scope_start_date: '2024-01-01' })];
    const screen = renderTimeline();

    expect(cellOrder(screen)).toEqual(['recent', 'march', 'film:film-old']);
  });

  it('opens the player from the card with source timeline', () => {
    mockUseMemories.mockImplementation(() => hookResult([recentMemory, marchMemory]));
    mockFilms = [yearFilm()];
    const screen = renderTimeline();

    const card = screen.getByTestId('timeline-film-film-mar');
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityLabel).toBe('Play March recap');
    fireEvent.press(card);
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/year-film/film-mar?source=timeline');
  });

  it('marks a freshly surfaced, unwatched film "New" only once the views have loaded', () => {
    mockUseMemories.mockImplementation(() => hookResult([recentMemory, marchMemory]));
    mockFilms = [yearFilm({ surface_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() })];

    mockViewsLoading = true;
    const loading = renderTimeline();
    expect(loading.queryByTestId('timeline-film-film-mar-new')).toBeNull();
    loading.unmount();

    mockViewsLoading = false;
    const loaded = renderTimeline();
    expect(loaded.getByTestId('timeline-film-film-mar-new')).toBeTruthy();
    loaded.unmount();

    mockViewedIds = new Set(['film-mar']);
    const watched = renderTimeline();
    expect(watched.queryByTestId('timeline-film-film-mar-new')).toBeNull();
  });

  it('does not mark backfilled history "New"', () => {
    mockUseMemories.mockImplementation(() => hookResult([recentMemory, marchMemory]));
    mockFilms = [yearFilm()];
    const screen = renderTimeline();
    expect(screen.queryByTestId('timeline-film-film-mar-new')).toBeNull();
  });

  it('shows the recap that caps a month at the top of an anchored month jump and lands on it', async () => {
    mockFilms = [
      yearFilm(),
      // April's recap is newer than the anchor: it belongs above the window.
      yearFilm({ id: 'film-apr', placement_date: '2025-04-30', scope_start_date: '2025-04-01' }),
    ];
    const scrollSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    const screen = renderTimeline();
    await jumpToMarch2025(screen);

    expect(lastAnchorDate()).toBe('2025-03-31');
    expect(cellOrder(screen)).toEqual(['film:film-mar', 'march']);
    expect(screen.queryByTestId('timeline-film-film-apr')).toBeNull();

    // Strip [0, 48), row slot [48, 112), the recap card from 112: it, not
    // March's first memory, lands under the row (64 = 52 + 12 gap).
    fireEvent(screen.getByTestId('timeline-cell-film:film-mar'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 112, width: 390, height: 190 } },
    });
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ animated: false, offset: 112 - 64 }));
    scrollSpy.mockRestore();
  });

  it('adds a film that sits above the loaded window when the newer page lands', async () => {
    mockFilms = [yearFilm({ id: 'film-mid', placement_date: '2025-04-15', scope_start_date: '2025-04-01' })];
    const screen = renderTimeline();
    await jumpToMarch2025(screen);
    // Newer than the anchor and nothing newer loaded yet: position unprovable.
    expect(screen.queryByTestId('timeline-film-film-mid')).toBeNull();

    const april = { ...marchMemory, id: 'april-20', memory_date: '2025-04-20' };
    mockUseMemories.mockImplementation(() =>
      hookResult([april, marchMemory], { hasPreviousPage: true }),
    );
    screen.rerender(timelineTree());

    expect(cellOrder(screen)).toEqual(['april-20', 'film:film-mid', 'march']);
  });

  it('waits for the first films response before rendering an anchored list', async () => {
    mockFilmsFetched = false;
    const screen = renderTimeline();
    await jumpToMarch2025(screen);
    expect(screen.queryByTestId('timeline-memory-list')).toBeNull();

    mockFilmsFetched = true;
    mockFilms = [yearFilm()];
    screen.rerender(timelineTree());
    expect(screen.getByTestId('timeline-memory-list')).toBeTruthy();
    expect(cellOrder(screen)).toEqual(['film:film-mar', 'march']);
  });

  describe('Calendar view', () => {
    async function switchToCalendar(screen: ReturnType<typeof renderTimeline>) {
      await act(async () => {
        fireEvent.press(screen.getByTestId('timeline-view-calendar'));
      });
      layoutTopContent(screen);
    }

    it('dots a film day and opens the list at a film-only day', async () => {
      mockGridMemories.mockReturnValue([
        { ...recentMemory, id: 'grid-1', memory_date: firstOfMonth, emotion: 'joy', updated_at: 'x' },
      ]);
      // A memory-less day that is neither the 1st nor today.
      const filmDay = `${currentMonthKey}-${String(now.getDate() === 2 ? 3 : 2).padStart(2, '0')}`;
      mockFilms = [yearFilm({ id: 'film-day', placement_date: filmDay, scope_start_date: firstOfMonth })];
      const screen = renderTimeline();
      await switchToCalendar(screen);

      expect(screen.getByTestId(`calendar-grid-day-${filmDay}-film`)).toBeTruthy();
      const tile = screen.getByTestId(`calendar-grid-day-${filmDay}`);
      expect(tile.props.accessibilityRole).toBe('button');

      fireEvent.press(tile);

      expect(lastAnchorDate()).toBe(filmDay);
      expect(screen.getByTestId('timeline-memory-list')).toBeTruthy();
      expect(screen.getByTestId('timeline-film-film-day')).toBeTruthy();
    });
  });
});
