import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { keepsakesOverviewQueryKey } from '@/hooks/queryKeys';
import { useKeepsakesOverview } from '@/hooks/useKeepsakesOverview';
import { fetchKeepsakesOverview, type KeepsakesOverview } from '@/services/keepsakes';

jest.mock('@/services/keepsakes', () => ({ fetchKeepsakesOverview: jest.fn() }));

const mockedFetch = fetchKeepsakesOverview as jest.MockedFunction<typeof fetchKeepsakesOverview>;

function overview(overrides: Partial<KeepsakesOverview> = {}): KeepsakesOverview {
  return {
    recap: null,
    has_viewers: false,
    year_moments: 12,
    holiday_pool: null,
    holiday_min_pool: null,
    holiday_ship_by_note: null,
    preview_key: null,
    book_preview_keys: {},
    orders: [],
    ...overrides,
  };
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useKeepsakesOverview', () => {
  it('loads the overview for the family', async () => {
    mockedFetch.mockResolvedValue(overview({ year_moments: 40 }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useKeepsakesOverview('family-1'), { wrapper });

    await waitFor(() => expect(result.current.overview?.year_moments).toBe(40));
    expect(mockedFetch).toHaveBeenCalledWith('family-1');
  });

  it('does not fetch without a family or when disabled', async () => {
    const { wrapper } = setup();
    renderHook(() => useKeepsakesOverview(null), { wrapper });
    renderHook(() => useKeepsakesOverview('family-1', { enabled: false }), { wrapper });
    await act(async () => {});
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('degrades to overview null when the RPC errors', async () => {
    mockedFetch.mockRejectedValue(new Error('function not found'));
    const { wrapper } = setup();
    const { result } = renderHook(() => useKeepsakesOverview('family-1'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.overview).toBeNull();
  });

  it('refetches on focus only once the data is stale', async () => {
    mockedFetch.mockResolvedValue(overview());
    const { wrapper, queryClient } = setup();
    const { result, rerender } = renderHook(
      ({ isFocused }: { isFocused: boolean }) => useKeepsakesOverview('family-1', { isFocused }),
      { wrapper, initialProps: { isFocused: true } },
    );
    await waitFor(() => expect(result.current.overview).not.toBeNull());
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // Blur then refocus while fresh: no refetch.
    rerender({ isFocused: false });
    rerender({ isFocused: true });
    await act(async () => {});
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // Invalidate (marks stale) then blur/refocus: refetches.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: keepsakesOverviewQueryKey('family-1'), refetchType: 'none' });
    });
    rerender({ isFocused: false });
    rerender({ isFocused: true });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  });
});
