import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useMemoriesRealtime } from '@/hooks/useMemoriesRealtime';
import { memoriesQueryKey } from '@/hooks/queryKeys';
import { supabase } from '@/lib/supabase';
import { fetchMemoryById } from '@/services/memories';
import type { Memory, MemoriesPage, MemoryWithTags } from '@/services/memories';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

jest.mock('@/services/memories', () => ({
  fetchMemoryById: jest.fn(),
}));

const mockedChannel = supabase.channel as jest.MockedFunction<typeof supabase.channel>;
const mockedRemoveChannel = supabase.removeChannel as jest.MockedFunction<typeof supabase.removeChannel>;
const mockedFetchMemoryById = fetchMemoryById as jest.MockedFunction<typeof fetchMemoryById>;

const FAMILY_ID = 'family-1';

type Handler = (payload: unknown) => void;
type StatusCallback = (status: string) => void;

interface FakeChannel {
  on: jest.Mock;
  subscribe: jest.Mock;
}

function createFakeChannel() {
  const handlers = new Map<string, Handler>();
  let statusCallback: StatusCallback | undefined;

  const channel: FakeChannel = {
    on: jest.fn((_type: string, filter: { event: string }, callback: Handler) => {
      handlers.set(filter.event, callback);
      return channel;
    }),
    subscribe: jest.fn((callback: StatusCallback) => {
      statusCallback = callback;
      return channel;
    }),
  };

  return {
    channel,
    emit(event: 'UPDATE' | 'INSERT' | 'DELETE', payload: unknown) {
      handlers.get(event)?.(payload);
    },
    setStatus(status: string) {
      statusCallback?.(status);
    },
  };
}

function buildMemoryRow(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'memory-1',
    user_id: 'user-1',
    family_id: FAMILY_ID,
    content: 'Hello',
    memory_date: '2026-07-15',
    memory_type: 'text_illustration',
    emotion: null,
    illustration_key: null,
    illustration_status: 'generating',
    illustration_prompt: null,
    media_key: null,
    media_content_type: null,
    link_previews: {},
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    ...overrides,
  } as Memory;
}

