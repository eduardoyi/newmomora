import { act, renderHook, waitFor } from '@testing-library/react-native';
import { onlineManager, QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  PendingMemoryUploadsProvider,
  usePendingMemoryUploads,
} from '@/hooks/use-pending-memory-uploads';
import { memoriesQueryKey, memoriesQueryKeyBase, calendarMemoriesQueryKeyBase } from '@/hooks/queryKeys';
import { fetchLinkPreviews } from '@/services/ai';
import {
  patchAudioDescriptionIfEmpty,
  runAudioEmotionAnalysis,
  runMediaPhotoEmotionAnalysis,
  type MemoriesPage,
  type MemoryWithTags,
} from '@/services/memories';
import {
  notifyFamilyActivityFireAndForget,
  postAudioMemory,
  postMediaMemory,
} from '@/services/memory-posting';
import { warmShareCardForMemoryFireAndForget } from '@/services/share-card';

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
  runAudioEmotionAnalysis: jest.fn().mockResolvedValue(undefined),
  patchAudioDescriptionIfEmpty: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/memory-posting', () => ({
  postMediaMemory: jest.fn(),
  postAudioMemory: jest.fn(),
  notifyFamilyActivityFireAndForget: jest.fn(),
  hasImageMediaAsset: (assets: { contentType: string }[]) =>
    assets.some((asset) => !asset.contentType.startsWith('video/')),
  isAudioUploadInput: (input: { kind?: string }) => input?.kind === 'audio',
}));

jest.mock('@/services/share-card', () => ({
  warmShareCardForMemoryFireAndForget: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedPostMediaMemory = postMediaMemory as jest.MockedFunction<typeof postMediaMemory>;
const mockedPostAudioMemory = postAudioMemory as jest.MockedFunction<typeof postAudioMemory>;
const mockedNotify = notifyFamilyActivityFireAndForget as jest.MockedFunction<
  typeof notifyFamilyActivityFireAndForget
>;
const mockedWarmShareCard = warmShareCardForMemoryFireAndForget as jest.MockedFunction<
  typeof warmShareCardForMemoryFireAndForget
>;
const mockedRunMediaPhotoEmotionAnalysis = runMediaPhotoEmotionAnalysis as jest.MockedFunction<
  typeof runMediaPhotoEmotionAnalysis
>;
const mockedRunAudioEmotionAnalysis = runAudioEmotionAnalysis as jest.MockedFunction<
  typeof runAudioEmotionAnalysis
>;
const mockedPatchAudioDescriptionIfEmpty = patchAudioDescriptionIfEmpty as jest.MockedFunction<
  typeof patchAudioDescriptionIfEmpty
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

const audioInput = {
  kind: 'audio' as const,
  memoryId: 'memory-audio-1',
  clip: {
    fileUri: 'file:///recording.m4a',
    durationMs: 4200,
    contentType: 'audio/mp4',
  },
  content: 'Mia singing in the bath',
  audioTranscript: 'twinkle twinkle little star',
  memoryDate: '2026-08-19',
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
    new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false },
        mutations: { gcTime: Infinity, retry: false },
      },
    }),
  );
}

