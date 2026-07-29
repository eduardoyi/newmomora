import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { ReactNode } from 'react';

import { useAiUsageLimitNotices } from './useAiUsageLimitNotices';
import { getMyAiUsageLimitNotices } from '@/services/usage-limits';

let mockUser: { id: string } | null = { id: 'user-a' };
let mockFamilyId: string | null = 'family-a';

jest.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('@/hooks/use-family', () => ({ useFamily: () => ({ familyId: mockFamilyId }) }));
jest.mock('@/services/usage-limits', () => ({
  getMyAiUsageLimitNotices: jest.fn(),
  usageLimitMessage: jest.fn(() => 'Warm copy'),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));

const mockedNotices = getMyAiUsageLimitNotices as jest.MockedFunction<typeof getMyAiUsageLimitNotices>;
const mockedGet = AsyncStorage.getItem as jest.MockedFunction<typeof AsyncStorage.getItem>;
const mockedSet = AsyncStorage.setItem as jest.MockedFunction<typeof AsyncStorage.setItem>;

function wrapper({ children }: { children: ReactNode }) {
  // Prevent React Query's five-minute cache-GC timer from surviving the test.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useAiUsageLimitNotices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'user-a' };
    mockFamilyId = 'family-a';
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  it('queries only the active family, skips an already-seen newest notice, and presents one unseen notice after persisting its key', async () => {
    mockedNotices.mockResolvedValue([
      { id: 'seen', family_id: 'family-a', target_kind: 'memory', target_id: 'm1', scope: 'daily', retry_after: '2026-08-02T00:00:00.000Z', quota_policy_epoch: 2 },
      { id: 'new', family_id: 'family-a', target_kind: 'portrait_version', target_id: 'p1', scope: 'monthly', retry_after: '2026-08-01T00:00:00.000Z', quota_policy_epoch: 2 },
    ]);
    mockedGet.mockResolvedValueOnce('shown').mockResolvedValueOnce(null);
    mockedSet.mockResolvedValue();

    renderHook(() => useAiUsageLimitNotices(), { wrapper });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    expect(mockedNotices).toHaveBeenCalledWith('family-a');
    expect(mockedSet.mock.invocationCallOrder[0]).toBeLessThan((Alert.alert as jest.Mock).mock.invocationCallOrder[0]);
    expect(mockedSet).toHaveBeenCalledWith(expect.stringContaining(':p1:monthly:2:'), 'shown');
  });

  it('does not query without an authenticated user or active family', async () => {
    mockUser = null;
    mockFamilyId = null;
    renderHook(() => useAiUsageLimitNotices(), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedNotices).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('advances to the next unseen notice only after the current alert is dismissed', async () => {
    mockedNotices.mockResolvedValue([
      { id: 'one', family_id: 'family-a', target_kind: 'memory', target_id: 'm1', scope: 'daily', retry_after: '2026-08-02T00:00:00.000Z', quota_policy_epoch: 2 },
      { id: 'two', family_id: 'family-a', target_kind: 'memory', target_id: 'm2', scope: 'daily', retry_after: '2026-08-01T00:00:00.000Z', quota_policy_epoch: 2 },
    ]);
    mockedGet.mockResolvedValue(null);
    mockedSet.mockResolvedValue();
    renderHook(() => useAiUsageLimitNotices(), { wrapper });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[0].onPress?.());
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(2));
  });

  it('does not present an async notice after the active family changes', async () => {
    let resolveStorage: ((value: string | null) => void) | undefined;
    mockedNotices.mockResolvedValue([{ id: 'late', family_id: 'family-a', target_kind: 'memory', target_id: 'm1', scope: 'daily', retry_after: '2026-08-02T00:00:00.000Z', quota_policy_epoch: 2 }]);
    mockedGet.mockReturnValue(new Promise((resolve) => { resolveStorage = resolve; }));
    const rendered = renderHook(() => useAiUsageLimitNotices(), { wrapper });
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    mockFamilyId = 'family-b';
    rendered.rerender({});
    resolveStorage?.(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('ignores an already-open alert acknowledgement after unmount', async () => {
    mockedNotices.mockResolvedValue([{ id: 'open', family_id: 'family-a', target_kind: 'memory', target_id: 'm1', scope: 'daily', retry_after: '2026-08-02T00:00:00.000Z', quota_policy_epoch: 2 }]);
    mockedGet.mockResolvedValue(null);
    mockedSet.mockResolvedValue();
    const rendered = renderHook(() => useAiUsageLimitNotices(), { wrapper });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as { onPress?: () => void }[];
    rendered.unmount();
    buttons[0].onPress?.();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });
});
