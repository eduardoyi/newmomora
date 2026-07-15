import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useMemories, useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyPortraitVersions } from '@/hooks/usePortraitVersions';
import { memoriesQueryKey } from '@/hooks/queryKeys';
import {
  createMemory,
  fetchMemories,
  fetchMemoryById,
  retryMemoryIllustration,
  runMediaPhotoEmotionAnalysis,
  runTextOnlyEmotionAnalysis,
  updateMemory,
  type MemoryWithTags,
} from '@/services/memories';
import { fetchLinkPreviews, notifyFamilyActivity } from '@/services/ai';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/usePortraitVersions', () => ({
  useFamilyPortraitVersions: jest.fn(),
}));

jest.mock('@/services/memories', () => ({
  createMemory: jest.fn(),
  createMediaMemory: jest.fn(),
  deleteMemory: jest.fn(),
  fetchMemories: jest.fn(),
  fetchMemoryById: jest.fn(),
  retryMemoryIllustration: jest.fn(),
  runMediaPhotoEmotionAnalysis: jest.fn().mockResolvedValue(undefined),
  runTextOnlyEmotionAnalysis: jest.fn().mockResolvedValue(undefined),
  searchMemories: jest.fn(),
  updateMemory: jest.fn(),
}));

jest.mock('@/services/media', () => ({
  deleteStorageObject: jest.fn(),
  uploadMediaObject: jest.fn(),
}));