describe('usePendingMemoryUploads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    onlineManager.setOnline(true);

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
        isNetworkFailure: true,
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

  it('tags a non-network failure (e.g. content-safety rejection) with isNetworkFailure: false', async () => {
    mockedPostMediaMemory.mockRejectedValueOnce(
      new Error('This content violates our community guidelines'),
    );

    const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

    act(() => {
      result.current.enqueue(photoInput);
    });

    await waitFor(() => {
      expect(result.current.uploads[0]).toMatchObject({
        status: 'failed',
        isNetworkFailure: false,
      });
    });
  });

  describe('auto-retry on reconnect (O6, docs/plans/offline-awareness-and-share-cards.md)', () => {
    afterEach(() => {
      onlineManager.setOnline(true);
    });

    it('auto-retries a network-caused failure once, on the offline->online edge', async () => {
      mockedPostMediaMemory
        .mockRejectedValueOnce(new Error('Network request failed'))
        .mockResolvedValueOnce({ id: 'memory-1' } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(photoInput);
      });

      await waitFor(() => {
        expect(result.current.uploads[0]).toMatchObject({ status: 'failed', isNetworkFailure: true });
      });
      expect(mockedPostMediaMemory).toHaveBeenCalledTimes(1);

      act(() => {
        onlineManager.setOnline(false);
      });
      act(() => {
        onlineManager.setOnline(true);
      });

      await waitFor(() => {
        expect(result.current.uploads).toHaveLength(0);
      });
      expect(mockedPostMediaMemory).toHaveBeenCalledTimes(2);
    });

    it('does NOT auto-retry a safety-rejected (non-network) failure on reconnect', async () => {
      mockedPostMediaMemory.mockRejectedValueOnce(
        new Error('This content violates our community guidelines'),
      );

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(photoInput);
      });

      await waitFor(() => {
        expect(result.current.uploads[0]).toMatchObject({ status: 'failed', isNetworkFailure: false });
      });
      expect(mockedPostMediaMemory).toHaveBeenCalledTimes(1);

      act(() => {
        onlineManager.setOnline(false);
      });
      act(() => {
        onlineManager.setOnline(true);
      });

      // Left exactly as it was -- still failed, no second post attempt.
      expect(mockedPostMediaMemory).toHaveBeenCalledTimes(1);
      expect(result.current.uploads[0]).toMatchObject({ status: 'failed', isNetworkFailure: false });
    });
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

  describe('warm-share-card fire-and-forget (docs/plans/share-card-store-through.md, W3)', () => {
    it('fires warmShareCardForMemoryFireAndForget exactly once with the posted media memory (cover asset resolution happens inside the hook)', async () => {
      const posted = {
        id: 'memory-1',
        memory_type: 'media',
        mediaAssets: [{ id: 'media-cover' }, { id: 'media-page-2' }],
      };
      mockedPostMediaMemory.mockResolvedValue(posted as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(photoInput);
      });

      await waitFor(() => {
        expect(mockedWarmShareCard).toHaveBeenCalledTimes(1);
      });
      expect(mockedWarmShareCard).toHaveBeenCalledWith(posted);
    });

    it('does not await the warm hook -- the queue removes the pending upload even while it hangs forever', async () => {
      mockedWarmShareCard.mockImplementation(() => {
        // Never-resolving inner work: proves the queue does not await this
        // function's side effects (it returns void synchronously).
        void new Promise(() => {});
      });
      mockedPostMediaMemory.mockResolvedValue({
        id: 'memory-1',
        memory_type: 'media',
        mediaAssets: [{ id: 'media-cover' }],
      } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(photoInput);
      });

      await waitFor(() => {
        expect(result.current.uploads).toHaveLength(0);
      });
    });

    it("does not surface a rejection from the warm hook's own internal promise chain", async () => {
      mockedWarmShareCard.mockImplementation(() => {
        // Simulates the real implementation's own swallow-internally shape
        // (see share-card.test.ts) -- no rejection escapes the void call.
        void Promise.reject(new Error('warm request failed')).catch(() => {});
      });
      mockedPostMediaMemory.mockResolvedValue({
        id: 'memory-1',
        memory_type: 'media',
        mediaAssets: [{ id: 'media-cover' }],
      } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(photoInput);
      });

      await waitFor(() => {
        expect(result.current.uploads).toHaveLength(0);
      });
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
        defaultOptions: {
          queries: { gcTime: Infinity, retry: false },
          mutations: { gcTime: Infinity, retry: false },
        },
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
        defaultOptions: {
          queries: { gcTime: Infinity, retry: false },
          mutations: { gcTime: Infinity, retry: false },
        },
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

  // docs/plans/audio-memories-v1.md P2.4: audio shares the same
  // pending/failed/retry/discard lifecycle as media, but routes through
  // postAudioMemory and the text-classifier emotion kick instead of the
  // photo/vision one.
  describe('audio uploads', () => {
    it('tracks a pending audio upload with the clip as its preview, and removes it once posting succeeds', async () => {
      let resolvePost: (memory: unknown) => void = () => {};
      mockedPostAudioMemory.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePost = resolve as typeof resolvePost;
          }) as ReturnType<typeof postAudioMemory>,
      );

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(audioInput);
      });

      expect(result.current.uploads).toHaveLength(1);
      expect(result.current.uploads[0]).toMatchObject({
        memoryId: 'memory-audio-1',
        status: 'posting',
        totalAssets: 1,
        uploadedAssets: 0,
        previewUri: 'file:///recording.m4a',
        previewContentType: 'audio/mp4',
      });

      act(() => {
        resolvePost({ id: 'memory-audio-1', content: 'Mia singing in the bath', audio_transcript: 'twinkle twinkle little star' });
      });

      await waitFor(() => {
        expect(result.current.uploads).toHaveLength(0);
      });
      expect(mockedPostMediaMemory).not.toHaveBeenCalled();
    });

    it('kicks the text-path emotion analysis (never the photo/vision one) when content or transcript is analyzable', async () => {
      mockedPostAudioMemory.mockResolvedValue({
        id: 'memory-audio-1',
        content: 'Mia singing in the bath',
        audio_transcript: 'twinkle twinkle little star',
      } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(audioInput);
      });

      await waitFor(() => {
        expect(mockedRunAudioEmotionAnalysis).toHaveBeenCalledWith('memory-audio-1');
      });
      expect(mockedRunMediaPhotoEmotionAnalysis).not.toHaveBeenCalled();
    });

    it('skips the emotion kick entirely when both content and transcript are empty (server no-ops it, but the call is still wasted)', async () => {
      mockedPostAudioMemory.mockResolvedValue({
        id: 'memory-audio-empty',
        content: null,
        audio_transcript: null,
      } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue({
          ...audioInput,
          memoryId: 'memory-audio-empty',
          content: null,
          audioTranscript: null,
        });
      });

      await waitFor(() => {
        expect(mockedNotify).toHaveBeenCalledWith('memory-audio-empty');
      });
      expect(mockedRunAudioEmotionAnalysis).not.toHaveBeenCalled();
      expect(mockedRunMediaPhotoEmotionAnalysis).not.toHaveBeenCalled();
    });

    it('does not warm the share card for an audio memory (compose-share-card rejects audio in v1)', async () => {
      mockedPostAudioMemory.mockResolvedValue({
        id: 'memory-audio-1',
        content: 'Mia singing in the bath',
        audio_transcript: null,
      } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(audioInput);
      });

      await waitFor(() => {
        expect(mockedNotify).toHaveBeenCalledWith('memory-audio-1');
      });
      expect(mockedWarmShareCard).not.toHaveBeenCalled();
    });

    // Cross-seam ordering bug fix: the memories row only exists once
    // postAudioMemory's insert resolves, which typically happens AFTER the
    // composer's in-flight transcription. Firing patchAudioDescriptionIfEmpty
    // directly off the transcription promise (bypassing the queue) would
    // race that insert -- a zero-row UPDATE succeeds silently, permanently
    // losing the description/transcript. The queue must own this ordering.
    describe('pendingTranscription backfill (ordering fix)', () => {
      it('patches the backfill after post success even when transcription resolved BEFORE the post did', async () => {
        // Transcription already resolved by the time enqueue() is called --
        // the promise is already settled, but the queue must still wait for
        // postAudioMemory's own insert before chaining onto it.
        const pendingTranscription = Promise.resolve({
          cleanedText: 'twinkle twinkle little star',
          description: 'Mia singing in the bath',
        });
        mockedPostAudioMemory.mockResolvedValue({ id: 'memory-audio-1' } as never);

        const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

        act(() => {
          result.current.enqueue({ ...audioInput, pendingTranscription });
        });

        await waitFor(() => {
          expect(result.current.uploads).toHaveLength(0);
        });
        await waitFor(() => {
          expect(mockedPatchAudioDescriptionIfEmpty).toHaveBeenCalledWith('memory-audio-1', {
            description: 'Mia singing in the bath',
            transcript: 'twinkle twinkle little star',
          });
        });
      });

      it('patches the backfill after post success when transcription resolves AFTER the post did', async () => {
        let resolveTranscription: (
          value: { cleanedText: string; description: string } | null,
        ) => void = () => {};
        const pendingTranscription = new Promise<{ cleanedText: string; description: string } | null>(
          (resolve) => {
            resolveTranscription = resolve;
          },
        );
        mockedPostAudioMemory.mockResolvedValue({ id: 'memory-audio-1' } as never);

        const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

        act(() => {
          result.current.enqueue({ ...audioInput, pendingTranscription });
        });

        // Post already succeeded (row exists); transcription is still in flight.
        await waitFor(() => {
          expect(result.current.uploads).toHaveLength(0);
        });
        expect(mockedPatchAudioDescriptionIfEmpty).not.toHaveBeenCalled();

        act(() => {
          resolveTranscription({
            cleanedText: 'twinkle twinkle little star',
            description: 'Mia singing in the bath',
          });
        });

        await waitFor(() => {
          expect(mockedPatchAudioDescriptionIfEmpty).toHaveBeenCalledWith('memory-audio-1', {
            description: 'Mia singing in the bath',
            transcript: 'twinkle twinkle little star',
          });
        });
      });

      it('normalizes an empty description/transcript result to NULL rather than empty string', async () => {
        const pendingTranscription = Promise.resolve({ cleanedText: '   ', description: '' });
        mockedPostAudioMemory.mockResolvedValue({ id: 'memory-audio-1' } as never);

        const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

        act(() => {
          result.current.enqueue({ ...audioInput, pendingTranscription });
        });

        await waitFor(() => {
          expect(mockedPatchAudioDescriptionIfEmpty).toHaveBeenCalledWith('memory-audio-1', {
            description: null,
            transcript: null,
          });
        });
      });

      it('never patches when the transcription result resolves to null (unusable speech)', async () => {
        const pendingTranscription = Promise.resolve(null);
        mockedPostAudioMemory.mockResolvedValue({ id: 'memory-audio-1' } as never);

        const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

        act(() => {
          result.current.enqueue({ ...audioInput, pendingTranscription });
        });

        await waitFor(() => {
          expect(result.current.uploads).toHaveLength(0);
        });
        // Give the already-resolved promise's .then a turn to run.
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockedPatchAudioDescriptionIfEmpty).not.toHaveBeenCalled();
      });

      it('a rejected pendingTranscription does not break the post or throw unhandled', async () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const pendingTranscription = Promise.reject(new Error('transcription network failure'));
        mockedPostAudioMemory.mockResolvedValue({ id: 'memory-audio-1' } as never);

        const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

        act(() => {
          result.current.enqueue({ ...audioInput, pendingTranscription });
        });

        // The post itself still succeeds -- the queue never awaits this promise.
        await waitFor(() => {
          expect(result.current.uploads).toHaveLength(0);
        });

        await waitFor(() => {
          expect(consoleWarnSpy).toHaveBeenCalledWith(
            'pendingTranscription failed; audio memory keeps its save-time description/transcript',
            'memory-audio-1',
            'transcription network failure',
          );
        });
        expect(mockedPatchAudioDescriptionIfEmpty).not.toHaveBeenCalled();

        consoleWarnSpy.mockRestore();
      });

      it('never patches after a failed post is discarded (discard is only ever exposed for a failed card)', async () => {
        // The queue exposes discard() for a 'failed' card (see the existing
        // "discards a failed upload" test) -- there is no discard affordance
        // while still 'posting'. On a rejected post, control never reaches
        // the pendingTranscription-chaining code below (it's inside the try
        // block, after the now-thrown `await postAudioMemory(...)`), so the
        // patch can never fire regardless of discard; this test protects
        // that invariant explicitly rather than relying on it implicitly.
        mockedPostAudioMemory.mockRejectedValue(new Error('network down'));
        const pendingTranscription = Promise.resolve({
          cleanedText: 'twinkle twinkle little star',
          description: 'Mia singing in the bath',
        });

        const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

        act(() => {
          result.current.enqueue({ ...audioInput, pendingTranscription });
        });

        await waitFor(() => {
          expect(result.current.uploads[0]?.status).toBe('failed');
        });

        act(() => {
          result.current.discard('memory-audio-1');
        });

        expect(result.current.uploads).toHaveLength(0);

        // Give the already-resolved pendingTranscription a turn regardless.
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(mockedPatchAudioDescriptionIfEmpty).not.toHaveBeenCalled();
      });

      it('media (non-audio) inputs are entirely unaffected -- patchAudioDescriptionIfEmpty is never invoked', async () => {
        mockedPostMediaMemory.mockResolvedValue({ id: 'memory-1' } as never);

        const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

        act(() => {
          result.current.enqueue(photoInput);
        });

        await waitFor(() => {
          expect(result.current.uploads).toHaveLength(0);
        });
        expect(mockedPatchAudioDescriptionIfEmpty).not.toHaveBeenCalled();
      });
    });

    it('marks the audio upload failed and supports retrying it', async () => {
      mockedPostAudioMemory
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({ id: 'memory-audio-1' } as never);

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(audioInput);
      });

      await waitFor(() => {
        expect(result.current.uploads[0]).toMatchObject({
          status: 'failed',
          errorMessage: 'network down',
          isNetworkFailure: true,
        });
      });

      act(() => {
        result.current.retry('memory-audio-1');
      });

      await waitFor(() => {
        expect(result.current.uploads).toHaveLength(0);
      });
      expect(mockedPostAudioMemory).toHaveBeenCalledTimes(2);
    });

    it('discards a failed audio upload', async () => {
      mockedPostAudioMemory.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => usePendingMemoryUploads(), { wrapper: createWrapper() });

      act(() => {
        result.current.enqueue(audioInput);
      });

      await waitFor(() => {
        expect(result.current.uploads[0]?.status).toBe('failed');
      });

      act(() => {
        result.current.discard('memory-audio-1');
      });

      expect(result.current.uploads).toHaveLength(0);
    });

    // Workstream A4b / P2.4: the audio path shares the exact same
    // memory-cache prepend helper as media -- no new query shapes.
    describe('cache wiring', () => {
      function buildInfiniteMemoriesData(memories: MemoryWithTags[]): InfiniteData<MemoriesPage> {
        return { pages: [{ memories, nextCursor: null }], pageParams: [null] };
      }

      it('prepends the posted audio memory into the timeline cache without waiting on a refetch', async () => {
        const existing = {
          id: 'existing-1',
          memory_type: 'text_only',
          memory_date: '2026-08-10',
          created_at: '2026-08-10T00:00:00Z',
          taggedMembers: [],
          mediaAssets: [],
        } as unknown as MemoryWithTags;
        const posted = {
          id: 'memory-audio-1',
          memory_type: 'audio',
          memory_date: '2026-08-19',
          created_at: '2026-08-19T00:00:00Z',
          content: 'Mia singing in the bath',
          audio_transcript: 'twinkle twinkle little star',
          taggedMembers: [],
          mediaAssets: [],
        } as unknown as MemoryWithTags;
        mockedPostAudioMemory.mockResolvedValue(posted);

        const queryClient = new QueryClient({
          defaultOptions: {
            queries: { gcTime: Infinity, retry: false },
            mutations: { gcTime: Infinity, retry: false },
          },
        });
        queryClient.setQueryData(memoriesQueryKey('family-1'), buildInfiniteMemoriesData([existing]));

        const { result } = renderHook(() => usePendingMemoryUploads(), {
          wrapper: createWrapperWithClient(queryClient),
        });

        act(() => {
          result.current.enqueue(audioInput);
        });

        await waitFor(() => expect(result.current.uploads).toHaveLength(0));

        const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey('family-1'));
        expect(list?.pages[0]?.memories.map((m) => m.id)).toEqual([
          'memory-audio-1',
          'existing-1',
        ]);
      });
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
