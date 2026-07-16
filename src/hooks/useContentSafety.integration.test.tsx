import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';

import {
  blockedFamilyAccountsQueryKey,
  contentReportsQueryKey,
  useContentSafety,
} from '@/hooks/useContentSafety';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  createContentReport,
  fetchMyBlockedFamilyAccounts,
  fetchMyContentReports,
} from '@/services/content-safety';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/services/content-safety', () => ({
  createContentReport: jest.fn(),
  fetchMyBlockedFamilyAccounts: jest.fn(),
  fetchMyContentReports: jest.fn(),
  setFamilyAccountBlocked: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedFetchReports = fetchMyContentReports as jest.MockedFunction<typeof fetchMyContentReports>;
const mockedFetchBlocks = fetchMyBlockedFamilyAccounts as jest.MockedFunction<typeof fetchMyBlockedFamilyAccounts>;
const mockedCreateReport = createContentReport as jest.MockedFunction<typeof createContentReport>;

describe('useContentSafety', () => {
  it('shares reveals across consumers but isolates them by authenticated account', async () => {
    let authenticatedUserId = 'user-1';
    mockedUseAuth.mockImplementation(() => ({ user: { id: authenticatedUserId } } as never));
    mockedUseFamily.mockReturnValue({ familyId: 'family-1' } as never);
    mockedFetchReports.mockResolvedValue({
      data: [{ id: 'r1', family_id: 'family-1', target_type: 'memory', target_id: 'memory-1', target_version_id: null, status: 'open', created_at: 'now' }],
      error: null,
    });
    mockedFetchBlocks.mockResolvedValue({
      data: [{ id: 'b1', family_id: 'family-1', blocker_user_id: 'user-1', blocked_user_id: 'user-2' } as never],
      error: null,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false }, mutations: { gcTime: Infinity, retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useContentSafety(), { wrapper });
    const second = renderHook(() => useContentSafety(), { wrapper });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(second.result.current.isTargetReported('memory', 'memory-1')).toBe(true);
    expect(second.result.current.isUserBlocked('user-2')).toBe(true);

    act(() => {
      first.result.current.revealTarget('memory', 'memory-1');
      first.result.current.revealBlockedUser('user-2');
    });
    await waitFor(() => {
      expect(second.result.current.isTargetReported('memory', 'memory-1')).toBe(false);
      expect(second.result.current.isUserBlocked('user-2')).toBe(false);
    });

    act(() => {
      client.setQueryData(contentReportsQueryKey('user-1', 'family-1'), [
        { id: 'r2', family_id: 'family-1', target_type: 'memory', target_id: 'memory-1', target_version_id: null, status: 'open', created_at: 'later' },
      ]);
      client.setQueryData(blockedFamilyAccountsQueryKey('user-1', 'family-1'), [
        { id: 'b2', family_id: 'family-1', blocker_user_id: 'user-1', blocked_user_id: 'user-2' },
      ]);
    });
    await waitFor(() => {
      expect(second.result.current.isTargetReported('memory', 'memory-1')).toBe(true);
      expect(second.result.current.isUserBlocked('user-2')).toBe(true);
    });

    authenticatedUserId = 'user-3';
    first.rerender(undefined);
    await waitFor(() => expect(first.result.current.isTargetReported('memory', 'memory-1')).toBe(true));
  });

  it('keeps illustration generations distinct in report and reveal state', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1' } as never);
    mockedFetchReports.mockResolvedValue({
      data: [
        { id: 'r-a', family_id: 'family-1', target_type: 'memory_illustration', target_id: 'memory-1', target_version_id: 'generation-a', status: 'open', created_at: 'now' },
        { id: 'r-b', family_id: 'family-1', target_type: 'memory_illustration', target_id: 'memory-1', target_version_id: 'generation-b', status: 'open', created_at: 'now' },
      ],
      error: null,
    });
    mockedFetchBlocks.mockResolvedValue({ data: [], error: null });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useContentSafety(), { wrapper });

    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    expect(hook.result.current.isTargetReported('memory_illustration', 'memory-1', 'generation-a')).toBe(true);
    expect(hook.result.current.isTargetReported('memory_illustration', 'memory-1', 'generation-b')).toBe(true);

    act(() => hook.result.current.revealTarget('memory_illustration', 'memory-1', 'generation-a'));
    await waitFor(() => {
      expect(hook.result.current.isTargetReported('memory_illustration', 'memory-1', 'generation-a')).toBe(false);
      expect(hook.result.current.isTargetReported('memory_illustration', 'memory-1', 'generation-b')).toBe(true);
    });
  });

  it('optimistically caches the selected illustration generation', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1' } as never);
    mockedFetchReports.mockResolvedValue({ data: [], error: null });
    mockedFetchBlocks.mockResolvedValue({ data: [], error: null });
    mockedCreateReport.mockResolvedValue({ data: 'r-new', error: null });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useContentSafety(), { wrapper });
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));

    await act(async () => {
      await hook.result.current.report({
        targetType: 'memory_illustration',
        targetId: 'memory-1',
        targetVersionId: 'generation-a',
        reason: 'privacy',
      });
    });

    await waitFor(() => {
      expect(hook.result.current.isTargetReported('memory_illustration', 'memory-1', 'generation-a')).toBe(true);
      expect(hook.result.current.isTargetReported('memory_illustration', 'memory-1', 'generation-b')).toBe(false);
    });
  });
});
