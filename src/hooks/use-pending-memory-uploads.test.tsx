import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  PendingMemoryUploadsProvider,
  usePendingMemoryUploads,
} from '@/hooks/use-pending-memory-uploads';
import { memoriesQueryKey, memoriesQueryKeyBase, calendarMemoriesQueryKeyBase } from '@/hooks/queryKeys';
import { fetchLinkPreviews } from '@/services/ai';
import { runMediaPhotoEmotionAnalysis, type MemoriesPage, type MemoryWithTags } from '@/services/memories';
import { notifyFamilyActivityFireAndForget, postMediaMemory } from '@/services/memory-posting';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/services/ai', () => ({
  fetchLinkPreviews: jest.fn(),
}));

jest.mock('@/services/memories', () => ({
  runMediaPhotoEmotionAnalysis: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/memory-posting', () => ({
  postMediaMemory: jest.fn(),
  notifyFamilyActivityFireAndForget: jest.fn(),
  hasImageMediaAsset: (assets: { contentType: string }[]) =>
    assets.some((asset) => !asset.contentType.startsWith('video/')),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedPostMediaMemory = postMediaMemory as jest.MockedFunction<typeof postMediaMemory>;
const mockedNotify = notifyFamilyActivityFireAndForget as jest.MockedFunction<
  typeof notifyFamilyActivityFireAndForget
>;
const mockedRunMediaPhotoEmotionAnalysis = runMediaPhotoEmotionAnalysis as jest.MockedFunction<
  typeof runMediaPhotoEmotionAnalysis
>;
const mockedFetchLinkPreviews = fetchLinkPreviews as jest.MockedFunction<typeof fetchLinkPreviews>;

const photoInput = {
  memoryId: 'memory-1',
  mediaAssets: [
    { mediaAssetId: 'asset-1', fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' },
  ],
  memoryDate: '2026-07-12',
  taggedMemberIds: [],
};

function createWrapperWithClient(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <PendingMemoryUploadsProvider>{children}</PendingMemoryUploadsProvider>
      </QueryClientProvider>
    );
  };
}

function createWrapper() {
  return createWrapperWithClient(
    new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
  );
}

describe('usePendingMemoryUploads', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseAuth.mockReturnValue({
      session: { user: { id: 'user-1' } } as never,
      user: { id: 'user-1' } as never,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    });

    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Test's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Test's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    mockedFetchLinkPreviews.mockResolvedValue({ data: { linkPreviews: {} }, error: null });
  });

  it('tracks a pending upload and removes it once posting succeeds', async () => {
    let resolvePost: (memory: { id: string }) => void = () => {};
    mockedPostMediaMemory.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve as typeof resolvePost;
        }) as ReturnType<typeof postMediaMemory>,
    );

    const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

    act(() => {
      result.current.enqueue(photoInput);
    });

    expect(result.current.uploads).toHaveLength(1);
    expect(result.current.uploads[0]).toMatchObject({
      memoryId: 'memory-1',
      status: 'posting',
      totalAssets: 1,
      uploadedAssets: 0,
      previewUri: 'file:///photo.jpg',
    });

    act(() => {
      resolvePost({ id: 'memory-1' });
    });

    await waitFor(() => {
      expect(result.current.uploads).toHaveLength(0);
    });
  });

  it('runs photo emotion analysis and notifies family after posting a photo memory', async () => {
    mockedPostMediaMemory.mockResolvedValue({ id: 'memory-1' } as never);

    const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

    act(() => {
      result.current.enqueue(photoInput);
    });

    await waitFor(() => {
      expect(mockedRunMediaPhotoEmotionAnalysis).toHaveBeenCalledWith('memory-1');
      expect(mockedNotify).toHaveBeenCalledWith('memory-1');
    });
  });

  it('skips photo emotion analysis for all-video memories', async () => {
    mockedPostMediaMemory.mockResolvedValue({ id: 'memory-video' } as never);

    const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

    act(() => {
      result.current.enqueue({
        ...photoInput,
        memoryId: 'memory-video',
        mediaAssets: [
          { mediaAssetId: 'asset-v', fileUri: 'file:///clip.mp4', contentType: 'video/mp4' },
        ],
      });
    });

    await waitFor(() => {
      expect(mockedNotify).toHaveBeenCalledWith('memory-video');
    });
    expect(mockedRunMediaPhotoEmotionAnalysis).not.toHaveBeenCalled();
  });

  it('marks the upload failed and supports retrying it', async () => {
    mockedPostMediaMemory
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ id: 'memory-1' } as never);

    const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

    act(() => {
      result.current.enqueue(photoInput);
    });

    await waitFor(() => {
      expect(result.current.uploads[0]).toMatchObject({
        status: 'failed',
        errorMessage: 'network down',
      });
    });

    act(() => {
      result.current.retry('memory-1');
    });

    await waitFor(() => {
      expect(result.current.uploads).toHaveLength(0);
    });
    expect(mockedPostMediaMemory).toHaveBeenCalledTimes(2);
  });

  it('retries against the enqueue-time family even after switching families', async () => {
    mockedPostMediaMemory
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ id: 'memory-1' } as never);

    const { result, rerender } = renderHook(() => usePendingMemoryUploads(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.enqueue(photoInput);
    });

    await waitFor(() => {
      expect(result.current.uploads[0]?.status).toBe('failed');
    });
    expect(result.current.uploads[0]?.familyId).toBe('family-1');

    // User switches active family before hitting Retry.
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-2', name: 'Other family' },
      familyId: 'family-2',
      role: 'owner',
      memberships: [{ id: 'm2', familyId: 'family-2', role: 'owner', name: 'Other family' }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    rerender(undefined);

    act(() => {
      result.current.retry('memory-1');
    });

    await waitFor(() => {
      expect(result.current.uploads).toHaveLength(0);
    });
    expect(mockedPostMediaMemory).toHaveBeenLastCalledWith(
      expect.objectContaining({ familyId: 'family-1', userId: 'user-1' }),
    );
  });

  it('discards a failed upload', async () => {
    mockedPostMediaMemory.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

    act(() => {
      result.current.enqueue(photoInput);
    });

    await waitFor(() => {
      expect(result.current.uploads[0]?.status).toBe('failed');
    });

    act(() => {
      result.current.discard('memory-1');
    });

    expect(result.current.uploads).toHaveLength(0);
  });

  it('reports per-asset upload progress', async () => {
    let reportAsset: () => void = () => {};
    let resolvePost: (memory: { id: string }) => void = () => {};
    mockedPostMediaMemory.mockImplementation(({ onAssetUploaded }) => {
      reportAsset = onAssetUploaded ?? reportAsset;
      return new Promise((resolve) => {
        resolvePost = resolve as typeof resolvePost;
      }) as ReturnType<typeof postMediaMemory>;
    });

    const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

    act(() => {
      result.current.enqueue({
        ...photoInput,
        mediaAssets: [
          { mediaAssetId: 'a1', fileUri: 'file:///a.jpg', contentType: 'image/jpeg' },
          { mediaAssetId: 'a2', fileUri: 'file:///b.jpg', contentType: 'image/jpeg' },
        ],
      });
    });

    act(() => {
      reportAsset();
    });

    expect(result.current.uploads[0]).toMatchObject({ uploadedAssets: 1, totalAssets: 2 });

    act(() => {
      reportAsset();
      resolvePost({ id: 'memory-1' });
    });

    await waitFor(() => {
      expect(result.current.uploads).toHaveLength(0);
    });
  });

  describe('fetch-link-previews fire-and-forget (plan §7)', () => {
    it('triggers fetchLinkPreviews when the media caption contains a URL', async () => {
      mockedPostMediaMemory.mockResolvedValue({ id: 'memory-1' } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue({ ...photoInput, content: 'Look at https://example.com' });
      });

      await waitFor(() => {
        expect(mockedFetchLinkPreviews).toHaveBeenCalledWith('memory-1');
      });
    });

    it('does not trigger fetchLinkPreviews when the caption has no URL', async () => {
      mockedPostMediaMemory.mockResolvedValue({ id: 'memory-1' } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue({ ...photoInput, content: 'No links in this caption' });
      });

      await waitFor(() => {
        expect(mockedNotify).toHaveBeenCalledWith('memory-1');
      });
      expect(mockedFetchLinkPreviews).not.toHaveBeenCalled();
    });

    it('does not trigger fetchLinkPreviews when there is no caption at all', async () => {
      mockedPostMediaMemory.mockResolvedValue({ id: 'memory-1' } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(photoInput);
      });

      await waitFor(() => {
        expect(mockedNotify).toHaveBeenCalledWith('memory-1');
      });
      expect(mockedFetchLinkPreviews).not.toHaveBeenCalled();
    });

    it('still completes the upload (removes the pending card) when fetchLinkPreviews rejects', async () => {
      mockedPostMediaMemory.mockResolvedValue({ id: 'memory-1' } as never);
      mockedFetchLinkPreviews.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue({ ...photoInput, content: 'Look at https://example.com' });
      });

      await waitFor(() => {
        expect(result.current.uploads).toHaveLength(0);
      });
    });
  });

  // Workstream A4b: postMediaMemory's row is prepended into the cache
  // directly instead of relying on a refetch to surface it, and the
  // memoriesQueryKeyBase invalidations become refetchType: 'none' backstops
  // (calendar keeps the default refetching invalidation).
  describe('cache wiring (Workstream A4b)', () => {
    function buildInfiniteMemoriesData(memories: MemoryWithTags[]): InfiniteData<MemoriesPage> {
      return { pages: [{ memories, nextCursor: null }], pageParams: [null] };
    }

    it('prepends the posted memory into the timeline cache without waiting on a refetch', async () => {
      const existing = {
        id: 'existing-1',
        memory_type: 'text_only',
        memory_date: '2026-07-10',
        created_at: '2026-07-10T00:00:00Z',
        taggedMembers: [],
        mediaAssets: [],
      } as unknown as MemoryWithTags;
      const posted = {
        id: 'memory-1',
        memory_type: 'media',
        memory_date: '2026-07-12',
        created_at: '2026-07-12T00:00:00Z',
        taggedMembers: [],
        mediaAssets: [{ content_type: 'image/jpeg' }],
      } as unknown as MemoryWithTags;
      mockedPostMediaMemory.mockResolvedValue(posted);

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      queryClient.setQueryData(memoriesQueryKey('family-1'), buildInfiniteMemoriesData([existing]));

      const { result } = renderHook(() => usePendingMemoryUploads(), {
        wrapper: createWrapperWithClient(queryClient),
      });

      act(() => {
        result.current.enqueue(photoInput);
      });

      // The pending card is gone as soon as the memory is prepended into the
      // cache -- there's no gap where neither is visible to wait out.
      await waitFor(() => expect(result.current.uploads).toHaveLength(0));

      const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey('family-1'));
      expect(list?.pages[0]?.memories.map((m) => m.id)).toEqual(['memory-1', 'existing-1']);
    });

    it('invalidates the memories list with refetchType none, and calendar with the default type', async () => {
      mockedPostMediaMemory.mockResolvedValue({
        id: 'memory-1',
        memory_type: 'media',
        memory_date: '2026-07-12',
        created_at: '2026-07-12T00:00:00Z',
        taggedMembers: [],
        mediaAssets: [{ content_type: 'image/jpeg' }],
      } as unknown as MemoryWithTags);

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => usePendingMemoryUploads(), {
        wrapper: createWrapperWithClient(queryClient),
      });

      act(() => {
        result.current.enqueue(photoInput);
      });

      await waitFor(() => expect(result.current.uploads).toHaveLength(0));

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: [memoriesQueryKeyBase],
        refetchType: 'none',
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [calendarMemoriesQueryKeyBase] });
    });
  });

  it('throws from enqueue when there is no signed-in user', () => {
    mockedUseAuth.mockReturnValue({
      session: null,
      user: null,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    });

    const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

    expect(() => result.current.enqueue(photoInput)).toThrow(
      'You must be signed in to save a memory',
    );
    expect(result.current.uploads).toHaveLength(0);
  });
});
