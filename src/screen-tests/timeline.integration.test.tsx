import { render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import TimelineScreen from '../../app/(app)/(tabs)/timeline';
import { colors } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyActivityUnread } from '@/hooks/useFamilyActivity';
import { useFamilyMembers, useOnboardingStatus } from '@/hooks/useFamilyMembers';
import { useMemories } from '@/hooks/useMemories';

// Workstream A4: the old useFocusEffect(refetch) is gone -- freshness comes
// from staleTime + cache patches + pull-to-refresh + the app-foreground
// reconcile inside useMemories itself. This screen test asserts the pull-to-
// refresh handler is wired to the hook's refetch and that nothing calls it
// merely from mounting/re-rendering the screen.

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: jest.fn(),
  useOnboardingStatus: jest.fn(),
}));
jest.mock('@/hooks/useMemories', () => ({ useMemories: jest.fn() }));
jest.mock('@/hooks/useLookingBackPackages', () => ({
  useLookingBackPackages: () => ({
    packages: [],
    isLoading: false,
    isRefetching: false,
    refetch: jest.fn(async () => undefined),
  }),
}));
jest.mock('@/hooks/useLookingBackSession', () => ({
  useLookingBackSession: () => ({ savePackageSnapshot: jest.fn() }),
}));
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false, isError: false,
    isTargetReported: () => false, isUserBlocked: () => false,
    revealTarget: jest.fn(), revealBlockedUser: jest.fn(), refetch: jest.fn(),
  }),
}));
// The bell's unread dot -- mocked (rather than exercised for real) because
// its own service (src/services/family-activity.ts) imports the real
// @/lib/supabase client, which this screen test doesn't otherwise need to
// mock. Bell/dot behavior itself is covered by
// timeline-activity-bell.test.tsx.
jest.mock('@/hooks/useFamilyActivity', () => ({ useFamilyActivityUnread: jest.fn() }));