jest.mock('@/services/ai', () => ({
  notifyFamilyActivity: jest.fn(),
  fetchLinkPreviews: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyPortraitVersions = useFamilyPortraitVersions as jest.MockedFunction<
  typeof useFamilyPortraitVersions
>;
const mockedFetchMemories = fetchMemories as jest.MockedFunction<typeof fetchMemories>;
const mockedCreateMemory = createMemory as jest.MockedFunction<typeof createMemory>;
const mockedUpdateMemory = updateMemory as jest.MockedFunction<typeof updateMemory>;
const mockedRunMediaPhotoEmotionAnalysis = runMediaPhotoEmotionAnalysis as jest.MockedFunction<
  typeof runMediaPhotoEmotionAnalysis
>;
const mockedNotifyFamilyActivity = notifyFamilyActivity as jest.MockedFunction<
  typeof notifyFamilyActivity
>;
const mockedFetchLinkPreviews = fetchLinkPreviews as jest.MockedFunction<typeof fetchLinkPreviews>;
const mockedFetchMemoryById = fetchMemoryById as jest.MockedFunction<typeof fetchMemoryById>;
const mockedRetryMemoryIllustration = retryMemoryIllustration as jest.MockedFunction<
  typeof retryMemoryIllustration
>;
const mockedRunTextOnlyEmotionAnalysis = runTextOnlyEmotionAnalysis as jest.MockedFunction<
  typeof runTextOnlyEmotionAnalysis
>;

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapperWithClient(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function createWrapper() {
  return createWrapperWithClient(createQueryClient());
}

describe('useMemories integration', () => {
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
    mockedUseFamilyPortraitVersions.mockReturnValue({ data: [], isLoading: false } as never);

    mockedFetchMemories.mockResolvedValue({ data: [], error: null });
    mockedNotifyFamilyActivity.mockResolvedValue({ data: { sent: true }, error: null });
    mockedFetchLinkPreviews.mockResolvedValue({ data: { linkPreviews: {} }, error: null });
  });

  // Media memory creation moved to the pending-uploads queue -- see
  // src/hooks/use-pending-memory-uploads.test.tsx and
  // src/services/memory-posting.test.ts for its coverage.

  it('resolves tagged-member avatars against each memory date', async () => {
    mockedFetchMemories.mockResolvedValue({
      data: [{
        id: 'memory-1',
        memory_date: '2026-05-30',
        memory_type: 'text_only',
        emotion: 'joy',
        illustration_status: 'none',
        taggedMembers: [{ id: 'member-1', name: 'Maya', updated_at: 'member-time' }],
        mediaAssets: [],
      }] as never,
      error: null,
    });
    mockedUseFamilyPortraitVersions.mockReturnValue({
      data: [
        {
          id: 'jan',
          family_member_id: 'member-1',
          reference_date: '2026-01-01',
          illustrated_profile_key: 'portrait-jan',
          illustrated_profile_status: 'ready',
          deletion_token: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: 'portrait-jan-time',
        },
        {
          id: 'jun',
          family_member_id: 'member-1',
          reference_date: '2026-06-01',
          illustrated_profile_key: 'portrait-jun',
          illustrated_profile_status: 'ready',
          deletion_token: null,
          created_at: '2026-06-01T00:00:00Z',
          updated_at: 'portrait-jun-time',
        },
      ],
      isLoading: false,
    } as never);

    const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.memories).toHaveLength(1));

    expect(result.current.memories[0].taggedMembers[0].avatarImageKey).toBe('portrait-jan');
    expect(result.current.memories[0].taggedMembers[0].avatarUpdatedAt).toBe('portrait-jan');
  });

  it('re-runs photo emotion analysis when caption changes', async () => {
    mockedUpdateMemory.mockResolvedValue({
      data: {
        id: 'memory-photo-2',
        memory_type: 'media',
        media_content_type: 'image/jpeg',
        emotion: 'calm',
        taggedMembers: [],
        mediaAssets: [{ content_type: 'image/jpeg' }],
      },
      error: null,
    });

    const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await result.current.updateMemory({
      memoryId: 'memory-photo-2',
      content: 'Updated caption',
    });

    await waitFor(() => {
      expect(mockedRunMediaPhotoEmotionAnalysis).toHaveBeenCalledWith('memory-photo-2');
    });
  });

  it('does not re-run photo emotion analysis for date-only edits', async () => {
    mockedUpdateMemory.mockResolvedValue({
      data: {
        id: 'memory-photo-3',
        memory_type: 'media',
        media_content_type: 'image/jpeg',
        emotion: 'joy',
        taggedMembers: [],
        mediaAssets: [{ content_type: 'image/jpeg' }],
      },
      error: null,
    });

    const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await result.current.updateMemory({
      memoryId: 'memory-photo-3',
      memoryDate: '2026-05-27',
    });

    expect(mockedRunMediaPhotoEmotionAnalysis).not.toHaveBeenCalled();
  });

  describe('notify-family-activity fire-and-forget (plan §10)', () => {
    it('fires notify-family-activity after a successful text memory create, without blocking it', async () => {
      mockedCreateMemory.mockResolvedValue({
        data: { id: 'memory-text-1', memory_type: 'text_only', taggedMembers: [] },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.createMemory({
        content: 'A quiet afternoon',
        memoryDate: '2026-05-26',
        taggedMemberIds: [],
      });

      await waitFor(() => {
        expect(mockedNotifyFamilyActivity).toHaveBeenCalledWith('memory-text-1');
      });
    });

    it('still resolves the create mutation even when notify-family-activity rejects', async () => {
      mockedCreateMemory.mockResolvedValue({
        data: { id: 'memory-text-2', memory_type: 'text_only', taggedMembers: [] },
        error: null,
      });
      mockedNotifyFamilyActivity.mockRejectedValue(new Error('network down'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // The create mutation itself must resolve successfully -- a notify
      // failure must never surface as a create failure.
      await expect(
        result.current.createMemory({
          content: 'Still saved',
          memoryDate: '2026-05-26',
          taggedMemberIds: [],
        }),
      ).resolves.toMatchObject({ id: 'memory-text-2' });

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          'Failed to notify family of new memory',
          'memory-text-2',
          'network down',
        );
      });

      warnSpy.mockRestore();
    });

    it('still resolves the create mutation even when notify-family-activity returns an error', async () => {
      mockedCreateMemory.mockResolvedValue({
        data: { id: 'memory-text-3', memory_type: 'text_only', taggedMembers: [] },
        error: null,
      });
      mockedNotifyFamilyActivity.mockResolvedValue({
        data: null,
        error: { message: 'forbidden' },
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await expect(
        result.current.createMemory({
          content: 'Still saved',
          memoryDate: '2026-05-26',
          taggedMemberIds: [],
        }),
      ).resolves.toMatchObject({ id: 'memory-text-3' });

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          'Failed to notify family of new memory',
          'memory-text-3',
          'forbidden',
        );
      });

      warnSpy.mockRestore();
    });
  });

  describe('fetch-link-previews fire-and-forget (plan §7)', () => {
    it('triggers fetchLinkPreviews after creating a memory whose content contains a URL', async () => {
      mockedCreateMemory.mockResolvedValue({
        data: { id: 'memory-link-1', memory_type: 'text_only', taggedMembers: [] },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.createMemory({
        content: 'Look at this https://example.com',
        memoryDate: '2026-05-26',
        taggedMemberIds: [],
      });

      await waitFor(() => {
        expect(mockedFetchLinkPreviews).toHaveBeenCalledWith('memory-link-1');
      });
    });

    it('does not trigger fetchLinkPreviews after creating a memory with no URL in content', async () => {
      mockedCreateMemory.mockResolvedValue({
        data: { id: 'memory-nolink-1', memory_type: 'text_only', taggedMembers: [] },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.createMemory({
        content: 'No links in this one',
        memoryDate: '2026-05-26',
        taggedMemberIds: [],
      });

      expect(mockedFetchLinkPreviews).not.toHaveBeenCalled();
    });

    it('triggers fetchLinkPreviews after updating content, even when the edit removes the last URL', async () => {
      mockedUpdateMemory.mockResolvedValue({
        data: {
          id: 'memory-link-2',
          memory_type: 'text_only',
          taggedMembers: [],
          mediaAssets: [],
        },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // No URL in the new content -- the prune step must still run so a
      // stale link_previews entry from before the edit gets cleared.
      await result.current.updateMemory({
        memoryId: 'memory-link-2',
        content: 'No more links here',
      });

      await waitFor(() => {
        expect(mockedFetchLinkPreviews).toHaveBeenCalledWith('memory-link-2');
      });
    });

    it('does not trigger fetchLinkPreviews for an update that does not touch content', async () => {
      mockedUpdateMemory.mockResolvedValue({
        data: {
          id: 'memory-link-3',
          memory_type: 'text_only',
          taggedMembers: [],
          mediaAssets: [],
        },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.updateMemory({
        memoryId: 'memory-link-3',
        memoryDate: '2026-05-27',
      });

      expect(mockedFetchLinkPreviews).not.toHaveBeenCalled();
    });

    it('still resolves the create mutation when fetchLinkPreviews rejects', async () => {
      mockedCreateMemory.mockResolvedValue({
        data: { id: 'memory-link-4', memory_type: 'text_only', taggedMembers: [] },
        error: null,
      });
      mockedFetchLinkPreviews.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await expect(
        result.current.createMemory({
          content: 'Still saved https://example.com',
          memoryDate: '2026-05-26',
          taggedMemberIds: [],
        }),
      ).resolves.toMatchObject({ id: 'memory-link-4' });
    });

    it('still resolves the update mutation when fetchLinkPreviews rejects', async () => {
      mockedUpdateMemory.mockResolvedValue({
        data: {
          id: 'memory-link-5',
          memory_type: 'text_only',
          taggedMembers: [],
          mediaAssets: [],
        },
        error: null,
      });
      mockedFetchLinkPreviews.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await expect(
        result.current.updateMemory({
          memoryId: 'memory-link-5',
          content: 'Edited https://example.com',
        }),
      ).resolves.toMatchObject({ id: 'memory-link-5' });
    });
  });

  describe('useMemory detail seeding from the timeline cache', () => {
    function buildCachedMemory(overrides: Partial<MemoryWithTags> = {}): MemoryWithTags {
      return {
        id: 'memory-cached-1',
        user_id: 'user-1',
        family_id: 'family-1',
        content: 'Cached memory',
        memory_date: '2026-05-24',
        memory_type: 'text_only',
        emotion: 'joy',
        illustration_key: null,
        illustration_status: 'none',
        illustration_prompt: null,
        media_key: null,
        media_content_type: null,
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
        taggedMembers: [],
        mediaAssets: [],
        ...overrides,
      } as MemoryWithTags;
    }

    it('shows the cached timeline memory immediately while the detail fetch is in flight', () => {
      const queryClient = createQueryClient();
      queryClient.setQueryData([...memoriesQueryKey('family-1'), ''], [buildCachedMemory()]);
      mockedFetchMemoryById.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useMemory('memory-cached-1'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      expect(result.current.data?.id).toBe('memory-cached-1');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isPlaceholderData).toBe(true);
    });

    it('replaces the cached copy with fresh data once the detail fetch resolves', async () => {
      const queryClient = createQueryClient();
      queryClient.setQueryData(
        [...memoriesQueryKey('family-1'), ''],
        [buildCachedMemory({ content: 'Cached copy' })],
      );
      mockedFetchMemoryById.mockResolvedValue({
        data: buildCachedMemory({ content: 'Fresh copy' }),
        error: null,
      });

      const { result } = renderHook(() => useMemory('memory-cached-1'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      expect(result.current.data?.content).toBe('Cached copy');

      await waitFor(() => {
        expect(result.current.data?.content).toBe('Fresh copy');
      });
      expect(result.current.isPlaceholderData).toBe(false);
    });

    it('does not fire illustration recovery off stale placeholder data', async () => {
      const queryClient = createQueryClient();
      // Cached list copy looks like a stale 'generating' run; the server has
      // since marked it 'failed'. Recovery must wait for the fresh fetch --
      // firing off the placeholder would relaunch the pipeline for a failed
      // illustration behind the manual retry gate.
      const staleCached = buildCachedMemory({
        id: 'memory-stale-detail',
        memory_type: 'text_illustration',
        illustration_status: 'generating',
        updated_at: '2026-01-01T00:00:00Z',
      });
      queryClient.setQueryData([...memoriesQueryKey('family-1'), ''], [staleCached]);
      mockedFetchMemoryById.mockResolvedValue({
        data: { ...staleCached, illustration_status: 'failed' } as never,
        error: null,
      });

      const { result } = renderHook(() => useMemory('memory-stale-detail'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      expect(result.current.isPlaceholderData).toBe(true);

      await waitFor(() => {
        expect(result.current.isPlaceholderData).toBe(false);
      });
      expect(mockedRetryMemoryIllustration).not.toHaveBeenCalled();
    });

    it("does not seed the detail view from another family's cache", () => {
      const queryClient = createQueryClient();
      queryClient.setQueryData([...memoriesQueryKey('family-2'), ''], [buildCachedMemory()]);
      mockedFetchMemoryById.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useMemory('memory-cached-1'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      expect(result.current.data).toBeUndefined();
      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('backfill flows patch caches instead of invalidating everything', () => {
    it('backfills a missing emotion by patching the cache, without refetching the timeline', async () => {
      const migrated = {
        id: 'memory-backfill-1',
        family_id: 'family-1',
        memory_type: 'text_only',
        content: 'Old migrated memory',
        emotion: null,
        illustration_status: 'none',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        taggedMembers: [],
        mediaAssets: [],
      };
      mockedFetchMemories.mockResolvedValue({ data: [migrated as never], error: null });
      mockedRunTextOnlyEmotionAnalysis.mockResolvedValue('joy');

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.memories[0]?.emotion).toBe('joy');
      });
      expect(mockedRunTextOnlyEmotionAnalysis).toHaveBeenCalledTimes(1);
      expect(mockedFetchMemories).toHaveBeenCalledTimes(1);
    });

    it('recovers a stale illustration by patching its status, without refetching the timeline', async () => {
      const stale = {
        id: 'memory-stale-1',
        family_id: 'family-1',
        memory_type: 'text_illustration',
        content: 'Stale generation',
        emotion: 'joy',
        illustration_status: 'generating',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        taggedMembers: [],
        mediaAssets: [],
      };
      mockedFetchMemories.mockResolvedValue({ data: [stale as never], error: null });
      mockedRetryMemoryIllustration.mockResolvedValue({ error: null });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.memories[0]?.illustration_status).toBe('pending');
      });
      expect(mockedRetryMemoryIllustration).toHaveBeenCalledWith('memory-stale-1');
      expect(mockedRetryMemoryIllustration).toHaveBeenCalledTimes(1);
      expect(mockedFetchMemories).toHaveBeenCalledTimes(1);
      // The patched row must read as freshly pending, not stale-pending --
      // otherwise the recovery effect would loop on it.
      expect(
        new Date(result.current.memories[0]?.updated_at ?? 0).getTime(),
      ).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  describe('useMemoryMutations', () => {
    it('does not subscribe to or fetch the timeline list', async () => {
      const { result } = renderHook(() => useMemoryMutations(), { wrapper: createWrapper() });

      expect(result.current.createMemory).toBeDefined();
      expect(result.current.deleteMemory).toBeDefined();

      // Give any stray query subscriptions a tick to fire before asserting.
      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      });

      expect(mockedFetchMemories).not.toHaveBeenCalled();
    });
  });
});
