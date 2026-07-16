import { render, waitFor } from '@testing-library/react-native';

import TimelineScreen from '../../app/(app)/(tabs)/timeline';
import { useFamily } from '@/hooks/use-family';
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
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false, isError: false,
    isTargetReported: () => false, isUserBlocked: () => false,
    revealTarget: jest.fn(), revealBlockedUser: jest.fn(), refetch: jest.fn(),
  }),
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

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseOnboardingStatus = useOnboardingStatus as jest.MockedFunction<typeof useOnboardingStatus>;
const mockedUseMemories = useMemories as jest.MockedFunction<typeof useMemories>;

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

describe('TimelineScreen', () => {
  let mockedRefetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRefetch = jest.fn();

    mockedUseFamily.mockReturnValue({ role: 'owner' } as ReturnType<typeof useFamily>);
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
});
