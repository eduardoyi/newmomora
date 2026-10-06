import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { yearFilmsQueryKey } from '@/hooks/queryKeys';
import { useYearFilm } from '@/hooks/useYearFilm';
import { fetchFamilyMembers } from '@/services/family-members';
import type { YearFilm } from '@/services/year-films';

const mockMaybeSingle = jest.fn();
const mockEq = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({ eq: (...args: unknown[]) => { mockEq(...args); return { maybeSingle: mockMaybeSingle }; } })),
    })),
  },
}));
jest.mock('@/services/ai', () => ({ invokeEdgeFunction: jest.fn() }));
jest.mock('@/services/family-members', () => ({ fetchFamilyMembers: jest.fn() }));

const mockedMembers = fetchFamilyMembers as jest.MockedFunction<typeof fetchFamilyMembers>;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'film-1',
    family_id: 'family-B',
    kind: 'birthday',
    family_member_id: 'kid-1',
    age_year: 4,
    scope_start_date: '2025-10-01',
    scope_end_exclusive: '2026-10-04',
    scope_label: null,
    language: 'en',
    placement_date: '2026-10-02',
    duration_ms: 60_000,
    surface_at: '2026-10-04T09:00:00Z',
    ready_at: '2026-10-04T00:40:00Z',
    edits_version: 0,
    status: 'ready',
    blocked: false,
    stale: false,
    ...overrides,
  };
}

const clients: QueryClient[] = [];
function createWrapper(queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return {
    client,
    wrapper: function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    },
  };
}

describe('useYearFilm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedMembers.mockResolvedValue({
      data: [{ id: 'kid-1', name: 'Tomás' }] as never,
      error: null,
    });
  });

  afterEach(() => {
    clients.splice(0).forEach((client) => client.clear());
  });

  it("looks the film up by id and titles it with its OWN family's members", async () => {
    mockMaybeSingle.mockResolvedValue({ data: row(), error: null });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useYearFilm('film-1'), { wrapper });

    await waitFor(() => expect(result.current.title).toBe("Tomás' Year Four"));
    expect(mockEq).toHaveBeenCalledWith('id', 'film-1');
    expect(mockedMembers).toHaveBeenCalledWith('family-B');
    expect(result.current.film?.family_id).toBe('family-B');
    expect(result.current.isNotFound).toBe(false);
  });

  it('holds a birthday title back until the members have loaded', async () => {
    mockMaybeSingle.mockResolvedValue({ data: row(), error: null });
    let resolveMembers: (value: { data: never; error: null }) => void = () => undefined;
    mockedMembers.mockReturnValue(new Promise((resolve) => { resolveMembers = resolve as never; }));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useYearFilm('film-1'), { wrapper });

    await waitFor(() => expect(result.current.film).not.toBeNull());
    expect(result.current.title).toBeNull();

    resolveMembers({ data: [{ id: 'kid-1', name: 'Tomás' }] as never, error: null });
    await waitFor(() => expect(result.current.title).toBe("Tomás' Year Four"));
  });

  it('titles a monthly recap without waiting for members', async () => {
    mockMaybeSingle.mockResolvedValue({ data: row({ kind: 'family_month', family_member_id: null, scope_start_date: '2026-09-01' }), error: null });
    mockedMembers.mockReturnValue(new Promise(() => undefined));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useYearFilm('film-1'), { wrapper });

    await waitFor(() => expect(result.current.title).toBe('September recap'));
  });

  it('seeds from any family list already in the cache', async () => {
    const cached = row({ family_id: 'family-A', kind: 'family_year', scope_start_date: '2026-01-01' }) as unknown as YearFilm;
    mockMaybeSingle.mockReturnValue(new Promise(() => undefined));
    const { client, wrapper } = createWrapper();
    client.setQueryData(yearFilmsQueryKey('family-A'), [cached]);

    const { result } = renderHook(() => useYearFilm('film-1'), { wrapper });

    expect(result.current.film?.id).toBe('film-1');
    expect(result.current.title).toBe('Your 2026');
    expect(result.current.isNotFound).toBe(false);
  });

  it('reports not found when RLS returns no row', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useYearFilm('film-1'), { wrapper });

    await waitFor(() => expect(result.current.isNotFound).toBe(true));
    expect(result.current.film).toBeNull();
    expect(mockedMembers).not.toHaveBeenCalled();
  });

  it('ignores a row of an unknown kind', async () => {
    mockMaybeSingle.mockResolvedValue({ data: row({ kind: 'mystery' }), error: null });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useYearFilm('film-1'), { wrapper });

    await waitFor(() => expect(result.current.isNotFound).toBe(true));
  });
});
