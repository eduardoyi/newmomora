import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useGenerationStatusPolling } from '@/hooks/useGenerationStatusPolling';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { memoriesQueryKey } from '@/hooks/queryKeys';
import {
  clearRealtimeStatus,
  resetRealtimeStatusForTests,
  setRealtimeLive,
} from '@/hooks/realtime-status';
import { fetchMemoryGenerationStatuses } from '@/services/memories';
import type { MemoriesPage, MemoryWithTags } from '@/services/memories';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/services/memories', () => ({
  fetchMemoryGenerationStatuses: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedFetchStatuses = fetchMemoryGenerationStatuses as jest.MockedFunction<
  typeof fetchMemoryGenerationStatuses
>;

const FAMILY_ID = 'family-1';

function buildMemory(overrides: Partial<MemoryWithTags> = {}): MemoryWithTags {
  return {
    id: 'memory-1',
    user_id: 'user-1',
    family_id: FAMILY_ID,
    content: 'Hello',
    memory_date: '2026-05-24',
    memory_type: 'text_illustration',
    emotion: 'joy',
    illustration_key: null,
    illustration_status: 'none',
    illustration_prompt: null,
    media_key: null,
    media_content_type: null,
    link_previews: {},
    created_at: '2026-05-24T00:00:00.000Z',
    updated_at: '2026-05-24T00:00:00.000Z',
    taggedMembers: [],
    mediaAssets: [],
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    ...overrides,
  } as MemoryWithTags;
}

function buildInfiniteData(memories: MemoryWithTags[]): InfiniteData<MemoriesPage> {
  return { pages: [{ memories, nextCursor: null }], pageParams: [null] };
}

describe('useGenerationStatusPolling', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetRealtimeStatusForTests();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: FAMILY_ID } as never);
    mockedFetchStatuses.mockResolvedValue({ data: [], error: null });
  });

  afterEach(() => {
    jest.useRealTimers();
    resetRealtimeStatusForTests();
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it('never fetches statuses when nothing tracked needs generation', async () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemory({ id: 'memory-1', illustration_status: 'ready' })]),
    );

    renderHook(() => useGenerationStatusPolling(), { wrapper });

    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockedFetchStatuses).not.toHaveBeenCalled();
  });

  it('polls the pending id, patches the cache on change, and stops once ready', async () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemory({ id: 'memory-1', illustration_status: 'pending' })]),
    );
    mockedFetchStatuses.mockResolvedValue({
      data: [
        {
          id: 'memory-1',
          illustration_status: 'ready',
          illustration_key: 'user-1/memories/memory-1/illustration.webp',
          emotion: 'joy',
          updated_at: '2026-05-24T00:00:01.000Z',
        },
      ],
      error: null,
    });

    renderHook(() => useGenerationStatusPolling(), { wrapper });

    await waitFor(() => expect(mockedFetchStatuses).toHaveBeenCalledWith(['memory-1']));

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories[0]).toMatchObject({
      illustration_status: 'ready',
      illustration_key: 'user-1/memories/memory-1/illustration.webp',
    });

    // Nothing left pending after the patch above -- a later tick must not
    // fetch again.
    mockedFetchStatuses.mockClear();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockedFetchStatuses).not.toHaveBeenCalled();
  });

  it('invalidates media-urls and calendar when a status transitions to ready', async () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemory({ id: 'memory-1', illustration_status: 'generating' })]),
    );
    mockedFetchStatuses.mockResolvedValue({
      data: [
        {
          id: 'memory-1',
          illustration_status: 'ready',
          illustration_key: 'key.webp',
          emotion: 'joy',
          updated_at: '2026-05-24T00:00:01.000Z',
        },
      ],
      error: null,
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useGenerationStatusPolling(), { wrapper });

    await waitFor(() => expect(mockedFetchStatuses).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['media-urls'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['calendar-memories'] });
  });

  // Wake-from-idle (subtle per the plan): refetchInterval is only
  // re-evaluated by react-query on the poll query's own update, or when its
  // observer's setOptions() runs again -- which happens on every render of
  // whatever mounted the hook. In production that's useMemories/
  // useCalendarMemoriesInRange re-rendering because their OWN list query
  // updated; simulate that here by patching a pending memory into the list
  // cache the poll reads from and then forcing a re-render of this hook's
  // host, the same way a parent component re-rendering would.
  it('wakes from idle once a new pending memory appears and the host re-renders', async () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemory({ id: 'memory-1', illustration_status: 'ready' })]),
    );

    const { rerender } = renderHook(() => useGenerationStatusPolling(), { wrapper });

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockedFetchStatuses).not.toHaveBeenCalled();

    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([
        buildMemory({ id: 'memory-1', illustration_status: 'ready' }),
        buildMemory({ id: 'memory-2', illustration_status: 'pending' }),
      ]),
    );
    rerender({});
    await jest.advanceTimersByTimeAsync(3000);

    await waitFor(() => expect(mockedFetchStatuses).toHaveBeenCalledWith(['memory-2']));
  });

  // D3: suppression must be reactive in BOTH directions -- a plain ref would
  // pass "goes quiet while realtime is live" trivially but never wake back
  // up, since refetchInterval callbacks are only re-evaluated on a query
  // update or an observer re-render (see the comment in
  // useGenerationStatusPolling.ts). useIsRealtimeLive (useSyncExternalStore)
  // re-renders this hook's own observer on every flip, which is what forces
  // react-query to re-evaluate refetchInterval here.
  it('does not schedule periodic polling while realtime is live for this family', async () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemory({ id: 'memory-1', illustration_status: 'pending' })]),
    );
    act(() => setRealtimeLive(FAMILY_ID, true));

    renderHook(() => useGenerationStatusPolling(), { wrapper });

    // A freshly-mounted, enabled query always runs its queryFn once
    // regardless of refetchInterval -- this single call is also what D2's
    // SUBSCRIBED-transition invalidateQueries leans on to force a reconcile
    // tick. What suppression actually disables is the PERIODIC 3s/5s
    // refetchInterval tick that would otherwise follow it.
    await waitFor(() => expect(mockedFetchStatuses).toHaveBeenCalledTimes(1));

    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockedFetchStatuses).toHaveBeenCalledTimes(1);
  });

  it('resumes polling once realtime goes down (CHANNEL_ERROR/TIMED_OUT/CLOSED)', async () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemory({ id: 'memory-1', illustration_status: 'pending' })]),
    );
    act(() => setRealtimeLive(FAMILY_ID, true));

    renderHook(() => useGenerationStatusPolling(), { wrapper });
    await waitFor(() => expect(mockedFetchStatuses).toHaveBeenCalledTimes(1));

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockedFetchStatuses).toHaveBeenCalledTimes(1);

    // useMemoriesRealtime calls clearRealtimeStatus on CHANNEL_ERROR/
    // TIMED_OUT/CLOSED -- simulate that transition directly against the
    // shared store rather than mocking the realtime hook.
    mockedFetchStatuses.mockClear();
    act(() => clearRealtimeStatus(FAMILY_ID));
    await jest.advanceTimersByTimeAsync(3000);

    await waitFor(() => expect(mockedFetchStatuses).toHaveBeenCalledWith(['memory-1']));
  });
});
