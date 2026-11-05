import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { portraitVersionsQueryKey } from '@/hooks/queryKeys';
import { resetRealtimeStatusForTests, useIsPortraitRealtimeLive } from '@/hooks/realtime-status';
import { usePortraitVersionsRealtime } from '@/hooks/usePortraitVersionsRealtime';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

const mockedChannel = supabase.channel as jest.MockedFunction<typeof supabase.channel>;
const mockedRemoveChannel = supabase.removeChannel as jest.MockedFunction<typeof supabase.removeChannel>;

type Handler = (payload: unknown) => void;
type StatusCallback = (status: string) => void;

function createFakeChannel() {
  let handler: Handler | undefined;
  let statusCallback: StatusCallback | undefined;
  const channel = {
    on: jest.fn((_type: string, _filter: unknown, callback: Handler) => {
      handler = callback;
      return channel;
    }),
    subscribe: jest.fn((callback: StatusCallback) => {
      statusCallback = callback;
      return channel;
    }),
  };
  return {
    channel,
    emit(payload: unknown) {
      handler?.(payload);
    },
    setStatus(status: string) {
      statusCallback?.(status);
    },
  };
}

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    family_id: 'family-1',
    family_member_id: 'member-1',
    illustrated_profile_status: 'generating',
    generation_token: 'token-1',
    generation_started_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    deletion_token: null,
    ...overrides,
  };
}

