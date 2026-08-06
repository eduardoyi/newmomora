import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

import { useMemberMemories, useMemories, useMemory, useMemoryMutations } from '@/hooks/useMemories';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyPortraitVersions } from '@/hooks/usePortraitVersions';
import { memoriesQueryKey, memoryDetailQueryKey } from '@/hooks/queryKeys';
import {
  createMemory,
  deleteMemory,
  fetchMemoriesPage,
  fetchMemoriesPageForMember,
  fetchMemoryById,
  fetchMemoryGenerationStatuses,
  regenerateMemoryIllustration,
  retryMemoryIllustration,
  runMediaPhotoEmotionAnalysis,
  runTextOnlyEmotionAnalysis,
  updateMemory,
  type MemoriesPage,
  type MemoryWithTags,
} from '@/services/memories';
import { fetchLinkPreviews, notifyFamilyActivity } from '@/services/ai';
import { warmShareCardFireAndForget, warmShareCardForMemoryFireAndForget } from '@/services/share-card';

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
  fetchMemoriesPage: jest.fn(),
  fetchMemoriesPageForMember: jest.fn(),
  fetchMemoryById: jest.fn(),
  fetchMemoryGenerationStatuses: jest.fn(),
  regenerateMemoryIllustration: jest.fn(),
  retryMemoryIllustration: jest.fn(),
  runMediaPhotoEmotionAnalysis: jest.fn().mockResolvedValue(undefined),
  runTextOnlyEmotionAnalysis: jest.fn().mockResolvedValue(undefined),
  searchMemories: jest.fn(),
  updateMemory: jest.fn(),
  MEMORIES_PAGE_SIZE: 40,
}));

jest.mock('@/services/media', () => ({
  deleteStorageObject: jest.fn(),
  uploadMediaObject: jest.fn(),
}));

jest.mock('@/services/ai', () => ({
  notifyFamilyActivity: jest.fn(),
  fetchLinkPreviews: jest.fn(),
}));