function buildMemoryWithTags(overrides: Partial<MemoryWithTags> = {}): MemoryWithTags {
  return {
    ...buildMemoryRow(),
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

describe('useMemoriesRealtime', () => {
  let queryClient: QueryClient;
  let fake: ReturnType<typeof createFakeChannel>;

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
    fake = createFakeChannel();
    mockedChannel.mockReturnValue(fake.channel as never);
    mockedRemoveChannel.mockResolvedValue('ok' as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('subscribes to a family-scoped channel with UPDATE/INSERT/DELETE postgres_changes filters', () => {
    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    expect(mockedChannel).toHaveBeenCalledWith(`memories-realtime-${FAMILY_ID}`);
    expect(fake.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ event: 'UPDATE', table: 'memories', filter: `family_id=eq.${FAMILY_ID}` }),
      expect.any(Function),
    );
    expect(fake.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ event: 'INSERT', table: 'memories', filter: `family_id=eq.${FAMILY_ID}` }),
      expect.any(Function),
    );
    expect(fake.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ event: 'DELETE', table: 'memories', filter: `family_id=eq.${FAMILY_ID}` }),
      expect.any(Function),
    );
  });

  it('patches illustration/emotion fields into InfiniteData caches on UPDATE', () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemoryWithTags({ illustration_status: 'generating' })]),
    );

    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    fake.emit('UPDATE', {
      new: buildMemoryRow({ illustration_status: 'ready', illustration_key: 'key.webp', emotion: 'joy' }),
      old: { id: 'memory-1' },
    });

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories[0]).toMatchObject({
      illustration_status: 'ready',
      illustration_key: 'key.webp',
      emotion: 'joy',
    });
  });

  it('invalidates media-urls and calendar when an UPDATE transitions to ready', () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemoryWithTags({ illustration_status: 'generating' })]),
    );
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    fake.emit('UPDATE', {
      new: buildMemoryRow({ illustration_status: 'ready', illustration_key: 'key.webp' }),
      old: { id: 'memory-1' },
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['media-urls'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['calendar-memories'] });
  });

  it('does not invalidate media-urls when the row was not previously generating', () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemoryWithTags({ illustration_status: 'ready' })]),
    );
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });
    invalidateSpy.mockClear();

    // A content-only edit UPDATE on an already-ready memory.
    fake.emit('UPDATE', { new: buildMemoryRow({ illustration_status: 'ready', content: 'Edited' }), old: {} });

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['media-urls'] });
  });

  it('delays the INSERT enrichment fetch and prepends the enriched row', async () => {
    const inserted = buildMemoryWithTags({ id: 'memory-2', memory_type: 'text_only' });
    mockedFetchMemoryById.mockResolvedValue({ data: inserted, error: null });
    queryClient.setQueryData(memoriesQueryKey(FAMILY_ID), buildInfiniteData([]));

    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    fake.emit('INSERT', { new: buildMemoryRow({ id: 'memory-2', memory_type: 'text_only' }), old: {} });

    // Not fetched yet -- still inside the delay window.
    expect(mockedFetchMemoryById).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1500);

    expect(mockedFetchMemoryById).toHaveBeenCalledWith('memory-2');
    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories.some((memory) => memory.id === 'memory-2')).toBe(true);
  });

  it('skips the enrichment fetch when the INSERT row is already cached (own-device echo)', async () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemoryWithTags({ id: 'memory-2' })]),
    );

    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    fake.emit('INSERT', { new: buildMemoryRow({ id: 'memory-2' }), old: {} });
    await jest.advanceTimersByTimeAsync(3000);

    expect(mockedFetchMemoryById).not.toHaveBeenCalled();
  });

  it('retries once when a media INSERT races its own media-asset insert', async () => {
    const emptyMedia = buildMemoryWithTags({ id: 'memory-3', memory_type: 'media', mediaAssets: [] });
    const withMedia = buildMemoryWithTags({
      id: 'memory-3',
      memory_type: 'media',
      mediaAssets: [
        {
          id: 'asset-1',
          memory_id: 'memory-3',
          object_key: 'k',
          content_type: 'image/jpeg',
          duration_ms: null,
          aspect_ratio: null,
          preview_object_key: null,
          position: 0,
          created_at: '2026-07-15T00:00:00.000Z',
          updated_at: '2026-07-15T00:00:00.000Z',
        },
      ],
    });
    mockedFetchMemoryById.mockResolvedValueOnce({ data: emptyMedia, error: null });
    mockedFetchMemoryById.mockResolvedValueOnce({ data: withMedia, error: null });
    queryClient.setQueryData(memoriesQueryKey(FAMILY_ID), buildInfiniteData([]));

    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    fake.emit('INSERT', { new: buildMemoryRow({ id: 'memory-3', memory_type: 'media' }), old: {} });
    await jest.advanceTimersByTimeAsync(1500); // initial fetch fires, comes back empty
    await jest.advanceTimersByTimeAsync(1500); // retry fires

    expect(mockedFetchMemoryById).toHaveBeenCalledTimes(2);
    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories[0]?.mediaAssets).toHaveLength(1);
  });

  it('removes the memory from list caches on DELETE', () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemoryWithTags({ id: 'memory-1' }), buildMemoryWithTags({ id: 'memory-2' })]),
    );

    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    fake.emit('DELETE', { new: {}, old: { id: 'memory-1' } });

    const list = queryClient.getQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(FAMILY_ID));
    expect(list?.pages[0]?.memories.map((memory) => memory.id)).toEqual(['memory-2']);
  });

  it('forces a generation-status poll reconcile on every SUBSCRIBED transition', () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });
    fake.setStatus('SUBSCRIBED');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['generation-status', FAMILY_ID] });
  });

  it('cleans up the channel and pending insert timers on unmount', () => {
    const { unmount } = renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    fake.emit('INSERT', { new: buildMemoryRow({ id: 'memory-9' }), old: {} });
    unmount();

    expect(mockedRemoveChannel).toHaveBeenCalledWith(fake.channel);

    // The pending INSERT timer must not fire post-unmount (would otherwise
    // patch a cache no observer is watching, or throw on a torn-down effect).
    jest.advanceTimersByTime(5000);
    expect(mockedFetchMemoryById).not.toHaveBeenCalled();
  });

  it('does nothing when familyId is null/undefined', () => {
    renderHook(() => useMemoriesRealtime(null), { wrapper });
    expect(mockedChannel).not.toHaveBeenCalled();
  });
});
