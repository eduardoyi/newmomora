import { supabase } from '@/lib/supabase';
import { fetchMemoriesByIds } from '@/services/memories';
import {
  fetchWidgetMemoryCandidates,
  fetchWidgetRetainedMemoriesByIds,
} from '@/services/widget-memories';

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: jest.fn() },
}));

jest.mock('@/services/memories', () => ({
  fetchMemoriesByIds: jest.fn(),
}));

const candidateRow = {
  memory_id: 'memory-1',
  memory_date: '2026-09-15',
  age_band: 'recent',
  family_date: '2026-09-15',
  timezone_name: 'UTC',
  next_day_boundary: '2026-09-16T00:00:00.000Z',
};

describe('widget memory service validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails closed when the server age band disagrees with the memory date', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [{ ...candidateRow, age_band: 'deep' }],
      error: null,
    });

    const result = await fetchWidgetMemoryCandidates('family-1');

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('invalid_response');
    expect(result.failure).toBe('unavailable');
  });

  it('accepts the empty response sentinel and keeps the clock metadata', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [{
        memory_id: null,
        memory_date: null,
        age_band: null,
        family_date: '2026-09-15',
        timezone_name: 'Europe/Lisbon',
        next_day_boundary: '2026-09-15T23:00:00.000Z',
      }],
      error: null,
    });

    const result = await fetchWidgetMemoryCandidates('family-1');

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      candidates: [],
      clock: {
        familyDate: '2026-09-15',
        timezoneName: 'Europe/Lisbon',
        nextDayBoundary: '2026-09-15T23:00:00.000Z',
      },
    });
  });

  it('maps authorization errors without exposing candidate data', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Not authorized for this family' },
    });

    const result = await fetchWidgetMemoryCandidates('family-2');

    expect(result.data).toBeNull();
    expect(result.failure).toBe('authorization');
    expect(result.error?.code).toBe('42501');
  });
});

describe('widget retained memory service bounds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deduplicates retained IDs before the seven-memory bound', async () => {
    (fetchMemoriesByIds as jest.Mock).mockResolvedValue({ data: [], error: null });

    const result = await fetchWidgetRetainedMemoriesByIds(
      'family-1',
      ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    );

    expect(result.error).toBeNull();
    expect(fetchMemoriesByIds).toHaveBeenCalledWith('family-1', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('rejects more than seven distinct retained IDs before any hydration call', async () => {
    const result = await fetchWidgetRetainedMemoriesByIds(
      'family-1',
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    );

    expect(result.error?.code).toBe('validation_error');
    expect(fetchMemoriesByIds).not.toHaveBeenCalled();
  });
});
