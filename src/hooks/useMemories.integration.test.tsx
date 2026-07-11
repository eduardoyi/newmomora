import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useMemories } from '@/hooks/useMemories';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  createMediaMemory,
  createMemory,
  fetchMemories,
  runMediaPhotoEmotionAnalysis,
  updateMemory,
} from '@/services/memories';
import { uploadMediaObject } from '@/services/media';
import { notifyFamilyActivity } from '@/services/ai';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
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
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedFetchMemories = fetchMemories as jest.MockedFunction<typeof fetchMemories>;
const mockedCreateMemory = createMemory as jest.MockedFunction<typeof createMemory>;
const mockedCreateMediaMemory = createMediaMemory as jest.MockedFunction<typeof createMediaMemory>;
const mockedUpdateMemory = updateMemory as jest.MockedFunction<typeof updateMemory>;
const mockedRunMediaPhotoEmotionAnalysis = runMediaPhotoEmotionAnalysis as jest.MockedFunction<
  typeof runMediaPhotoEmotionAnalysis
>;
const mockedUploadMediaObject = uploadMediaObject as jest.MockedFunction<typeof uploadMediaObject>;
const mockedNotifyFamilyActivity = notifyFamilyActivity as jest.MockedFunction<
  typeof notifyFamilyActivity
>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
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

    mockedFetchMemories.mockResolvedValue({ data: [], error: null });
    mockedUploadMediaObject.mockResolvedValue({
      data: { objectKey: 'key', success: true },
      error: null,
    });
    mockedNotifyFamilyActivity.mockResolvedValue({ data: { sent: true }, error: null });
  });

  it('runs photo emotion analysis after creating a photo media memory', async () => {
    mockedCreateMediaMemory.mockResolvedValue({
      data: {
        id: 'memory-photo-1',
        memory_type: 'media',
        media_content_type: 'image/jpeg',
        emotion: null,
        taggedMembers: [],
        mediaAssets: [{ content_type: 'image/jpeg' }],
      },
      error: null,
    });

    const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await result.current.createMediaMemory({
      memoryId: 'memory-photo-1',
      mediaAssets: [{
        mediaAssetId: 'asset-photo-1',
        fileUri: 'file:///photo.jpg',
        contentType: 'image/jpeg',
      }],
      memoryDate: '2026-05-26',
      taggedMemberIds: [],
    });

    expect(mockedUploadMediaObject).toHaveBeenCalledWith(
      expect.stringMatching(
        /^user-1\/memories\/memory-photo-1\/media\/[0-9a-f-]{36}\.jpg$/i,
      ),
      'file:///photo.jpg',
      'image/jpeg',
      'family-1',
    );
    expect(mockedUploadMediaObject.mock.calls[0]?.[0]).not.toContain('asset-photo-1');

    await waitFor(() => {
      expect(mockedRunMediaPhotoEmotionAnalysis).toHaveBeenCalledWith('memory-photo-1');
    });
  });

  it('skips photo emotion analysis for video media memories', async () => {
    mockedCreateMediaMemory.mockResolvedValue({
      data: {
        id: 'memory-video-1',
        memory_type: 'media',
        media_content_type: 'video/mp4',
        emotion: null,
        taggedMembers: [],
        mediaAssets: [{ content_type: 'video/mp4' }],
      },
      error: null,
    });

    const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await result.current.createMediaMemory({
      memoryId: 'memory-video-1',
      mediaAssets: [{
        mediaAssetId: 'asset-video-1',
        fileUri: 'file:///clip.mp4',
        contentType: 'video/mp4',
      }],
      memoryDate: '2026-05-26',
      taggedMemberIds: [],
    });

    expect(mockedRunMediaPhotoEmotionAnalysis).not.toHaveBeenCalled();
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

    it('fires notify-family-activity after a successful media memory create', async () => {
      mockedCreateMediaMemory.mockResolvedValue({
        data: {
          id: 'memory-photo-4',
          memory_type: 'media',
          media_content_type: 'image/jpeg',
          emotion: null,
          taggedMembers: [],
          mediaAssets: [{ content_type: 'image/jpeg' }],
        },
        error: null,
      });

      const { result } = renderHook(() => useMemories(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await result.current.createMediaMemory({
        memoryId: 'memory-photo-4',
        mediaAssets: [{
          mediaAssetId: 'asset-photo-4',
          fileUri: 'file:///photo4.jpg',
          contentType: 'image/jpeg',
        }],
        memoryDate: '2026-05-26',
        taggedMemberIds: [],
      });

      await waitFor(() => {
        expect(mockedNotifyFamilyActivity).toHaveBeenCalledWith('memory-photo-4');
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
});
