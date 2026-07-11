import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

import { useRedeemedInviteStatus } from '@/hooks/useRedeemedInviteStatus';
import { fetchMyRedeemedInviteStatus } from '@/services/invites';

// The service chain pulls in @/lib/supabase -> AsyncStorage at module load;
// mock it so the hook test stays hermetic.
jest.mock('@/services/invites', () => ({
  fetchMyRedeemedInviteStatus: jest.fn(),
}));

const mockedFetchStatus = fetchMyRedeemedInviteStatus as jest.MockedFunction<
  typeof fetchMyRedeemedInviteStatus
>;

function statusRow(status: string, familyUnavailable = false) {
  return {
    invite_id: 'invite-1',
    status,
    family_name: "Rosa's family",
    family_unavailable: familyUnavailable,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useRedeemedInviteStatus (waiting screen transitions)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads as waiting before the first poll lands', async () => {
    mockedFetchStatus.mockResolvedValue({ data: statusRow('redeemed'), error: null });

    const { result } = renderHook(() => useRedeemedInviteStatus({ pollIntervalMs: 10_000 }), {
      wrapper: createWrapper(),
    });

    expect(result.current.outcome.kind).toBe('waiting');

    await waitFor(() => {
      expect(mockedFetchStatus).toHaveBeenCalled();
    });
  });

  it('stays waiting while the invite is redeemed, then flips to approved on a later poll', async () => {
    mockedFetchStatus
      .mockResolvedValueOnce({ data: statusRow('redeemed'), error: null })
      .mockResolvedValue({ data: statusRow('approved'), error: null });

    const { result } = renderHook(() => useRedeemedInviteStatus({ pollIntervalMs: 20 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(mockedFetchStatus).toHaveBeenCalledTimes(1);
    });
    expect(result.current.outcome.kind).toBe('waiting');

    await waitFor(() => {
      expect(result.current.outcome).toEqual({ kind: 'approved', familyName: "Rosa's family" });
    });
  });

  it('flips to rejected', async () => {
    mockedFetchStatus.mockResolvedValue({ data: statusRow('rejected'), error: null });

    const { result } = renderHook(() => useRedeemedInviteStatus({ pollIntervalMs: 10_000 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.outcome).toEqual({ kind: 'rejected', familyName: "Rosa's family" });
    });
  });

  it('is terminally unavailable when the family was soft-deleted mid-wait', async () => {
    mockedFetchStatus.mockResolvedValue({ data: statusRow('redeemed', true), error: null });

    const { result } = renderHook(() => useRedeemedInviteStatus({ pollIntervalMs: 10_000 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.outcome).toEqual({ kind: 'unavailable' });
    });
  });

  it('is terminally unavailable when no redeemed invite exists', async () => {
    mockedFetchStatus.mockResolvedValue({ data: null, error: null });

    const { result } = renderHook(() => useRedeemedInviteStatus({ pollIntervalMs: 10_000 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.outcome).toEqual({ kind: 'unavailable' });
    });
  });

  it('stops polling once the outcome is terminal', async () => {
    mockedFetchStatus.mockResolvedValue({ data: statusRow('approved'), error: null });

    const { result } = renderHook(() => useRedeemedInviteStatus({ pollIntervalMs: 20 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.outcome.kind).toBe('approved');
    });

    const callsAtTerminal = mockedFetchStatus.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mockedFetchStatus.mock.calls.length).toBe(callsAtTerminal);
  });

  it('does not poll when disabled (screen unfocused)', async () => {
    mockedFetchStatus.mockResolvedValue({ data: statusRow('redeemed'), error: null });

    renderHook(() => useRedeemedInviteStatus({ enabled: false, pollIntervalMs: 20 }), {
      wrapper: createWrapper(),
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mockedFetchStatus).not.toHaveBeenCalled();
  });
});
