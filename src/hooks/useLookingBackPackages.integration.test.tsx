import { act, cleanupAsync, renderHook, waitFor } from '@testing-library/react-native';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useFamily } from '@/hooks/use-family';
import { useLookingBackPackages } from '@/hooks/useLookingBackPackages';
import { useFamilyPortraitVersions } from '@/hooks/usePortraitVersions';
import { lookingBackQueryKey } from '@/hooks/queryKeys';
import {
  enqueuePendingLookingBackView,
  fetchLookingBackPackages,
  flushPendingLookingBackViews,
  getPendingLookingBackViews,
  mergeLookingBackPendingViews,
  markLookingBackPackageViewed,
} from '@/services/looking-back';
import { fetchMemoriesByIds } from '@/services/memories';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useContentSafety', () => ({ useContentSafety: jest.fn() }));
jest.mock('@/hooks/usePortraitVersions', () => ({ useFamilyPortraitVersions: jest.fn() }));
jest.mock('@/services/memories', () => ({ fetchMemoriesByIds: jest.fn() }));
jest.mock('@/services/looking-back', () => ({
  fetchLookingBackPackages: jest.fn(),
  getPendingLookingBackViews: jest.fn(),
  enqueuePendingLookingBackView: jest.fn(),
  flushPendingLookingBackViews: jest.fn(),
  markLookingBackPackageViewed: jest.fn(),
  mergeLookingBackPendingViews: jest.fn((packages, pending) => packages.map((item: any) => {
    const local = pending.find((entry: any) => entry.packageId === item.id);
    return local ? { ...item, view: { ...item.view, firstViewedAt: local.firstViewedAt, lastViewedAt: local.lastViewedAt, completedAt: local.completedAt } } : item;
  })),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseContentSafety = useContentSafety as jest.MockedFunction<typeof useContentSafety>;
const mockedUseFamilyPortraitVersions = useFamilyPortraitVersions as jest.MockedFunction<typeof useFamilyPortraitVersions>;
const mockedFetchPackages = fetchLookingBackPackages as jest.MockedFunction<typeof fetchLookingBackPackages>;
const mockedFetchMemories = fetchMemoriesByIds as jest.MockedFunction<typeof fetchMemoriesByIds>;
const mockedGetPending = getPendingLookingBackViews as jest.MockedFunction<typeof getPendingLookingBackViews>;
const mockedEnqueuePending = enqueuePendingLookingBackView as jest.MockedFunction<typeof enqueuePendingLookingBackView>;
const mockedFlushPending = flushPendingLookingBackViews as jest.MockedFunction<typeof flushPendingLookingBackViews>;
const mockedMarkViewed = markLookingBackPackageViewed as jest.MockedFunction<typeof markLookingBackPackageViewed>;

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const testQueryClients = new Set<QueryClient>();

function createTestQueryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  testQueryClients.add(client);
  return client;
}

const memories = Array.from({ length: 4 }, (_, index) => ({
  id: `memory-${index + 1}`,
  user_id: index === 3 ? 'blocked-user' : 'author-1',
  memory_type: index === 1 ? 'text_illustration' : 'text_only',
  illustration_generation_id: index === 1 ? 'generation-2' : null,
  taggedMembers: [], mediaAssets: [], likeCount: 0, commentCount: 0, likedByMe: false,
}) as never);

function packageResponse(
  refreshAfter = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
) {
  return {
    data: {
      dailySetId: 'set-1', packageDate: '2026-08-08', refreshAfter,
      packages: [{
        id: 'package-1', dailySetId: 'set-1', familyId: 'family-1', packageDate: '2026-08-08',
        packageType: 'on_this_day', subjectFamilyMemberId: null, displayKind: 'On this day',
        title: 'A day', subtitle: null, era: 'One year ago', tint: null, position: 0,
        memoryIds: ['memory-1', 'memory-2', 'memory-3', 'memory-4'],
        view: { firstViewedAt: null, lastViewedAt: null, completedAt: null },
        refreshAfter,
      }],
    }, error: null, failure: null,
  } as never;
}

describe('useLookingBackPackages integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1' } as never);
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false,
      isUserBlocked: (userId: string) => userId === 'blocked-user',
      isTargetReported: (type: string, id: string) => type === 'memory_illustration' && id === 'memory-2',
    } as never);
    mockedUseFamilyPortraitVersions.mockReturnValue({ data: [] } as never);
    mockedFetchPackages.mockResolvedValue(packageResponse());
    mockedFetchMemories.mockResolvedValue({ data: memories, error: null });
    mockedGetPending.mockResolvedValue([]);
    mockedFlushPending.mockResolvedValue({ acknowledgedPackageIds: [], remainingPackageIds: [] });
    mockedMarkViewed.mockResolvedValue({
      data: { firstViewedAt: '2026-08-08T10:00:00.000Z', lastViewedAt: '2026-08-08T10:00:00.000Z', completedAt: null },
      error: null, failure: null,
    });
    onlineManager.setOnline(true);
    mockedEnqueuePending.mockResolvedValue({
      packageId: 'package-1', firstViewedAt: '2026-08-08T10:00:00.000Z',
      lastViewedAt: '2026-08-08T10:00:00.000Z', completedAt: null,
    });
  });

  afterEach(async () => {
    await cleanupAsync();
    for (const client of testQueryClients) client.clear();
    testQueryClients.clear();
    onlineManager.setOnline(true);
  });


  it('uses an account-plus-family key, preserves RPC order, and hides a package after block filtering drops it below four', async () => {
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });

    await waitFor(() => expect(mockedFetchMemories).toHaveBeenCalledWith('family-1', [
      'memory-1', 'memory-2', 'memory-3', 'memory-4',
    ]));
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    expect(client.getQueryData(lookingBackQueryKey('user-1', 'family-1'))).toBeDefined();
    expect(hook.result.current.viewerPackages[0].memories.map((memory) => memory.id)).toEqual([
      'memory-1', 'memory-2', 'memory-3',
    ]);
    // The blocked author removes one of four memories, so no Timeline card
    // is rendered, while the safe viewer collection still has the remaining
    // chapter data for an already-open package. The AI-illustration report
    // would only hide the image, not the underlying memory.
    expect(hook.result.current.packages).toEqual([]);
    expect(hook.result.current.viewerPackages[0].memories).toHaveLength(3);
    hook.unmount();
  });

  it('marks viewed only after writing the durable outbox, then optimistically merges it into cache', async () => {
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false, isUserBlocked: () => false, isTargetReported: () => false,
    } as never);
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });
    await waitFor(() => expect(hook.result.current.packages).toHaveLength(1));

    await act(async () => {
      await hook.result.current.markPackageViewed('package-1');
    });

    expect(mockedEnqueuePending).toHaveBeenCalledWith('user-1', 'family-1', 'package-1');
    expect(mergeLookingBackPendingViews).toHaveBeenCalled();
    expect(mockedFlushPending).toHaveBeenCalledWith('user-1', 'family-1');
    hook.unmount();
  });

  it('keeps a reported illustration memory in its package but marks its visual for fallback', async () => {
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false, isUserBlocked: () => false,
      isTargetReported: (type: string, id: string) => type === 'memory_illustration' && id === 'memory-2',
    } as never);
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });

    await waitFor(() => expect(hook.result.current.packages).toHaveLength(1));
    expect(hook.result.current.packages[0].memories).toHaveLength(4);
    expect(hook.result.current.packages[0].memories.find((memory) => memory.id === 'memory-2')?.isIllustrationHidden)
      .toBe(true);
    hook.unmount();
  });

  function setMemberAtAgeFixture(reportTarget: 'family_member_profile' | 'family_member_portrait') {
    const memoryWithTaggedMember = {
      ...memories[0],
      memory_date: '2022-06-01',
      taggedMembers: [{
        id: 'member-1', name: 'Nora', family_id: 'family-1', user_id: 'user-1', date_of_birth: '2020-01-01',
        illustrated_profile_key: 'current.webp', illustrated_profile_status: 'ready', profile_picture_key: null,
        updated_at: '2026-01-01', created_at: '2020-01-01', gender: null,
      }],
    };
    mockedFetchMemories.mockResolvedValue({ data: [memoryWithTaggedMember, ...memories.slice(1)], error: null } as never);
    mockedFetchPackages.mockResolvedValue({
      ...packageResponse(),
      data: {
        ...packageResponse().data,
        packages: [{ ...packageResponse().data.packages[0], packageType: 'member_at_age', subjectFamilyMemberId: 'member-1', title: 'Nora at two' }],
      },
    } as never);
    mockedUseFamilyPortraitVersions.mockReturnValue({ data: [{
      id: 'portrait-2022', family_id: 'family-1', family_member_id: 'member-1', user_id: 'user-1',
      reference_date: '2022-01-01', date_source: 'manual', profile_picture_key: 'then.jpg',
      illustrated_profile_key: 'then.webp', illustrated_profile_status: 'ready', generation_token: null,
      generation_started_at: null, generation_output_key: null, deletion_token: null, deletion_started_at: null,
      created_at: '2022-01-01', updated_at: '2022-01-01',
    }] } as never);
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false, isUserBlocked: () => false,
      isTargetReported: (type: string, id: string | null | undefined) => (
        (type === reportTarget && id === (reportTarget === 'family_member_profile' ? 'member-1' : 'portrait-2022'))
      ),
    } as never);
  }

  it('uses the memory-date portrait version and removes a profile-reported subject name from package data', async () => {
    setMemberAtAgeFixture('family_member_profile');
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });

    await waitFor(() => expect(hook.result.current.packages).toHaveLength(1));
    const packageItem = hook.result.current.packages[0];
    expect(packageItem.title).toBe('A family memory');
    const tagged = packageItem.memories[0].taggedMembers[0];
    expect(tagged.resolvedPortraitVersion?.id).toBe('portrait-2022');
    expect(tagged.isLookingBackHidden).toBe(true);
    hook.unmount();
  });

  it('genericizes a member-at-age title when only the resolved historical portrait is reported', async () => {
    setMemberAtAgeFixture('family_member_portrait');
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });

    await waitFor(() => expect(hook.result.current.packages).toHaveLength(1));
    expect(hook.result.current.packages[0].title).toBe('A family memory');
    expect(hook.result.current.packages[0].memories[0].taggedMembers[0].isLookingBackHidden).toBe(true);
    hook.unmount();
  });

  it('silently resolves an unavailable package endpoint to an empty optional rail', async () => {
    mockedFetchPackages.mockResolvedValue({
      data: null, error: { message: 'network', code: 'PGRST000' }, failure: 'unavailable',
    });
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.packages).toEqual([]);
    expect(hook.result.current.isError).toBe(false);
    hook.unmount();
  });

  it('reconciles the current immutable daily set after an offline-to-online edge', async () => {
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false, isUserBlocked: () => false, isTargetReported: () => false,
    } as never);
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });
    await waitFor(() => expect(mockedFetchPackages).toHaveBeenCalledTimes(1));

    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });

    await waitFor(() => expect(mockedFetchPackages).toHaveBeenCalledTimes(2));
    hook.unmount();
  });

  it('refetches when the server refresh_after boundary expires', async () => {
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false, isUserBlocked: () => false, isTargetReported: () => false,
    } as never);
    mockedFetchPackages
      .mockResolvedValueOnce(packageResponse(new Date(Date.now() - 1000).toISOString()))
      .mockResolvedValue(packageResponse(new Date(Date.now() + 60 * 60 * 1000).toISOString()));
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });

    await waitFor(() => expect(mockedFetchPackages).toHaveBeenCalledTimes(2));
    expect(hook.result.current.refreshAfter).not.toBeNull();
    hook.unmount();
  });

  it('renders the account-family cached set while offline without attempting a package RPC', async () => {
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false, isUserBlocked: () => false, isTargetReported: () => false,
    } as never);
    const client = createTestQueryClient();
    const packageSet = packageResponse().data;
    const [{ memoryIds: _memoryIds, ...packageMetadata }] = packageSet.packages;
    client.setQueryData(lookingBackQueryKey('user-1', 'family-1'), {
      dailySetId: packageSet.dailySetId,
      packageDate: packageSet.packageDate,
      refreshAfter: packageSet.refreshAfter,
      packages: [{
        ...packageMetadata,
        memories: memories.map((memory) => ({ ...memory, isIllustrationHidden: false })),
      }],
    });
    onlineManager.setOnline(false);

    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });
    await waitFor(() => expect(hook.result.current.packages).toHaveLength(1));

    expect(hook.result.current.fetchStatus).toBe('paused');
    expect(mockedFetchPackages).not.toHaveBeenCalled();
    expect(hook.result.current.viewerPackages[0].memories).toHaveLength(4);
    hook.unmount();
    onlineManager.setOnline(true);
  });

  it('merges a pending offline completion before showing a stale server package view', async () => {
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false, isUserBlocked: () => false, isTargetReported: () => false,
    } as never);
    mockedGetPending.mockResolvedValue([{
      packageId: 'package-1',
      firstViewedAt: '2026-08-08T10:00:00.000Z',
      lastViewedAt: '2026-08-08T10:05:00.000Z',
      completedAt: '2026-08-08T10:05:00.000Z',
    }]);
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });

    await waitFor(() => expect(hook.result.current.packages).toHaveLength(1));
    expect(hook.result.current.packages[0].view).toEqual({
      firstViewedAt: '2026-08-08T10:00:00.000Z',
      lastViewedAt: '2026-08-08T10:05:00.000Z',
      completedAt: '2026-08-08T10:05:00.000Z',
    });
    expect(mockedFlushPending).toHaveBeenCalledWith('user-1', 'family-1');
    hook.unmount();
  });

  it('still performs an in-memory optimistic view and direct RPC attempt if the durable store rejects', async () => {
    mockedUseContentSafety.mockReturnValue({
      isLoading: false, isError: false, isUserBlocked: () => false, isTargetReported: () => false,
    } as never);
    mockedEnqueuePending.mockRejectedValue(new Error('storage full'));
    const client = createTestQueryClient();
    const hook = renderHook(() => useLookingBackPackages(), { wrapper: createWrapper(client) });
    await waitFor(() => expect(hook.result.current.packages).toHaveLength(1));

    await act(async () => {
      await hook.result.current.markPackageViewed('package-1');
    });

    expect(mockedMarkViewed).toHaveBeenCalledWith('package-1');
    expect(mergeLookingBackPendingViews).toHaveBeenCalled();
    hook.unmount();
  });
});