jest.mock('@/components/memory-card', () => ({
  MemoryCard: () => null,
}));
jest.mock('@/components/memory-fab', () => ({
  MemoryFab: () => null,
}));
jest.mock('@/components/pending-memory-uploads-banner', () => ({
  PendingMemoryUploadsBanner: () => null,
}));
jest.mock('@/components/looking-back/package-rail', () => ({
  LookingBackPackageRail: () => null,
}));
// Exercised in its own test suite (family-activity-sheet.test.tsx); mocked
// out here (like the other child components above) so this screen test's
// mocks don't have to reach into its transitive dependencies
// (FamilyMemberAvatar -> useMediaUrls -> @/lib/supabase).
jest.mock('@/components/family-activity-sheet', () => ({
  FamilyActivitySheet: () => null,
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseOnboardingStatus = useOnboardingStatus as jest.MockedFunction<typeof useOnboardingStatus>;
const mockedUseMemories = useMemories as jest.MockedFunction<typeof useMemories>;
const mockedUseFamilyActivityUnread = useFamilyActivityUnread as jest.MockedFunction<typeof useFamilyActivityUnread>;

const memory = {
  id: 'memory-1',
  content: 'A quiet afternoon',
  memory_date: '2026-07-14',
  memory_type: 'text_only',
  emotion: 'joy',
  taggedMembers: [],
  mediaAssets: [],
  likeCount: 0,
  commentCount: 0,
  likedByMe: false,
};

function toLocalDateString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

describe('TimelineScreen', () => {
  let mockedRefetch: jest.Mock;
  let mockedRefetchActivityUnread: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRefetch = jest.fn();
    mockedRefetchActivityUnread = jest.fn();

    mockedUseFamily.mockReturnValue({ role: 'owner' } as ReturnType<typeof useFamily>);
    mockedUseFamilyActivityUnread.mockReturnValue({
      unread: false,
      isLoading: false,
      refetch: mockedRefetchActivityUnread,
    } as unknown as ReturnType<typeof useFamilyActivityUnread>);
    mockedUseFamilyMembers.mockReturnValue({
      members: [{ id: 'member-1' }],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockedUseOnboardingStatus.mockReturnValue({ isLoading: false, needsFamilyMember: false });
    mockedUseMemories.mockReturnValue({
      memories: [memory],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch: mockedRefetch,
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    } as unknown as ReturnType<typeof useMemories>);
  });

  it('does not call refetch merely from mounting the screen', async () => {
    render(<TimelineScreen />);

    // Give any effects a tick to fire before asserting their absence.
    await waitFor(() => expect(mockedUseMemories).toHaveBeenCalled());
    expect(mockedRefetch).not.toHaveBeenCalled();
  });

  it('wires pull-to-refresh to the hook refetch (trim-to-page-1 + refetch)', () => {
    const { getByTestId } = render(<TimelineScreen />);

    const list = getByTestId('timeline-memory-list');
    const onRefresh = list.props.refreshControl.props.onRefresh as () => void;
    onRefresh();

    expect(mockedRefetch).toHaveBeenCalledTimes(1);
  });

  it('also refreshes the family activity unread dot on pull-to-refresh', () => {
    const { getByTestId } = render(<TimelineScreen />);

    const list = getByTestId('timeline-memory-list');
    const onRefresh = list.props.refreshControl.props.onRefresh as () => void;
    onRefresh();

    expect(mockedRefetchActivityUnread).toHaveBeenCalledTimes(1);
  });

  // Workstream B2: infinite scroll wiring -- reaching the end of the loaded
  // list pages in the next batch via the hook's fetchNextPage, not a manual
  // "load more" control.
  it('calls fetchNextPage when the list reaches the end', () => {
    const fetchNextPage = jest.fn();
    mockedUseMemories.mockReturnValue({
      memories: [memory],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch: mockedRefetch,
      fetchNextPage,
      hasNextPage: true,
      isFetchingNextPage: false,
    } as unknown as ReturnType<typeof useMemories>);

    const { getByTestId } = render(<TimelineScreen />);
    const list = getByTestId('timeline-memory-list');

    expect(list.props.onEndReachedThreshold).toBe(0.5);

    list.props.onEndReached();

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  // The app-foreground reconcile inside useMemories trims the cached
  // timeline to page 1, which clamps this FlatList's scroll to the bottom
  // of the shortened list if it fires while the user is scrolled deep --
  // the screen guards that by tracking scroll offset and only telling
  // useMemories it's safe to reconcile within one viewport height of the
  // top. useMemories is mocked in this file, so this asserts the getter the
  // screen wires up reports the right answer for each scroll position
  // rather than asserting the (already hook-tested) trim/refetch itself --
  // see the shouldReconcileOnForeground coverage in
  // useMemories.integration.test.tsx for that.
  it('reports near-top only within one viewport height of the top after scrolling', () => {
    const { getByTestId } = render(<TimelineScreen />);
    const list = getByTestId('timeline-memory-list');

    expect(mockedUseMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({ shouldReconcileOnForeground: expect.any(Function) }),
    );
    const shouldReconcileOnForeground = mockedUseMemories.mock.calls.at(-1)?.[0]
      ?.shouldReconcileOnForeground as () => boolean;

    // FlatList's own scroll handling (onEndReached distance, etc.) reads
    // contentSize/layoutMeasurement off the same event, so a realistic
    // scroll event needs all three, not just contentOffset.
    const scrollEvent = (y: number) => ({
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { width: 400, height: 10000 },
        layoutMeasurement: { width: 400, height: 800 },
      },
    });

    // Starts at the top.
    expect(shouldReconcileOnForeground()).toBe(true);

    list.props.onScroll(scrollEvent(5000));
    expect(shouldReconcileOnForeground()).toBe(false);

    list.props.onScroll(scrollEvent(0));
    expect(shouldReconcileOnForeground()).toBe(true);
  });

  it('shows a footer spinner while fetching the next page', () => {
    mockedUseMemories.mockReturnValue({
      memories: [memory],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch: mockedRefetch,
      fetchNextPage: jest.fn(),
      hasNextPage: true,
      isFetchingNextPage: true,
    } as unknown as ReturnType<typeof useMemories>);

    const { getByTestId } = render(<TimelineScreen />);
    const list = getByTestId('timeline-memory-list');

    expect(list.props.ListFooterComponent).toBeTruthy();
  });

  it('fills the current day when it has a memory', () => {
    const today = new Date();
    const dayIndex = today.getDay() === 0 ? 6 : today.getDay() - 1;
    mockedUseMemories.mockReturnValue({
      memories: [{ ...memory, memory_date: toLocalDateString(today) }],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch: mockedRefetch,
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    } as unknown as ReturnType<typeof useMemories>);

    const { getByTestId } = render(<TimelineScreen />);
    const dotStyle = StyleSheet.flatten(getByTestId(`timeline-streak-dot-${dayIndex}`).props.style);

    expect(dotStyle.backgroundColor).toBe(colors.primary);
    expect(dotStyle.borderWidth).toBeUndefined();
  });

  it('renders the current day as an outlined streak dot when it has no memory', () => {
    const today = new Date();
    const dayIndex = today.getDay() === 0 ? 6 : today.getDay() - 1;
    mockedUseMemories.mockReturnValue({
      memories: [{ ...memory, memory_date: '2000-01-01' }],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch: mockedRefetch,
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    } as unknown as ReturnType<typeof useMemories>);

    const { getByTestId } = render(<TimelineScreen />);
    const dotStyle = StyleSheet.flatten(getByTestId(`timeline-streak-dot-${dayIndex}`).props.style);

    expect(dotStyle).toMatchObject({
      backgroundColor: colors.border,
      borderColor: colors.primary,
      borderWidth: 1.5,
    });
  });
});
