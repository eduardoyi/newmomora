import { supabase } from '@/lib/supabase';
import { fetchMemoriesByIds } from '@/services/memories';
import {
  fetchWidgetCandidateMemories,
  fetchWidgetMemoryCandidates,
  fetchWidgetRetainedMemoriesByIds,
} from '@/services/widget-memories';

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: jest.fn() },
}));

jest.mock('@/services/memories', () => ({
  fetchMemoriesByIds: jest.fn(),
}));

function row(id: string, memoryDate: string, ageBand: 'recent' | 'medium' | 'old' | 'deep') {
  return {
    memory_id: id,
    memory_date: memoryDate,
    age_band: ageBand,
    family_date: '2026-09-15',
    timezone_name: 'America/New_York',
    next_day_boundary: '2026-09-16T04:00:00.000Z',
  };
}

describe('widget memory candidate integration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes the family to the bounded candidate RPC and preserves server ordering', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [
        row('memory-a', '2026-09-15', 'recent'),
        row('memory-b', '2025-10-01', 'medium'),
      ],
      error: null,
    });

    const result = await fetchWidgetMemoryCandidates('family-1');

    expect(supabase.rpc).toHaveBeenCalledWith('get_widget_memory_candidates', {
      p_family_id: 'family-1',
    });
    expect(result.data?.candidates.map((candidate) => candidate.id)).toEqual([
      'memory-a',
      'memory-b',
    ]);
    expect(result.data?.clock).toEqual({
      familyDate: '2026-09-15',
      timezoneName: 'America/New_York',
      nextDayBoundary: '2026-09-16T04:00:00.000Z',
    });
  });

  it('hydrates the fresh sample through the existing 40-ID memory service', async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, index) => row(`recent-${index}`, '2026-09-15', 'recent')),
      ...Array.from({ length: 10 }, (_, index) => row(`medium-${index}`, '2025-10-01', 'medium')),
      ...Array.from({ length: 10 }, (_, index) => row(`old-${index}`, '2024-01-01', 'old')),
      ...Array.from({ length: 10 }, (_, index) => row(`deep-${index}`, '2020-01-01', 'deep')),
    ];
    const memories = rows.map((candidateRow) => ({ id: candidateRow.memory_id }));
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: rows, error: null });
    (fetchMemoriesByIds as jest.Mock).mockResolvedValue({ data: memories, error: null });

    const result = await fetchWidgetCandidateMemories('family-1');

    expect(result.error).toBeNull();
    expect(result.data?.candidates).toHaveLength(40);
    expect(fetchMemoriesByIds).toHaveBeenCalledTimes(1);
    expect(fetchMemoriesByIds.mock.calls[0][0]).toBe('family-1');
    expect(fetchMemoriesByIds.mock.calls[0][1]).toHaveLength(40);
  });

  it('keeps retained revalidation separate and bounded to seven IDs', async () => {
    (fetchMemoriesByIds as jest.Mock).mockResolvedValue({
      data: [{ id: 'retained-1' }],
      error: null,
    });

    const retained = await fetchWidgetRetainedMemoriesByIds('family-1', [
      'retained-1',
      'retained-1',
      'retained-2',
    ]);

    expect(retained.data).toEqual([{ id: 'retained-1' }]);
    expect(fetchMemoriesByIds).toHaveBeenCalledWith(
      'family-1',
      ['retained-1', 'retained-2'],
    );
  });

  it('does not hydrate or publish a partial set after the candidate RPC fails', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: null,
      error: { code: 'PGRST301', message: 'JWT expired' },
    });

    const result = await fetchWidgetCandidateMemories('family-1');

    expect(result.data).toBeNull();
    expect(result.failure).toBe('authorization');
    expect(fetchMemoriesByIds).not.toHaveBeenCalled();
  });
});
