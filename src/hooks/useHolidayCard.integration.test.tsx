import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { holidayCardQueryKey } from '@/hooks/queryKeys';
import { useHolidayCard } from '@/hooks/useHolidayCard';
import {
  createHolidayCard,
  fetchHolidayCardSummary,
  type HolidayCardSummary,
} from '@/services/holiday-cards';

jest.mock('@/services/holiday-cards', () => ({
  fetchHolidayCardSummary: jest.fn(),
  createHolidayCard: jest.fn(),
}));

const mockedFetch = fetchHolidayCardSummary as jest.MockedFunction<typeof fetchHolidayCardSummary>;
const mockedCreate = createHolidayCard as jest.MockedFunction<typeof createHolidayCard>;

function summary(overrides: Partial<HolidayCardSummary> = {}): HolidayCardSummary {
  return {
    enabled: true,
    cardId: null,
    year: null,
    status: null,
    lastFailureCode: null,
    ordered: false,
    language: 'en',
    ...overrides,
  };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false }, mutations: { gcTime: Infinity, retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useHolidayCard', () => {
  it('loads the summary for the family', async () => {
    mockedFetch.mockResolvedValue({ data: summary({ cardId: 'card-1', year: 2026, status: 'ready' }), error: null });
    const { wrapper } = setup();
    const { result } = renderHook(() => useHolidayCard('family-1'), { wrapper });

    await waitFor(() => expect(result.current.summary?.cardId).toBe('card-1'));
    expect(mockedFetch).toHaveBeenCalledWith('family-1');
  });

  it('does not fetch without a family or when disabled', async () => {
    const { wrapper } = setup();
    renderHook(() => useHolidayCard(null), { wrapper });
    renderHook(() => useHolidayCard('family-1', { enabled: false }), { wrapper });
    await act(async () => {});
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('exposes a null summary when the RPC returns no row or errors', async () => {
    mockedFetch.mockResolvedValue({ data: null, error: null });
    const { wrapper } = setup();
    const { result } = renderHook(() => useHolidayCard('family-1'), { wrapper });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.summary).toBeNull();

    mockedFetch.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const second = renderHook(() => useHolidayCard('family-2'), { wrapper });
    await waitFor(() => expect(second.result.current.isError).toBe(true));
    expect(second.result.current.summary).toBeNull();
  });

  it('create calls the service and refreshes the summary', async () => {
    mockedFetch.mockResolvedValueOnce({ data: summary(), error: null });
    mockedCreate.mockResolvedValue({ data: { cardId: 'card-7', created: true, regionWarning: false }, error: null });
    const { wrapper } = setup();
    const { result } = renderHook(() => useHolidayCard('family-1'), { wrapper });
    await waitFor(() => expect(result.current.summary?.enabled).toBe(true));

    mockedFetch.mockResolvedValue({
      data: summary({ cardId: 'card-7', year: 2026, status: 'generating' }),
      error: null,
    });
    let outcome: Awaited<ReturnType<typeof result.current.create>> | undefined;
    await act(async () => {
      outcome = await result.current.create('holidays');
    });

    expect(mockedCreate).toHaveBeenCalledWith('family-1', 'holidays');
    expect(outcome).toEqual({ ok: true, result: { cardId: 'card-7', created: true, regionWarning: false } });
    await waitFor(() => expect(result.current.summary?.status).toBe('generating'));
  });

  it('create returns the typed failure and still refreshes the summary', async () => {
    mockedFetch.mockResolvedValue({ data: summary(), error: null });
    mockedCreate.mockResolvedValue({ data: null, error: { code: 'slot_used', message: 'used' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useHolidayCard('family-1'), { wrapper });
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    const callsBefore = mockedFetch.mock.calls.length;

    let outcome: Awaited<ReturnType<typeof result.current.create>> | undefined;
    await act(async () => {
      outcome = await result.current.create('christmas');
    });
    expect(outcome).toEqual({ ok: false, error: { code: 'slot_used', message: 'used' } });
    await waitFor(() => expect(mockedFetch.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('polls every 10 s only while a card is generating and the screen is focused', async () => {
    jest.useFakeTimers();
    try {
      mockedFetch.mockResolvedValue({
        data: summary({ cardId: 'card-1', year: 2026, status: 'generating' }),
        error: null,
      });
      const { wrapper, queryClient } = setup();
      const { result, rerender } = renderHook(
        ({ focused }: { focused: boolean }) => useHolidayCard('family-1', { isFocused: focused }),
        { wrapper, initialProps: { focused: true } },
      );
      await waitFor(() => expect(result.current.summary?.status).toBe('generating'));
      expect(queryClient.getQueryData(holidayCardQueryKey('family-1'))).toBeTruthy();
      const base = mockedFetch.mock.calls.length;

      await act(async () => {
        jest.advanceTimersByTime(10_500);
      });
      await waitFor(() => expect(mockedFetch.mock.calls.length).toBeGreaterThan(base));

      rerender({ focused: false });
      const afterBlur = mockedFetch.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(35_000);
      });
      expect(mockedFetch.mock.calls.length).toBe(afterBlur);
    } finally {
      jest.useRealTimers();
    }
  });
});