describe('usePortraitVersionsRealtime', () => {
  let queryClient: QueryClient;
  let fakes: ReturnType<typeof createFakeChannel>[];
  let invalidateSpy: jest.SpyInstance;

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetRealtimeStatusForTests();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    fakes = [];
    mockedChannel.mockImplementation((() => {
      const fake = createFakeChannel();
      fakes.push(fake);
      return fake.channel;
    }) as never);
    mockedRemoveChannel.mockResolvedValue('ok' as never);
  });

  it('subscribes once per family with the family_id filter', () => {
    const { rerender } = renderHook(({ id }) => usePortraitVersionsRealtime(id), {
      wrapper,
      initialProps: { id: 'family-1' },
    });
    rerender({ id: 'family-1' });

    expect(mockedChannel).toHaveBeenCalledTimes(1);
    expect(mockedChannel).toHaveBeenCalledWith('portrait-versions-realtime-family-1');
    expect(fakes[0].channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        event: '*',
        schema: 'public',
        table: 'family_member_portrait_versions',
        filter: 'family_id=eq.family-1',
      }),
      expect.any(Function),
    );
  });

  it('does not subscribe without a family', () => {
    renderHook(() => usePortraitVersionsRealtime(null), { wrapper });
    expect(mockedChannel).not.toHaveBeenCalled();
  });

  it('flips the live flag on SUBSCRIBED and back on channel failure', () => {
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });
    const live = renderHook(() => useIsPortraitRealtimeLive('family-1'));
    expect(live.result.current).toBe(false);

    act(() => fakes[0].setStatus('SUBSCRIBED'));
    expect(live.result.current).toBe(true);

    for (const status of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) {
      act(() => fakes[0].setStatus('SUBSCRIBED'));
      expect(live.result.current).toBe(true);
      act(() => fakes[0].setStatus(status));
      expect(live.result.current).toBe(false);
    }
  });

  it('refetches only the portrait query on a non-terminal UPDATE', () => {
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [version()]);
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    fakes[0].emit({
      eventType: 'UPDATE',
      new: version({ illustrated_profile_status: 'generating', generation_token: 'token-2' }),
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: portraitVersionsQueryKey('family-1') });
  });

  it('invalidates the family members and memories consumers when a version becomes ready', () => {
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [version()]);
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    fakes[0].emit({
      eventType: 'UPDATE',
      new: version({ illustrated_profile_status: 'ready', generation_token: null }),
    });

    const keys = invalidateSpy.mock.calls.map(([filters]) => filters.queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(['portrait-versions', 'family-members', 'memories']));
  });

  it('invalidates consumers when a version fails, and not again for later ready-state updates', () => {
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [version({ illustrated_profile_status: 'ready' })]);
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    // A date edit on an already-ready row: list refresh only.
    fakes[0].emit({ eventType: 'UPDATE', new: version({ illustrated_profile_status: 'ready' }) });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    invalidateSpy.mockClear();
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [version()]);
    fakes[0].emit({ eventType: 'UPDATE', new: version({ illustrated_profile_status: 'failed' }) });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
  });

  it('fans out to the consumers when a living-portrait sheet becomes ready', () => {
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [
      version({ illustrated_profile_status: 'ready', generation_token: null, motion_status: 'pending', motion_key: null }),
    ]);
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    fakes[0].emit({
      eventType: 'UPDATE',
      new: version({
        illustrated_profile_status: 'ready',
        generation_token: null,
        motion_status: 'ready',
        motion_key: 'motion-1.webp',
      }),
    });

    const keys = invalidateSpy.mock.calls.map(([filters]) => filters.queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(['portrait-versions', 'family-members', 'memories']));
  });

  it('fans out when a cache that predates the motion columns first sees a ready sheet', () => {
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [
      version({ illustrated_profile_status: 'ready', generation_token: null }),
    ]);
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    fakes[0].emit({
      eventType: 'UPDATE',
      new: version({
        illustrated_profile_status: 'ready',
        generation_token: null,
        motion_status: 'ready',
        motion_key: 'motion-1.webp',
      }),
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(3);
  });

  it('fans out when the motion_key is replaced or cleared', () => {
    const ready = { illustrated_profile_status: 'ready', generation_token: null, motion_status: 'ready' };
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [version({ ...ready, motion_key: 'motion-1.webp' })]);
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    fakes[0].emit({ eventType: 'UPDATE', new: version({ ...ready, motion_key: 'motion-2.webp' }) });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);

    invalidateSpy.mockClear();
    fakes[0].emit({
      eventType: 'UPDATE',
      new: version({ ...ready, motion_status: 'pending', motion_key: null }),
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
  });

  it('does not fan out for unchanged or in-flight motion on an already-ready still', () => {
    const ready = { illustrated_profile_status: 'ready', generation_token: null };
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [
      version({ ...ready, motion_status: 'ready', motion_key: 'motion-1.webp' }),
    ]);
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    // Unrelated edit; motion untouched.
    fakes[0].emit({
      eventType: 'UPDATE',
      new: version({ ...ready, motion_status: 'ready', motion_key: 'motion-1.webp' }),
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    // Pending / failed motion with no key is not a signal to the consumers.
    invalidateSpy.mockClear();
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [version({ ...ready })]);
    fakes[0].emit({ eventType: 'UPDATE', new: version({ ...ready, motion_status: 'pending', motion_key: null }) });
    fakes[0].emit({ eventType: 'UPDATE', new: version({ ...ready, motion_status: 'failed', motion_key: null }) });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it('refreshes the list on INSERT and the consumers on DELETE', () => {
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    fakes[0].emit({ eventType: 'INSERT', new: version({ illustrated_profile_status: 'pending' }) });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    invalidateSpy.mockClear();
    fakes[0].emit({ eventType: 'DELETE', old: { id: 'v1' } });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
  });

  it('reconciles on SUBSCRIBED only for a rejoin or an active cached version', () => {
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    // Cold start with nothing cached: no double fetch.
    act(() => fakes[0].setStatus('SUBSCRIBED'));
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Rejoin after a drop: reconcile missed events.
    act(() => fakes[0].setStatus('CLOSED'));
    act(() => fakes[0].setStatus('SUBSCRIBED'));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: portraitVersionsQueryKey('family-1') });
  });

  it('reconciles on the first SUBSCRIBED when an active version is already cached', () => {
    queryClient.setQueryData(portraitVersionsQueryKey('family-1'), [version()]);
    renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });

    act(() => fakes[0].setStatus('SUBSCRIBED'));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: portraitVersionsQueryKey('family-1') });
  });

  it('removes the channel and clears the live flag on unmount', () => {
    const { unmount } = renderHook(() => usePortraitVersionsRealtime('family-1'), { wrapper });
    const live = renderHook(() => useIsPortraitRealtimeLive('family-1'));
    act(() => fakes[0].setStatus('SUBSCRIBED'));
    expect(live.result.current).toBe(true);

    unmount();

    expect(mockedRemoveChannel).toHaveBeenCalledWith(fakes[0].channel);
    expect(live.result.current).toBe(false);
  });

  it('swaps channels on a family switch and ignores events from the old one', () => {
    const { rerender } = renderHook(({ id }) => usePortraitVersionsRealtime(id), {
      wrapper,
      initialProps: { id: 'family-1' },
    });
    rerender({ id: 'family-2' });

    expect(mockedRemoveChannel).toHaveBeenCalledWith(fakes[0].channel);
    expect(mockedChannel).toHaveBeenLastCalledWith('portrait-versions-realtime-family-2');
    expect(fakes[1].channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ filter: 'family_id=eq.family-2' }),
      expect.any(Function),
    );

    // A late status from the torn-down channel must not mark the new one live.
    const live = renderHook(() => useIsPortraitRealtimeLive('family-2'));
    act(() => fakes[0].setStatus('SUBSCRIBED'));
    expect(live.result.current).toBe(false);
  });
});