jest.mock('@/services/share-card', () => ({
  warmShareCardForMemoryFireAndForget: jest.fn(),
  warmShareCardFireAndForget: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyPortraitVersions = useFamilyPortraitVersions as jest.MockedFunction<
  typeof useFamilyPortraitVersions
>;
const mockedFetchMemoriesPage = fetchMemoriesPage as jest.MockedFunction<typeof fetchMemoriesPage>;
const mockedFetchMemoriesPageForMember = fetchMemoriesPageForMember as jest.MockedFunction<
  typeof fetchMemoriesPageForMember
>;
const mockedFetchMemoryGenerationStatuses = fetchMemoryGenerationStatuses as jest.MockedFunction<
  typeof fetchMemoryGenerationStatuses
>;
const mockedCreateMemory = createMemory as jest.MockedFunction<typeof createMemory>;
const mockedUpdateMemory = updateMemory as jest.MockedFunction<typeof updateMemory>;
const mockedDeleteMemory = deleteMemory as jest.MockedFunction<typeof deleteMemory>;
const mockedRunMediaPhotoEmotionAnalysis = runMediaPhotoEmotionAnalysis as jest.MockedFunction<
  typeof runMediaPhotoEmotionAnalysis
>;
const mockedNotifyFamilyActivity = notifyFamilyActivity as jest.MockedFunction<
  typeof notifyFamilyActivity
>;
const mockedFetchLinkPreviews = fetchLinkPreviews as jest.MockedFunction<typeof fetchLinkPreviews>;
const mockedWarmShareCard = warmShareCardForMemoryFireAndForget as jest.MockedFunction<
  typeof warmShareCardForMemoryFireAndForget
>;
const mockedWarmShareCardFireAndForget = warmShareCardFireAndForget as jest.MockedFunction<
  typeof warmShareCardFireAndForget
>;
const mockedFetchMemoryById = fetchMemoryById as jest.MockedFunction<typeof fetchMemoryById>;
const mockedRetryMemoryIllustration = retryMemoryIllustration as jest.MockedFunction<
  typeof retryMemoryIllustration
>;
const mockedRegenerateMemoryIllustration = regenerateMemoryIllustration as jest.MockedFunction<
  typeof regenerateMemoryIllustration
>;
const mockedRunTextOnlyEmotionAnalysis = runTextOnlyEmotionAnalysis as jest.MockedFunction<
  typeof runTextOnlyEmotionAnalysis
>;

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
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

// useMemories is now backed by useInfiniteQuery (Workstream A2) --
// fetchMemoriesPage resolves one MemoriesPage per call.
function pageResult(
  memories: MemoryWithTags[],
  nextCursor: MemoriesPage['nextCursor'] = null,
): { data: MemoriesPage; error: null } {
  return { data: { memories, nextCursor }, error: null };
}

function buildInfiniteMemoriesData(memories: MemoryWithTags[]): InfiniteData<MemoriesPage> {
  return { pages: [{ memories, nextCursor: null }], pageParams: [null] };
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

    mockedFetchMemoriesPage.mockResolvedValue(pageResult([]));
    mockedFetchMemoriesPageForMember.mockResolvedValue(pageResult([]));
    mockedFetchMemoryGenerationStatuses.mockResolvedValue({ data: [], error: null });
    mockedNotifyFamilyActivity.mockResolvedValue({ data: { sent: true }, error: null });
    mockedFetchLinkPreviews.mockResolvedValue({ data: { linkPreviews: {} }, error: null });
  });

  // Media memory creation moved to the pending-uploads queue -- see
  // src/hooks/use-pending-memory-uploads.test.tsx and
  // src/services/memory-posting.test.ts for its coverage.

  it('resolves tagged-member avatars against each memory date', async () => {
    mockedFetchMemoriesPage.mockResolvedValue(
      pageResult([
        {
          id: 'memory-1',
          memory_date: '2026-05-30',
          memory_type: 'text_only',
          emotion: 'joy',
          illustration_status: 'none',
          taggedMembers: [{ id: 'member-1', name: 'Maya', updated_at: 'member-time' }],
          mediaAssets: [],
        } as never,
      ]),
    );
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

  it('scopes the timeline fetch to the active family', async () => {
    const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockedFetchMemoriesPage).toHaveBeenCalledWith(
      'family-1',
      expect.objectContaining({ limit: 40 }),
    );
  });

  it('does not fetch the timeline when there is no active family', async () => {
    mockedUseFamily.mockReturnValue({
      family: null,
      familyId: null,
      role: null,
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    renderHook(() => useMemories(), { wrapper: createWrapper() });

    expect(mockedFetchMemoriesPage).not.toHaveBeenCalled();
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
        data: { id: 'memory-text-1', memory_type: 'text_only', memory_date: '2026-05-26', created_at: 'c1', taggedMembers: [] },
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
        data: { id: 'memory-text-2', memory_type: 'text_only', memory_date: '2026-05-26', created_at: 'c1', taggedMembers: [] },
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
        data: { id: 'memory-text-3', memory_type: 'text_only', memory_date: '2026-05-26', created_at: 'c1', taggedMembers: [] },
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

  describe('warm-share-card fire-and-forget (docs/plans/share-card-store-through.md, W3)', () => {
    it('fires warmShareCardForMemoryFireAndForget exactly once with the created memory after a text create', async () => {
      const created = {
        id: 'memory-text-1',
        memory_type: 'text_only',
        memory_date: '2026-05-26',
        created_at: 'c1',
        taggedMembers: [],
        mediaAssets: [],
      };
      mockedCreateMemory.mockResolvedValue({ data: created, error: null });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.createMemory({
        content: 'A quiet afternoon',
        memoryDate: '2026-05-26',
        taggedMemberIds: [],
      });

      expect(mockedWarmShareCard).toHaveBeenCalledTimes(1);
      expect(mockedWarmShareCard).toHaveBeenCalledWith(created);
    });

    // Bug B (docs/plans/share-card-store-through.md's incident follow-up,
    // 20260806140000_share_card_illustration_key_trigger.sql): a fresh
    // text_illustration memory's illustration is still pending/generating
    // the instant createMemory() resolves (the async pipeline dispatches
    // afterward) -- warming here would compose+cache a card that renders
    // without the illustration. This is the client-side half of the fix;
    // the ready-transition tests below cover the replacement warm timing.
    it('does NOT fire warmShareCardForMemoryFireAndForget immediately when creating a text_illustration memory', async () => {
      const created = {
        id: 'memory-illustrated-create-1',
        memory_type: 'text_illustration',
        memory_date: '2026-05-26',
        created_at: 'c1',
        illustration_status: 'pending',
        taggedMembers: [],
        mediaAssets: [],
      };
      mockedCreateMemory.mockResolvedValue({ data: created, error: null });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.createMemory({
        content: 'A little illustrated moment',
        memoryDate: '2026-05-26',
        taggedMemberIds: [],
      });

      expect(mockedWarmShareCard).not.toHaveBeenCalled();
    });

    it('still fires warmShareCardForMemoryFireAndForget immediately when creating a text_only memory (nothing async to race)', async () => {
      const created = {
        id: 'memory-text-only-create-1',
        memory_type: 'text_only',
        memory_date: '2026-05-26',
        created_at: 'c1',
        illustration_status: 'none',
        taggedMembers: [],
        mediaAssets: [],
      };
      mockedCreateMemory.mockResolvedValue({ data: created, error: null });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.createMemory({
        content: 'A quiet afternoon',
        memoryDate: '2026-05-26',
        taggedMemberIds: [],
      });

      expect(mockedWarmShareCard).toHaveBeenCalledTimes(1);
      expect(mockedWarmShareCard).toHaveBeenCalledWith(created);
    });

    it('does not await the warm hook -- create resolves even while it hangs forever', async () => {
      mockedWarmShareCard.mockImplementation(() => {
        // Never-resolving inner work: proves the call site does not await
        // this function's side effects (it returns void synchronously).
        void new Promise(() => {});
      });
      mockedCreateMemory.mockResolvedValue({
        data: {
          id: 'memory-text-hang',
          memory_type: 'text_only',
          memory_date: '2026-05-26',
          created_at: 'c1',
          taggedMembers: [],
          mediaAssets: [],
        },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await expect(
        result.current.createMemory({
          content: 'Still saves',
          memoryDate: '2026-05-26',
          taggedMemberIds: [],
        }),
      ).resolves.toMatchObject({ id: 'memory-text-hang' });
    });

    it('does not surface a rejection from the warm hook\'s own internal promise chain', async () => {
      mockedWarmShareCard.mockImplementation(() => {
        // The real implementation is void-returning and swallows its own
        // rejections internally (see share-card.test.ts) -- this simulates
        // that same shape (fire off work, never let a rejection escape the
        // function itself) to prove the call site doesn't need its own
        // try/catch around a void call.
        void Promise.reject(new Error('warm request failed')).catch(() => {});
      });
      mockedCreateMemory.mockResolvedValue({
        data: {
          id: 'memory-text-reject',
          memory_type: 'text_only',
          memory_date: '2026-05-26',
          created_at: 'c1',
          taggedMembers: [],
          mediaAssets: [],
        },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await expect(
        result.current.createMemory({
          content: 'Still saves',
          memoryDate: '2026-05-26',
          taggedMemberIds: [],
        }),
      ).resolves.toMatchObject({ id: 'memory-text-reject' });
    });

    it('fires warmShareCardForMemoryFireAndForget exactly once with the updated memory after an edit', async () => {
      const updated = {
        id: 'memory-1',
        memory_type: 'text_only',
        memory_date: '2026-05-27',
        taggedMembers: [],
        mediaAssets: [],
      };
      mockedUpdateMemory.mockResolvedValue({ data: updated, error: null });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.updateMemory({ memoryId: 'memory-1', memoryDate: '2026-05-27' });

      expect(mockedWarmShareCard).toHaveBeenCalledTimes(1);
      expect(mockedWarmShareCard).toHaveBeenCalledWith(updated);
    });

    it('passes the edited media memory (with mediaAssets) so the warm hook can resolve the cover asset', async () => {
      const updated = {
        id: 'memory-media-1',
        memory_type: 'media',
        media_content_type: 'image/jpeg',
        taggedMembers: [],
        mediaAssets: [{ id: 'media-cover', content_type: 'image/jpeg' }],
      };
      mockedUpdateMemory.mockResolvedValue({ data: updated, error: null });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.updateMemory({ memoryId: 'memory-media-1', content: 'New caption' });

      expect(mockedWarmShareCard).toHaveBeenCalledTimes(1);
      expect(mockedWarmShareCard).toHaveBeenCalledWith(updated);
    });
  });

  describe('fetch-link-previews fire-and-forget (plan §7)', () => {
    it('triggers fetchLinkPreviews after creating a memory whose content contains a URL', async () => {
      mockedCreateMemory.mockResolvedValue({
        data: { id: 'memory-link-1', memory_type: 'text_only', memory_date: '2026-05-26', created_at: 'c1', taggedMembers: [] },
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
        data: { id: 'memory-nolink-1', memory_type: 'text_only', memory_date: '2026-05-26', created_at: 'c1', taggedMembers: [] },
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
        data: { id: 'memory-link-4', memory_type: 'text_only', memory_date: '2026-05-26', created_at: 'c1', taggedMembers: [] },
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

    it('patches link_previews from the fetch-link-previews response instead of invalidating (Workstream A4b)', async () => {
      mockedCreateMemory.mockResolvedValue({
        data: { id: 'memory-link-6', memory_type: 'text_only', memory_date: '2026-05-26', created_at: 'c1', taggedMembers: [] },
        error: null,
      });
      mockedFetchLinkPreviews.mockResolvedValue({
        data: { linkPreviews: { 'https://example.com': { title: 'Example', fetchedAt: '2026-05-26T00:00:00Z' } } },
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
        const patched = result.current.memories.find((m) => m.id === 'memory-link-6');
        expect(patched?.link_previews).toEqual({
          'https://example.com': { title: 'Example', fetchedAt: '2026-05-26T00:00:00Z' },
        });
      });
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
      queryClient.setQueryData(memoriesQueryKey('family-1'), buildInfiniteMemoriesData([buildCachedMemory()]));
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
        memoriesQueryKey('family-1'),
        buildInfiniteMemoriesData([buildCachedMemory({ content: 'Cached copy' })]),
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
      queryClient.setQueryData(memoriesQueryKey('family-1'), buildInfiniteMemoriesData([staleCached]));
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

    it('does not patch to pending when the fresh fetch is stale-looking but the service reports it did not dispatch', async () => {
      // Same O4 bug as useMemories' list recovery effect, but on the detail
      // hook's own recovery effect: the FRESH fetch (not the placeholder)
      // can still look stale to the client while the server already
      // resolved it -- retryMemoryIllustration's early-return response
      // ({error: null, dispatched: false}) must not be treated as license
      // to patch the cache to 'pending'.
      const queryClient = createQueryClient();
      const freshButStale = buildCachedMemory({
        id: 'memory-fresh-stale-detail',
        memory_type: 'text_illustration',
        illustration_status: 'generating',
        updated_at: '2020-01-01T00:00:00Z',
      });
      mockedFetchMemoryById.mockResolvedValue({ data: freshButStale, error: null });
      mockedRetryMemoryIllustration.mockResolvedValue({ error: null, dispatched: false });

      const { result } = renderHook(() => useMemory('memory-fresh-stale-detail'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      await waitFor(() => {
        expect(mockedRetryMemoryIllustration).toHaveBeenCalledWith('memory-fresh-stale-detail');
      });
      // Left exactly as the fetch returned it -- no flash to 'pending'.
      expect(result.current.data?.illustration_status).toBe('generating');
    });

    it('does not fire illustration recovery off data hydrated directly into the detail cache before this mount has completed its own fetch', async () => {
      // O4: this is the case `isPlaceholderData` alone does NOT catch --
      // unlike the list-cache placeholder above (a substitute the query
      // itself materializes), seeding the DETAIL query's own cache entry
      // directly is exactly what PersistQueryClientProvider's restore does.
      // That makes `isPlaceholderData` false immediately (it's real `data`,
      // not a placeholder), so `isFetchedAfterMount` is the only thing still
      // protecting a persisted, days-old 'generating' row from tripping
      // needsIllustrationRecovery before this mount's own network fetch has
      // resolved.
      const queryClient = createQueryClient();
      const hydratedStale = buildCachedMemory({
        id: 'memory-hydrated-stale',
        memory_type: 'text_illustration',
        illustration_status: 'generating',
        updated_at: '2020-01-01T00:00:00Z',
      });
      queryClient.setQueryData(
        memoryDetailQueryKey('family-1', 'memory-hydrated-stale'),
        hydratedStale,
      );
      // Never resolves within this test -- isFetchedAfterMount must stay
      // false for as long as this mount's own fetch hasn't settled.
      mockedFetchMemoryById.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useMemory('memory-hydrated-stale'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      // Confirms this really is the case isPlaceholderData would miss.
      expect(result.current.isPlaceholderData).toBe(false);
      expect(result.current.data?.illustration_status).toBe('generating');

      // Let any microtask-queued effect run before asserting the negative.
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockedRetryMemoryIllustration).not.toHaveBeenCalled();
    });

    it("fires illustration recovery once this mount's own network fetch resolves, even for a row that started out hydrated", async () => {
      const queryClient = createQueryClient();
      const hydratedStale = buildCachedMemory({
        id: 'memory-hydrated-stale-2',
        memory_type: 'text_illustration',
        illustration_status: 'generating',
        updated_at: '2020-01-01T00:00:00Z',
      });
      queryClient.setQueryData(
        memoryDetailQueryKey('family-1', 'memory-hydrated-stale-2'),
        hydratedStale,
      );
      // The fresh fetch confirms the same stale status server-side.
      mockedFetchMemoryById.mockResolvedValue({ data: hydratedStale, error: null });
      mockedRetryMemoryIllustration.mockResolvedValue({ error: null, dispatched: true });

      const { result } = renderHook(() => useMemory('memory-hydrated-stale-2'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      await waitFor(() => {
        expect(mockedRetryMemoryIllustration).toHaveBeenCalledWith('memory-hydrated-stale-2');
      });
      expect(result.current.data?.illustration_status).toBe('pending');
    });

    it("does not seed the detail view from another family's cache", () => {
      const queryClient = createQueryClient();
      queryClient.setQueryData(memoriesQueryKey('family-2'), buildInfiniteMemoriesData([buildCachedMemory()]));
      mockedFetchMemoryById.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useMemory('memory-cached-1'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      expect(result.current.data).toBeUndefined();
      expect(result.current.isLoading).toBe(true);
    });
  });

  // Bug B (docs/plans/share-card-store-through.md's incident follow-up,
  // 20260806140000_share_card_illustration_key_trigger.sql): useMemory's
  // detail-hook effect is one of three independent observers of an
  // illustration ready transition (the shared generation-status poll and
  // useMemoriesRealtime are the other two, covered in their own test
  // files) -- this proves it fires the central
  // handleIllustrationReadyTransition warm on that transition, replacing
  // the premature create-time warm the tests above prove is now skipped.
  describe('illustration ready transition warms the share card (useMemory)', () => {
    it('warms the share card once when the detail query observes a pending/generating -> ready transition', async () => {
      const queryClient = createQueryClient();
      mockedFetchMemoryById
        .mockResolvedValueOnce({
          data: {
            id: 'memory-ready-transition-1',
            memory_type: 'text_illustration',
            illustration_status: 'generating',
            illustration_generation_id: 'gen-detail-1',
            taggedMembers: [],
            mediaAssets: [],
          } as never,
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            id: 'memory-ready-transition-1',
            memory_type: 'text_illustration',
            illustration_status: 'ready',
            illustration_generation_id: 'gen-detail-1',
            taggedMembers: [],
            mediaAssets: [],
          } as never,
          error: null,
        });

      const { result } = renderHook(() => useMemory('memory-ready-transition-1'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      await waitFor(() => expect(result.current.data?.illustration_status).toBe('generating'));
      expect(mockedWarmShareCardFireAndForget).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.refetch();
      });

      await waitFor(() => expect(result.current.data?.illustration_status).toBe('ready'));
      expect(mockedWarmShareCardFireAndForget).toHaveBeenCalledTimes(1);
      expect(mockedWarmShareCardFireAndForget).toHaveBeenCalledWith('memory-ready-transition-1');
    });

    it('does not warm when the first real fetch already shows ready (no prior pending/generating observed this mount)', async () => {
      const queryClient = createQueryClient();
      mockedFetchMemoryById.mockResolvedValue({
        data: {
          id: 'memory-already-ready-1',
          memory_type: 'text_illustration',
          illustration_status: 'ready',
          illustration_generation_id: 'gen-detail-2',
          taggedMembers: [],
          mediaAssets: [],
        } as never,
        error: null,
      });

      const { result } = renderHook(() => useMemory('memory-already-ready-1'), {
        wrapper: createWrapperWithClient(queryClient),
      });

      await waitFor(() => expect(result.current.data?.illustration_status).toBe('ready'));
      expect(mockedWarmShareCardFireAndForget).not.toHaveBeenCalled();
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
      mockedFetchMemoriesPage.mockResolvedValue(pageResult([migrated as never]));
      mockedRunTextOnlyEmotionAnalysis.mockResolvedValue('joy');

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.memories[0]?.emotion).toBe('joy');
      });
      expect(mockedRunTextOnlyEmotionAnalysis).toHaveBeenCalledTimes(1);
      // Patched in place -- page 1 was fetched exactly once, no refetch.
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);
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
      mockedFetchMemoriesPage.mockResolvedValue(pageResult([stale as never]));
      mockedRetryMemoryIllustration.mockResolvedValue({ error: null, dispatched: true });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.memories[0]?.illustration_status).toBe('pending');
      });
      expect(mockedRetryMemoryIllustration).toHaveBeenCalledWith('memory-stale-1');
      expect(mockedRetryMemoryIllustration).toHaveBeenCalledTimes(1);
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);
      // The local cache mirrors the accepted dispatch clock rather than
      // rewriting updated_at, so recovery cannot loop before polling sees the
      // server-owned value.
      expect(
        new Date(result.current.memories[0]?.illustration_generation_started_at ?? 0).getTime(),
      ).toBeGreaterThan(Date.now() - 60_000);
    });

    it('recovers a memory deferred at pending because a portrait was not ready', async () => {
      // Same backstop as the 'generating' case above, but for a memory the
      // server parked at 'pending' (docs/features/memories.md "Illustration
      // deferral") because a tagged member's portrait was still generating.
      // needsIllustrationRecovery treats a stale 'pending' the same as a
      // stale 'generating' -- both go through retryMemoryIllustration.
      const deferred = {
        id: 'memory-deferred-1',
        family_id: 'family-1',
        memory_type: 'text_illustration',
        content: 'Deferred for a not-yet-ready portrait',
        emotion: 'joy',
        illustration_status: 'pending',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        taggedMembers: [],
        mediaAssets: [],
      };
      mockedFetchMemoriesPage.mockResolvedValue(pageResult([deferred as never]));
      // retryMemoryIllustration -> runMemoryIllustrationPipeline resolves
      // PORTRAITS_NOT_READY as success (no error), whether or not the
      // portrait is ready yet by the time this retry lands.
      mockedRetryMemoryIllustration.mockResolvedValue({ error: null, dispatched: true });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(mockedRetryMemoryIllustration).toHaveBeenCalledWith('memory-deferred-1');
      });
      expect(mockedRetryMemoryIllustration).toHaveBeenCalledTimes(1);
      expect(result.current.memories[0]?.illustration_status).toBe('pending');
      // Re-parked with a fresh server-owned generation clock; pending uses
      // its own recovery window rather than the generating threshold --
      // the next recovery attempt is >=3 minutes later, not a tight loop.
      expect(
        new Date(result.current.memories[0]?.illustration_generation_started_at ?? 0).getTime(),
      ).toBeGreaterThan(Date.now() - 60_000);
    });

    it('does NOT patch a stale-looking memory to pending when the service reports it did not actually dispatch (already resolved server-side)', async () => {
      // O4 (docs/plans/offline-awareness-and-share-cards.md): a persisted,
      // hours-old 'generating' row can look stale locally even though the
      // server finished long ago. retryMemoryIllustration's early-return
      // paths (already 'ready', or 'generating' and not stale server-side)
      // resolve {error: null, dispatched: false} -- patching to 'pending'
      // on THAT response would flash a finished illustration back to
      // pending. Only a real dispatch may patch the cache.
      const staleLooking = {
        id: 'memory-stale-2',
        family_id: 'family-1',
        memory_type: 'text_illustration',
        content: 'Actually finished server-side',
        emotion: 'joy',
        illustration_status: 'generating',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        taggedMembers: [],
        mediaAssets: [],
      };
      mockedFetchMemoriesPage.mockResolvedValue(pageResult([staleLooking as never]));
      mockedRetryMemoryIllustration.mockResolvedValue({ error: null, dispatched: false });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(mockedRetryMemoryIllustration).toHaveBeenCalledWith('memory-stale-2');
      });
      // Cache must be left exactly as it was -- no flash to 'pending'.
      expect(result.current.memories[0]?.illustration_status).toBe('generating');
    });
  });

  // The app-foreground reconcile (A4a) trims the timeline cache to page 1
  // before refetching, which is wrong UX if the user is scrolled deep --
  // the caller-supplied shouldReconcileOnForeground getter gates that. These
  // simulate the same AppState 'active' transition app-providers.test.tsx
  // and incoming-share-router.integration.test.tsx use.
  describe('app-foreground reconcile gated by shouldReconcileOnForeground', () => {
    function mockAppStateListener() {
      let handleAppStateChange: ((status: 'active' | 'background') => void) | undefined;
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
        handleAppStateChange = listener as (status: 'active' | 'background') => void;
        return { remove: jest.fn() };
      });
      return (status: 'active' | 'background') => handleAppStateChange?.(status);
    }

    // Marks the cached query stale the way another member's mutation would
    // (refetchType: 'none' only flips isStale, it never refetches itself),
    // then fires the AppState 'active' transition -- each wrapped in its own
    // act()+tick so the hook's isStaleRef has actually caught up with the
    // invalidation before the AppState handler reads it (both updates route
    // through react-query's notifyManager, which batches via a macrotask).
    async function markStaleAndGoActive(
      queryClient: QueryClient,
      fireAppStateChange: (status: 'active' | 'background') => void,
    ) {
      await act(async () => {
        queryClient.invalidateQueries({ queryKey: memoriesQueryKey('family-1'), refetchType: 'none' });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await act(async () => {
        fireAppStateChange('active');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const memoryOne = {
      id: 'memory-1',
      memory_type: 'text_only',
      memory_date: '2026-05-20',
      created_at: '2026-05-20T00:00:00Z',
      taggedMembers: [],
      mediaAssets: [],
    };
    const memoryTwo = {
      id: 'memory-2',
      memory_type: 'text_only',
      memory_date: '2026-05-19',
      created_at: '2026-05-19T00:00:00Z',
      taggedMembers: [],
      mediaAssets: [],
    };

    it('does not trim or refetch when shouldReconcileOnForeground returns false (scrolled deep)', async () => {
      const fireAppStateChange = mockAppStateListener();
      mockedFetchMemoriesPage.mockResolvedValue(pageResult([memoryOne as never]));
      const queryClient = createQueryClient();
      const shouldReconcileOnForeground = jest.fn().mockReturnValue(false);

      const { result } = renderHook(() => useMemories({ shouldReconcileOnForeground }), {
        wrapper: createWrapperWithClient(queryClient),
      });
      await waitFor(() => expect(result.current.memories).toHaveLength(1));
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);

      await markStaleAndGoActive(queryClient, fireAppStateChange);

      expect(shouldReconcileOnForeground).toHaveBeenCalled();
      // Deep-scrolled: reconcile is skipped, no extra fetch, data untouched.
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);
      expect(result.current.memories).toHaveLength(1);
    });

    it('trims to page 1 and refetches when shouldReconcileOnForeground returns true (near top)', async () => {
      const fireAppStateChange = mockAppStateListener();
      mockedFetchMemoriesPage
        .mockResolvedValueOnce(pageResult([memoryOne as never], 'cursor-2'))
        .mockResolvedValueOnce(pageResult([memoryTwo as never]))
        .mockResolvedValue(pageResult([memoryOne as never]));
      const queryClient = createQueryClient();
      const shouldReconcileOnForeground = jest.fn().mockReturnValue(true);

      const { result } = renderHook(() => useMemories({ shouldReconcileOnForeground }), {
        wrapper: createWrapperWithClient(queryClient),
      });
      await waitFor(() => expect(result.current.memories).toHaveLength(1));

      await result.current.fetchNextPage();
      await waitFor(() => expect(result.current.memories).toHaveLength(2));
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(2);

      await markStaleAndGoActive(queryClient, fireAppStateChange);

      await waitFor(() => expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(3));
      expect(shouldReconcileOnForeground).toHaveBeenCalled();
      // Trimmed to page 1 before the refetch -- back down to the one row
      // the third mocked call resolves, not the two loaded pages.
      await waitFor(() => expect(result.current.memories).toHaveLength(1));
      expect(result.current.memories[0]?.id).toBe('memory-1');
    });

    it('reconciles unconditionally when shouldReconcileOnForeground is omitted (previous behavior)', async () => {
      const fireAppStateChange = mockAppStateListener();
      mockedFetchMemoriesPage.mockResolvedValue(pageResult([memoryOne as never]));
      const queryClient = createQueryClient();

      const { result } = renderHook(() => useMemories(), {
        wrapper: createWrapperWithClient(queryClient),
      });
      await waitFor(() => expect(result.current.memories).toHaveLength(1));
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);

      await markStaleAndGoActive(queryClient, fireAppStateChange);

      await waitFor(() => expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(2));
    });
  });

  // Workstream A4b: invalidateMemoryQueries now marks the memories list
  // stale with refetchType: 'none' instead of refetching it -- mutations are
  // responsible for patching in the data they already have. These assert
  // both halves: the cache reflects the mutation's result, AND no page-2+ (or
  // any extra) queryFn call happened to get it there.
  describe('mutation cache patches do not refetch pages (Workstream A4b)', () => {
    it('create prepends the new memory into the timeline cache without an extra page fetch', async () => {
      mockedFetchMemoriesPage.mockResolvedValue(
        pageResult([
          {
            id: 'existing-1',
            memory_type: 'text_only',
            memory_date: '2026-05-20',
            created_at: '2026-05-20T00:00:00Z',
            taggedMembers: [],
            mediaAssets: [],
          } as never,
        ]),
      );
      mockedCreateMemory.mockResolvedValue({
        data: {
          id: 'memory-new',
          memory_type: 'text_only',
          memory_date: '2026-05-26',
          created_at: '2026-05-26T00:00:00Z',
          taggedMembers: [],
          mediaAssets: [],
        },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.memories).toHaveLength(1));

      await result.current.createMemory({
        content: 'New memory',
        memoryDate: '2026-05-26',
        taggedMemberIds: [],
      });

      await waitFor(() => {
        expect(result.current.memories.map((m) => m.id)).toEqual(['memory-new', 'existing-1']);
      });
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);
    });

    it('update patches the returned row into the cache without an extra page fetch', async () => {
      mockedFetchMemoriesPage.mockResolvedValue(
        pageResult([
          {
            id: 'memory-1',
            memory_type: 'text_only',
            memory_date: '2026-05-20',
            created_at: '2026-05-20T00:00:00Z',
            content: 'Original',
            taggedMembers: [],
            mediaAssets: [],
          } as never,
        ]),
      );
      mockedUpdateMemory.mockResolvedValue({
        data: {
          id: 'memory-1',
          memory_type: 'text_only',
          memory_date: '2026-05-20',
          created_at: '2026-05-20T00:00:00Z',
          content: 'Edited',
          taggedMembers: [],
          mediaAssets: [],
        },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.memories).toHaveLength(1));

      await result.current.updateMemory({ memoryId: 'memory-1', content: 'Edited' });

      await waitFor(() => {
        expect(result.current.memories[0]?.content).toBe('Edited');
      });
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);
    });

    it('delete removes the memory from the cache without an extra page fetch', async () => {
      mockedFetchMemoriesPage.mockResolvedValue(
        pageResult([
          {
            id: 'memory-1',
            memory_type: 'text_only',
            memory_date: '2026-05-20',
            created_at: '2026-05-20T00:00:00Z',
            taggedMembers: [],
            mediaAssets: [],
          } as never,
        ]),
      );
      mockedDeleteMemory.mockResolvedValue({ error: null });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.memories).toHaveLength(1));

      await result.current.deleteMemory('memory-1');

      await waitFor(() => expect(result.current.memories).toHaveLength(0));
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);
    });

    it('retry patches illustration_status to pending without an extra page fetch', async () => {
      mockedFetchMemoriesPage.mockResolvedValue(
        pageResult([
          {
            id: 'memory-1',
            memory_type: 'text_illustration',
            memory_date: '2026-05-20',
            created_at: '2026-05-20T00:00:00Z',
            illustration_status: 'failed',
            taggedMembers: [],
            mediaAssets: [],
          } as never,
        ]),
      );
      mockedRetryMemoryIllustration.mockResolvedValue({ error: null, dispatched: true });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.memories).toHaveLength(1));

      await result.current.retryIllustration('memory-1');

      await waitFor(() => {
        expect(result.current.memories[0]?.illustration_status).toBe('pending');
      });
      expect(mockedFetchMemoriesPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('useMemberMemories (Workstream A6)', () => {
    it('fetches a member-filtered page and exposes the result', async () => {
      mockedFetchMemoriesPageForMember.mockResolvedValue(
        pageResult([
          {
            id: 'memory-1',
            memory_type: 'text_only',
            memory_date: '2026-05-20',
            created_at: '2026-05-20T00:00:00Z',
            taggedMembers: [{ id: 'member-1', name: 'Maya' }],
            mediaAssets: [],
          } as never,
        ]),
      );

      const { result } = renderHook(() => useMemberMemories('member-1'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.memories).toHaveLength(1));
      expect(mockedFetchMemoriesPageForMember).toHaveBeenCalledWith(
        'member-1',
        expect.objectContaining({ limit: 40 }),
      );
      // The unfiltered timeline fetch must never run for this hook.
      expect(mockedFetchMemoriesPage).not.toHaveBeenCalled();
    });

    it('does not fetch when there is no memberId yet', () => {
      renderHook(() => useMemberMemories(undefined), { wrapper: createWrapper() });

      expect(mockedFetchMemoriesPageForMember).not.toHaveBeenCalled();
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

      expect(mockedFetchMemoriesPage).not.toHaveBeenCalled();
    });

    it('resolves the regenerate mutation without throwing when portraits are still generating', async () => {
      mockedRegenerateMemoryIllustration.mockResolvedValue({
        error: {
          message: 'Character portraits are still generating — the illustration will finish automatically.',
          code: 'PORTRAITS_NOT_READY',
        },
      });

      const { result } = renderHook(() => useMemoryMutations(), { wrapper: createWrapper() });

      // PORTRAITS_NOT_READY is a deferral, not a failure -- the mutation must
      // resolve (not reject) so the caller can read deferredForPortraits and
      // show a notice instead of a red error state.
      const mutationResult = await result.current.regenerateIllustration('memory-1');

      expect(mutationResult).toEqual({ deferredForPortraits: true });
    });

    it('rejects the regenerate mutation for a genuine error', async () => {
      mockedRegenerateMemoryIllustration.mockResolvedValue({
        error: { message: 'Illustration regeneration is only available for illustrated memories', code: 'invalid_memory_type' },
      });

      const { result } = renderHook(() => useMemoryMutations(), { wrapper: createWrapper() });

      await expect(result.current.regenerateIllustration('memory-1')).rejects.toThrow(
        'Illustration regeneration is only available for illustrated memories',
      );
    });
  });
});
