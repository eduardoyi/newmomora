import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useMemoryEngagement } from './useMemoryEngagement';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { memoriesQueryKey, memoryDetailQueryKey } from '@/hooks/queryKeys';
import {
  createMemoryComment,
  deleteMemoryComment,
  fetchMemoryComments,
  notifyMemoryEngagementFireAndForget,
  setMemoryLike,
} from '@/services/engagement';
import type { MemoryWithTags } from '@/services/memories';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/services/engagement', () => ({
  createMemoryComment: jest.fn(),
  deleteMemoryComment: jest.fn(),
  fetchMemoryComments: jest.fn(),
  notifyMemoryEngagementFireAndForget: jest.fn(),
  setMemoryLike: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedSetMemoryLike = setMemoryLike as jest.MockedFunction<typeof setMemoryLike>;
const mockedFetchComments = fetchMemoryComments as jest.MockedFunction<typeof fetchMemoryComments>;
const mockedCreateComment = createMemoryComment as jest.MockedFunction<typeof createMemoryComment>;
const mockedDeleteComment = deleteMemoryComment as jest.MockedFunction<typeof deleteMemoryComment>;
const mockedNotify = notifyMemoryEngagementFireAndForget as jest.MockedFunction<
  typeof notifyMemoryEngagementFireAndForget
>;

const memory = {
  id: 'memory-1',
  family_id: 'family-1',
  likedByMe: false,
  likeCount: 2,
  commentCount: 0,
  taggedMembers: [],
  mediaAssets: [],
} as MemoryWithTags;

describe('useMemoryEngagement integration', () => {
  let queryClient: QueryClient;
  let wrapper: ({ children }: { children: ReactNode }) => React.JSX.Element;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, gcTime: Infinity },
      },
    });
    wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as never);
    mockedFetchComments.mockResolvedValue({ data: [], error: null });
    mockedSetMemoryLike.mockResolvedValue({
      data: { liked: true, changed: true, likeCount: 3 },
      error: null,
    });
    mockedCreateComment.mockResolvedValue({
      data: {
        id: 'comment-1',
        memory_id: memory.id,
        user_id: 'user-1',
        content: 'Lovely',
        created_at: '2026-07-13T12:00:00Z',
      },
      error: null,
    });
    mockedDeleteComment.mockResolvedValue({ error: null });
    queryClient.setQueryData(memoriesQueryKey('family-1'), [memory]);
    queryClient.setQueryData(memoryDetailQueryKey('family-1', memory.id), memory);
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('patches timeline and detail caches and notifies after a new like', async () => {
    const { result } = renderHook(() => useMemoryEngagement(memory), { wrapper });

    await act(async () => {
      await result.current.toggleLike();
    });

    await waitFor(() => {
      const list = queryClient.getQueryData<MemoryWithTags[]>(memoriesQueryKey('family-1'));
      expect(list?.[0]).toMatchObject({ likedByMe: true, likeCount: 3 });
    });
    expect(queryClient.getQueryData(memoryDetailQueryKey('family-1', memory.id))).toMatchObject({
      likedByMe: true,
      likeCount: 3,
    });
    expect(mockedNotify).toHaveBeenCalledWith(memory.id, 'like');
  });

  it('optimistically increments comment counts and replaces the temporary comment', async () => {
    const { result } = renderHook(
      () => useMemoryEngagement(memory, { commentsEnabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.areCommentsLoading).toBe(false));
    await act(async () => {
      await result.current.addComment('Lovely');
    });

    const list = queryClient.getQueryData<MemoryWithTags[]>(memoriesQueryKey('family-1'));
    expect(list?.[0].commentCount).toBe(1);
    expect(result.current.comments).toEqual([
      expect.objectContaining({ id: 'comment-1', content: 'Lovely' }),
    ]);
    expect(mockedNotify).toHaveBeenCalledWith(memory.id, 'comment', 'comment-1');
  });
});
