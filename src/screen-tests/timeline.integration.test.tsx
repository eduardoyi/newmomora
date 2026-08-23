import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import TimelineScreen from '../../app/(app)/(tabs)/timeline';
import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyActivityUnread } from '@/hooks/useFamilyActivity';
import { useFamilyMembers, useOnboardingStatus } from '@/hooks/useFamilyMembers';
import { useGalleryImportEntryStatus } from '@/hooks/useGalleryImport';
import { useMemories } from '@/hooks/useMemories';

// Workstream A4: the old useFocusEffect(refetch) is gone -- freshness comes
// from staleTime + cache patches + pull-to-refresh + the app-foreground
// reconcile inside useMemories itself. This screen test asserts the pull-to-
// refresh handler is wired to the hook's refetch and that nothing calls it
// merely from mounting/re-rendering the screen.

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));
// The header glyph/drawer are gone (owner decision: the activity bell is the
// one re-entry point) -- this flag defaults on here so the empty-state and
// one-memory invite-card tests below can exercise TimelineGalleryImportInvite
// for real, without needing to also mock its AsyncStorage-backed dismissal
// check (jest-expo's AsyncStorage mock defaults every key to unset, i.e.
// "not dismissed", which is exactly the state these tests want).
jest.mock('@/utils/gallery-import-flags', () => ({ isGalleryImportFeatureEnabled: true }));

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
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
// The continuous gallery-import sweep (docs/plans/gallery-import-continuous.md
// I4a): this device-bound status hook reaches AsyncStorage + a live
// TanStack Query -- mocked out here the same way useFamilyActivityUnread is,
// so this screen test never needs a QueryClientProvider or an AsyncStorage
// round trip just to render the Timeline. Its own behavior (state
// derivation, driver wiring) is covered by useGalleryImport.integration.test.tsx.
jest.mock('@/hooks/useGalleryImport', () => ({ useGalleryImportEntryStatus: jest.fn() }));
jest.mock('@/utils/gallery-import-bell-seen', () => ({
  hasSeenGalleryImportBell: jest.fn(async () => true),
  markGalleryImportBellSeen: jest.fn(async () => undefined),
}));

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
// (useMediaUrls -> @/lib/supabase). A jest.fn() component (rather than a
// bare () => null) so this file can still assert on the `galleryImport`
// prop TimelineScreen computes and hands it -- the row's own rendering is
// covered by family-activity-sheet.test.tsx.
jest.mock('@/components/family-activity-sheet', () => ({
  FamilyActivitySheet: jest.fn(() => null),
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseOnboardingStatus = useOnboardingStatus as jest.MockedFunction<typeof useOnboardingStatus>;
const mockedUseMemories = useMemories as jest.MockedFunction<typeof useMemories>;
const mockedUseFamilyActivityUnread = useFamilyActivityUnread as jest.MockedFunction<typeof useFamilyActivityUnread>;
const mockedUseGalleryImportEntryStatus = useGalleryImportEntryStatus as jest.MockedFunction<typeof useGalleryImportEntryStatus>;

function galleryEntryStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'none',
    attentionReason: null,
    reviewDaysLeft: null,
    readyCount: 0,
    checkpoint: null,
    run: null,
    isLoading: false,
    refetch: jest.fn(),
    driverState: { phase: 'idle', runId: null, pausedUntil: null, lastError: null, isActive: false },
    comingIndicator: { kind: 'none' },
    ...overrides,
  } as unknown as ReturnType<typeof useGalleryImportEntryStatus>;
}

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
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as unknown as ReturnType<typeof useAuth>);
    mockedUseGalleryImportEntryStatus.mockReturnValue(galleryEntryStatus());
    // jest.clearAllMocks() (below... actually above, called first) clears
    // call history but NOT a previously-set mockResolvedValue -- reset the
    // default explicitly every test so one test's override never leaks into
    // the next.
    jest.requireMock('@/utils/gallery-import-bell-seen').hasSeenGalleryImportBell.mockResolvedValue(true);
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

  // docs/plans/gallery-import-continuous.md I4a step 1/2/3: the header
  // glyph/drawer are gone, the invite card renders at <=1 memory, and the
  // activity bell/sheet are the sweep's one re-entry point.
  describe('gallery import (activity bell/sheet re-entry, no glyph)', () => {
    function familyActivitySheetMock() {
      return jest.requireMock('@/components/family-activity-sheet').FamilyActivitySheet as jest.Mock;
    }
    function routerMock() {
      return jest.requireMock('expo-router').router as { push: jest.Mock };
    }

    it('never renders the old header glyph or its drawer', () => {
      const { queryByTestId } = render(<TimelineScreen />);
      expect(queryByTestId('timeline-gallery-import-glyph')).toBeNull();
      expect(queryByTestId('import-drawer-sheet')).toBeNull();
    });

    it('shows the photo invite card in the empty state', async () => {
      mockedUseFamily.mockReturnValue({ role: 'owner', familyId: 'family-1' } as ReturnType<typeof useFamily>);
      mockedUseMemories.mockReturnValue({
        memories: [], isLoading: false, isRefetching: false, isError: false, error: null,
        refetch: mockedRefetch, fetchNextPage: jest.fn(), hasNextPage: false, isFetchingNextPage: false,
      } as unknown as ReturnType<typeof useMemories>);

      const { getByTestId } = render(<TimelineScreen />);
      // The invite defaults to hidden until its own AsyncStorage dismissal
      // check resolves (flash-avoidance) -- see TimelineGalleryImportInvite.
      await waitFor(() => expect(getByTestId('timeline-gallery-import')).toBeTruthy());
    });

    it('shows the photo invite card as the first list item when there is exactly one memory', async () => {
      mockedUseFamily.mockReturnValue({ role: 'owner', familyId: 'family-1' } as ReturnType<typeof useFamily>);
      // Default mockedUseMemories already returns exactly one memory.
      const { getByTestId } = render(<TimelineScreen />);
      await waitFor(() => expect(getByTestId('timeline-gallery-import')).toBeTruthy());
    });

    it('does not show the photo invite card once there are two or more memories', async () => {
      mockedUseFamily.mockReturnValue({ role: 'owner', familyId: 'family-1' } as ReturnType<typeof useFamily>);
      mockedUseMemories.mockReturnValue({
        memories: [memory, { ...memory, id: 'memory-2' }],
        isLoading: false, isRefetching: false, isError: false, error: null,
        refetch: mockedRefetch, fetchNextPage: jest.fn(), hasNextPage: false, isFetchingNextPage: false,
      } as unknown as ReturnType<typeof useMemories>);

      const { queryByTestId } = render(<TimelineScreen />);
      // Give the (never-relevant here) dismissal check a tick, then confirm
      // the card never appears regardless of how that check resolves.
      await waitFor(() => expect(mockedUseMemories).toHaveBeenCalled());
      expect(queryByTestId('timeline-gallery-import')).toBeNull();
    });

    it('lights the bell dot once suggestions are ready and unseen', async () => {
      const { hasSeenGalleryImportBell } = jest.requireMock('@/utils/gallery-import-bell-seen');
      (hasSeenGalleryImportBell as jest.Mock).mockResolvedValue(false);
      mockedUseFamily.mockReturnValue({ role: 'owner', familyId: 'family-1' } as ReturnType<typeof useFamily>);
      mockedUseGalleryImportEntryStatus.mockReturnValue(galleryEntryStatus({
        state: 'ready', readyCount: 5, checkpoint: { runId: 'run-1' }, run: { status: 'reviewing' },
      }));

      const { getByTestId } = render(<TimelineScreen />);
      await waitFor(() => expect(getByTestId('timeline-activity-bell-dot')).toBeTruthy());
      expect(hasSeenGalleryImportBell).toHaveBeenCalledWith('user-1', 'family-1', 'run-1', 5);
    });

    it('does not light the bell dot once the ready batch has already been seen', async () => {
      mockedUseFamily.mockReturnValue({ role: 'owner', familyId: 'family-1' } as ReturnType<typeof useFamily>);
      mockedUseGalleryImportEntryStatus.mockReturnValue(galleryEntryStatus({
        state: 'ready', readyCount: 5, checkpoint: { runId: 'run-1' }, run: { status: 'reviewing' },
      }));

      const { queryByTestId, getByTestId } = render(<TimelineScreen />);
      await waitFor(() => expect(mockedUseGalleryImportEntryStatus).toHaveBeenCalled());
      // hasSeenGalleryImportBell defaults to resolving true (module mock
      // above), the "already seen" case -- the dot stays off, and the bell
      // itself still renders (family activity's own unread flag is false too).
      expect(getByTestId('timeline-activity-bell')).toBeTruthy();
      expect(queryByTestId('timeline-activity-bell-dot')).toBeNull();
    });

    it('marks the batch seen and clears the bell dot when the activity sheet opens', async () => {
      const { hasSeenGalleryImportBell, markGalleryImportBellSeen } = jest.requireMock('@/utils/gallery-import-bell-seen');
      (hasSeenGalleryImportBell as jest.Mock).mockResolvedValue(false);
      mockedUseFamily.mockReturnValue({ role: 'owner', familyId: 'family-1' } as ReturnType<typeof useFamily>);
      mockedUseGalleryImportEntryStatus.mockReturnValue(galleryEntryStatus({
        state: 'ready', readyCount: 5, checkpoint: { runId: 'run-1' }, run: { status: 'reviewing' },
      }));

      const { getByTestId } = render(<TimelineScreen />);
      await waitFor(() => expect(getByTestId('timeline-activity-bell-dot')).toBeTruthy());

      fireEvent.press(getByTestId('timeline-activity-bell'));

      expect(markGalleryImportBellSeen).toHaveBeenCalledWith('user-1', 'family-1', 'run-1', 5);
    });

    it('omits the galleryImport prop (hiding the sheet\'s pinned row) when there is no checkpoint', () => {
      render(<TimelineScreen />);
      const lastCall = familyActivitySheetMock().mock.calls.at(-1)![0];
      expect(lastCall.galleryImport).toBeUndefined();
    });

    it('omits the galleryImport prop once the run reaches a terminal status', () => {
      mockedUseGalleryImportEntryStatus.mockReturnValue(galleryEntryStatus({
        checkpoint: { runId: 'run-1' }, run: { status: 'completed' },
      }));
      render(<TimelineScreen />);
      const lastCall = familyActivitySheetMock().mock.calls.at(-1)![0];
      expect(lastCall.galleryImport).toBeUndefined();
    });

    it('passes readyCount/comingIndicator/phase and an onOpen that routes to the review deck when ready', () => {
      mockedUseGalleryImportEntryStatus.mockReturnValue(galleryEntryStatus({
        readyCount: 7,
        checkpoint: { runId: 'run-1' },
        run: { status: 'reviewing' },
        comingIndicator: { kind: 'count', count: 2 },
        driverState: { phase: 'uploading', runId: 'run-1', pausedUntil: null, lastError: null, isActive: true },
      }));
      render(<TimelineScreen />);

      const lastCall = familyActivitySheetMock().mock.calls.at(-1)![0];
      expect(lastCall.galleryImport).toMatchObject({
        readyCount: 7,
        comingIndicator: { kind: 'count', count: 2 },
        phase: 'uploading',
      });

      lastCall.galleryImport.onOpen();
      expect(routerMock().push).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/review', params: { runId: 'run-1' } });
    });

    it('routes onOpen to the progress screen when nothing is ready yet', () => {
      mockedUseGalleryImportEntryStatus.mockReturnValue(galleryEntryStatus({
        readyCount: 0,
        checkpoint: { runId: 'run-1' },
        run: { status: 'processing' },
      }));
      render(<TimelineScreen />);

      const lastCall = familyActivitySheetMock().mock.calls.at(-1)![0];
      lastCall.galleryImport.onOpen();
      expect(routerMock().push).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/progress', params: { runId: 'run-1' } });
    });
  });
});
