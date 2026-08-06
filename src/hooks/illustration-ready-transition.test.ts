import { QueryClient } from '@tanstack/react-query';

const mockWarmShareCardFireAndForget = jest.fn();
jest.mock('@/services/share-card', () => ({
  warmShareCardFireAndForget: (...args: unknown[]) => mockWarmShareCardFireAndForget(...args),
}));

import { handleIllustrationReadyTransition } from '@/hooks/illustration-ready-transition';
import { calendarMemoriesQueryKeyBase } from '@/hooks/queryKeys';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
}

describe('handleIllustrationReadyTransition', () => {
  beforeEach(() => {
    mockWarmShareCardFireAndForget.mockClear();
  });

  it('invalidates media-urls and calendar queries', () => {
    const queryClient = createQueryClient();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    handleIllustrationReadyTransition(queryClient, 'ready-memory-1', 'gen-1');

    expect(spy).toHaveBeenCalledWith({ queryKey: ['media-urls'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: [calendarMemoriesQueryKeyBase] });
  });

  it('warms the share card once for a given memory + illustration_generation_id', () => {
    const queryClient = createQueryClient();

    handleIllustrationReadyTransition(queryClient, 'ready-memory-2', 'gen-1');

    expect(mockWarmShareCardFireAndForget).toHaveBeenCalledTimes(1);
    expect(mockWarmShareCardFireAndForget).toHaveBeenCalledWith('ready-memory-2');
  });

  it('dedupes the warm across the three independent observers of the same transition (detail hook, poll, realtime)', () => {
    const queryClient = createQueryClient();

    // Simulates all three call sites -- useMemory's ready-transition effect,
    // useGenerationStatusPolling's applyStatusPatches, and
    // useMemoriesRealtime's UPDATE handler -- observing the SAME ready
    // transition for the same memory.
    handleIllustrationReadyTransition(queryClient, 'ready-memory-3', 'gen-1');
    handleIllustrationReadyTransition(queryClient, 'ready-memory-3', 'gen-1');
    handleIllustrationReadyTransition(queryClient, 'ready-memory-3', 'gen-1');

    expect(mockWarmShareCardFireAndForget).toHaveBeenCalledTimes(1);
  });

  it('warms again for a later regeneration (a new illustration_generation_id on the same memory)', () => {
    const queryClient = createQueryClient();

    handleIllustrationReadyTransition(queryClient, 'ready-memory-4', 'gen-1');
    handleIllustrationReadyTransition(queryClient, 'ready-memory-4', 'gen-2');

    expect(mockWarmShareCardFireAndForget).toHaveBeenCalledTimes(2);
    expect(mockWarmShareCardFireAndForget).toHaveBeenNthCalledWith(1, 'ready-memory-4');
    expect(mockWarmShareCardFireAndForget).toHaveBeenNthCalledWith(2, 'ready-memory-4');
  });

  it('still invalidates caches even when the warm is deduped away', () => {
    const queryClient = createQueryClient();
    handleIllustrationReadyTransition(queryClient, 'ready-memory-5', 'gen-1');

    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    handleIllustrationReadyTransition(queryClient, 'ready-memory-5', 'gen-1');

    expect(spy).toHaveBeenCalledWith({ queryKey: ['media-urls'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: [calendarMemoriesQueryKeyBase] });
    expect(mockWarmShareCardFireAndForget).toHaveBeenCalledTimes(1);
  });
});
