import { act, fireEvent, render } from '@testing-library/react-native';
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
// The grid itself is covered by calendar-month-grid.test.tsx; here a stub
// records its props and exposes the imperative scrollToMonth handle.
const mockScrollToMonth = jest.fn();
const mockGridProps = jest.fn();
jest.mock('@/components/timeline/calendar-month-grid', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, View } = require('react-native');
  return {
    CalendarMonthGrid: (props: {
      ref: unknown;
      onDayPress: (iso: string) => void;
      onTopMonthChange: (key: string) => void;
    }) => {
      mockGridProps(props);
      React.useImperativeHandle(props.ref, () => ({ scrollToMonth: mockScrollToMonth }));
      return React.createElement(View, { testID: 'calendar-grid' },
        React.createElement(Pressable, { testID: 'stub-day-march', onPress: () => props.onDayPress('2025-03-20') }),
        React.createElement(Pressable, { testID: 'stub-scroll-march', onPress: () => props.onTopMonthChange('2025-03') }),
      );
    },
  };
});

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

function renderTimeline() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <TimelineScreen />
    </SafeAreaProvider>,
  );
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
    // "Now" sections are gone from an anchored list.
    expect(screen.queryByTestId('timeline-week-section')).toBeNull();
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
    // FlatList passes { minIndexForVisible: 0 } down; VirtualizedList shifts
    // it by one for the ListHeaderComponent cell on the host ScrollView.
    expect(list.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
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

// Calendar view (docs/plans/timeline-calendar-keepsakes.md Phase B).
describe('Timeline Calendar view', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.getItem.mockResolvedValue(null);
    mockMonthCounts.mockReturnValue({ [currentMonthKey]: 1, '2025-03': 4 });
    mockUseMemories.mockImplementation((options: { anchorDate: string | null }) =>
      hookResult(options.anchorDate ? [marchMemory] : [recentMemory]),
    );
  });

  async function switchToCalendar(screen: ReturnType<typeof renderTimeline>) {
    await act(async () => {
      fireEvent.press(screen.getByTestId('timeline-view-calendar'));
    });
  }

  it('swaps the list for the grid, opening at the month the list shows, and remembers the choice', async () => {
    const screen = renderTimeline();
    expect(screen.getByTestId('timeline-memory-list')).toBeTruthy();

    await switchToCalendar(screen);

    expect(screen.getByTestId('calendar-grid')).toBeTruthy();
    expect(screen.queryByTestId('timeline-memory-list')).toBeNull();
    expect(mockGridProps).toHaveBeenLastCalledWith(expect.objectContaining({ initialMonthKey: currentMonthKey }));
    expect(screen.getByTestId('timeline-view-calendar').props.accessibilityState).toMatchObject({ selected: true });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('timeline.view', 'calendar');
    expect(mockTrackEvent).toHaveBeenCalledWith('timeline_view_switched', { view: 'calendar' });
  });

  it('opens in Calendar when that was the saved view', async () => {
    AsyncStorage.getItem.mockResolvedValue('calendar');
    const screen = renderTimeline();
    expect(await screen.findByTestId('calendar-grid')).toBeTruthy();
  });

  it('opens the list at a tapped day without overwriting the saved view', async () => {
    const screen = renderTimeline();
    await switchToCalendar(screen);
    AsyncStorage.setItem.mockClear();

    fireEvent.press(screen.getByTestId('stub-day-march'));

    expect(screen.getByTestId('timeline-memory-list')).toBeTruthy();
    expect(lastAnchorDate()).toBe('2025-03-20');
    expect(screen.getByTestId('timeline-today-button')).toBeTruthy();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith('timeline_jumped', {
      source: 'calendar_day',
      months_back: expect.any(Number),
    });
  });

  it('tracks the grid\'s top month in the pinned label, with Today scrolling back to this month', async () => {
    const screen = renderTimeline();
    await switchToCalendar(screen);
    expect(screen.queryByTestId('timeline-today-button')).toBeNull();

    fireEvent.press(screen.getByTestId('stub-scroll-march'));
    expect(screen.getByText('March 2025')).toBeTruthy();

    fireEvent.press(screen.getByTestId('timeline-today-button'));
    expect(mockScrollToMonth).toHaveBeenCalledWith(currentMonthKey);
  });

  it('makes a month pick scroll the grid instead of anchoring the list', async () => {
    const screen = renderTimeline();
    await switchToCalendar(screen);
    const anchorBefore = lastAnchorDate();

    fireEvent.press(screen.getByTestId('timeline-month-trigger'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('month-picker-option-2025-03-01'));
    });

    expect(mockScrollToMonth).toHaveBeenCalledWith('2025-03', false);
    expect(lastAnchorDate()).toBe(anchorBefore);
    expect(screen.getByTestId('calendar-grid')).toBeTruthy();
  });
});
