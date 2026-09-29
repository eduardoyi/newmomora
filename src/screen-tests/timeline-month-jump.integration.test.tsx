import { act, fireEvent, render } from '@testing-library/react-native';
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

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
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
jest.mock('@/hooks/useMemoryMonthCounts', () => ({
  useMemoryMonthCounts: () => ({ counts: mockMonthCounts(), isLoaded: true, refreshIfStale: mockRefreshIfStale }),
}));
jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: () => ({ members: [{ id: 'member-1' }], isLoading: false }),
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

function renderTimeline() {
  const screen = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <TimelineScreen />
    </SafeAreaProvider>,
  );
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
    // The first memory (index 1), never the control row's slot.
    expect(list.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
    // No pull-to-refresh until the newest memory has loaded: it would re-fetch
    // the anchor mid-scroll.
    expect(list.props.refreshControl).toBeUndefined();
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

    // Anchored: no top content, so the row's slot is [0, 64) (52 + 12 gap).
    // May occupies [64, 364), April [364, 664).
    for (const [id, y] of [['may', 64], ['april', 364]] as const) {
      fireEvent(screen.getByTestId(`timeline-cell-${id}`), 'layout', {
        nativeEvent: { layout: { x: 0, y, width: 390, height: 300 } },
      });
    }

    scrollTo(screen, 250); // line just under the pinned row: 315 -> May
    expect(screen.getByText('May 2025')).toBeTruthy();

    // May's last 44pt are still on screen but under the row -- April is the
    // card the reader sees first.
    scrollTo(screen, 320); // line 385 -> April
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
    expect(screen.getByTestId('timeline-memory-list').props.refreshControl).toBeTruthy();
  });

  it('keeps the control row outside the list, so it stays tappable when pinned', () => {
    const screen = renderTimeline();
    const list = screen.getByTestId('timeline-memory-list');
    expect(list.findAll((node) => node.props.testID === 'timeline-control-row')).toHaveLength(0);
    expect(list.props.stickyHeaderIndices ?? []).toEqual([]);
    expect(screen.getByTestId('timeline-control-row')).toBeTruthy();
  });
});
