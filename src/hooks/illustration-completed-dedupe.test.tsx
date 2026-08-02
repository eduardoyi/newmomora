// Integration coverage for docs/plans/analytics-implementation.md WP3 item
// 3: useGenerationStatusPolling and useMemoriesRealtime can both observe the
// SAME ready/failed transition for a memory (a realtime SUBSCRIBED forces a
// poll tick), and the shared `shouldReportIllustrationOutcome` singleton
// (src/lib/illustration-outcome-dedupe.ts) must keep `illustration_completed`
// to exactly one report for that pair -- never zero, never two. Uses the
// REAL dedupe module (not mocked) so the cross-hook singleton behavior is
// actually exercised, the same way the two hooks share it in production.
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useGenerationStatusPolling } from '@/hooks/useGenerationStatusPolling';
import { useMemoriesRealtime } from '@/hooks/useMemoriesRealtime';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { memoriesQueryKey } from '@/hooks/queryKeys';
import { resetRealtimeStatusForTests } from '@/hooks/realtime-status';
import { supabase } from '@/lib/supabase';
import { trackEvent } from '@/services/analytics';
import { fetchMemoryById, fetchMemoryGenerationStatuses } from '@/services/memories';
import type { Memory, MemoriesPage, MemoryWithTags } from '@/services/memories';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));
jest.mock('@/services/memories', () => ({
  fetchMemoryGenerationStatuses: jest.fn(),
  fetchMemoryById: jest.fn(),
}));
jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedChannel = supabase.channel as jest.MockedFunction<typeof supabase.channel>;
const mockedRemoveChannel = supabase.removeChannel as jest.MockedFunction<typeof supabase.removeChannel>;
const mockedFetchStatuses = fetchMemoryGenerationStatuses as jest.MockedFunction<
  typeof fetchMemoryGenerationStatuses
>;
const mockedFetchMemoryById = fetchMemoryById as jest.MockedFunction<typeof fetchMemoryById>;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

const FAMILY_ID = 'family-1';
const MEMORY_ID = 'memory-double-observed-1';

function buildMemoryRow(overrides: Partial<Memory> = {}): Memory {
  return {
    id: MEMORY_ID,
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

interface FakeChannel {
  on: jest.Mock;
  subscribe: jest.Mock;
}

function createFakeChannel() {
  const handlers = new Map<string, (payload: unknown) => void>();

  const channel: FakeChannel = {
    on: jest.fn((_type: string, filter: { event: string }, callback: (payload: unknown) => void) => {
      handlers.set(filter.event, callback);
      return channel;
    }),
    subscribe: jest.fn(() => channel),
  };

  return {
    channel,
    emit(event: 'UPDATE' | 'INSERT' | 'DELETE', payload: unknown) {
      handlers.get(event)?.(payload);
    },
  };
}

describe('illustration_completed cross-hook dedupe (poll + realtime double-observation)', () => {
  let queryClient: QueryClient;
  let fake: ReturnType<typeof createFakeChannel>;

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

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
    fake = createFakeChannel();
    mockedChannel.mockReturnValue(fake.channel as never);
    mockedRemoveChannel.mockResolvedValue('ok' as never);
    mockedFetchMemoryById.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => {
    jest.useRealTimers();
    resetRealtimeStatusForTests();
  });

  it('fires illustration_completed exactly once when the poll and realtime both observe the same ready transition', async () => {
    queryClient.setQueryData(
      memoriesQueryKey(FAMILY_ID),
      buildInfiniteData([buildMemoryWithTags({ illustration_status: 'generating' })]),
    );
    mockedFetchStatuses.mockResolvedValue({
      data: [
        {
          id: MEMORY_ID,
          illustration_status: 'ready',
          illustration_key: 'key.webp',
          emotion: 'joy',
          updated_at: '2026-07-15T00:00:01.000Z',
        },
      ],
      error: null,
    });

    // Both hooks mounted together, sharing the same QueryClient and the same
    // module-level dedupe singleton -- exactly as they're both mounted for
    // the whole authenticated session in production.
    renderHook(() => useGenerationStatusPolling(), { wrapper });
    renderHook(() => useMemoriesRealtime(FAMILY_ID), { wrapper });

    // The poll observes the transition first.
    await waitFor(() =>
      expect(mockedTrackEvent).toHaveBeenCalledWith('illustration_completed', { outcome: 'ready' }),
    );

    // Realtime now observes the SAME transition via its own UPDATE event
    // (e.g. the same underlying row change, or the SUBSCRIBED-triggered
    // reconcile poll tick landing after realtime's own patch already applied
    // it) -- the dedupe singleton must suppress this second report.
    fake.emit('UPDATE', {
      new: buildMemoryRow({ illustration_status: 'ready', illustration_key: 'key.webp' }),
      old: { id: MEMORY_ID },
    });

    expect(mockedTrackEvent).toHaveBeenCalledTimes(1);
  });
});
