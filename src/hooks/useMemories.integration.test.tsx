import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useMemories } from '@/hooks/useMemories';
import { useAuth } from '@/hooks/use-auth';
import { useUserProfile } from '@/hooks/useUserProfile';
import {
  createMediaMemory,
  fetchMemories,
  runMediaPhotoEmotionAnalysis,
  updateMemory,
} from '@/services/memories';
import { uploadMediaObject } from '@/services/media';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: jest.fn(),
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

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;
const mockedFetchMemories = fetchMemories as jest.MockedFunction<typeof fetchMemories>;
const mockedCreateMediaMemory = createMediaMemory as jest.MockedFunction<typeof createMediaMemory>;
const mockedUpdateMemory = updateMemory as jest.MockedFunction<typeof updateMemory>;
const mockedRunMediaPhotoEmotionAnalysis = runMediaPhotoEmotionAnalysis as jest.MockedFunction<
  typeof runMediaPhotoEmotionAnalysis
>;
const mockedUploadMediaObject = uploadMediaObject as jest.MockedFunction<typeof uploadMediaObject>;

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
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
      resetPassword: jest.fn(),
    });

    mockedUseUserProfile.mockReturnValue({
      profile: { active_family_id: 'family-1' } as never,
    } as never);

    mockedFetchMemories.mockResolvedValue({ data: [], error: null });
    mockedUploadMediaObject.mockResolvedValue({
      data: { objectKey: 'key', success: true },
      error: null,
    });
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
});
