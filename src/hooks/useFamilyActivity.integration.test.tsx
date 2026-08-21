import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useFamily } from '@/hooks/use-family';
import { familyActivityUnreadQueryKey } from '@/hooks/queryKeys';
import { useFamilyActivity, useFamilyActivityUnread, useMarkFamilyActivitySeen } from '@/hooks/useFamilyActivity';
import {
  fetchFamilyActivity,
  fetchFamilyActivityUnread,
  markFamilyActivitySeen,
} from '@/services/family-activity';

// useMarkFamilyActivitySeen only needs `familyId` from use-family -- mock
// the whole module so this test doesn't pull in the real hook's chain
// (use-auth -> supabase -> AsyncStorage native module, unavailable in
// Jest), matching the pattern in useMemberManagement.test.tsx.
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/services/family-activity', () => ({
  fetchFamilyActivity: jest.fn(),
  fetchFamilyActivityUnread: jest.fn(),
  markFamilyActivitySeen: jest.fn(),
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedFetchActivity = fetchFamilyActivity as jest.MockedFunction<typeof fetchFamilyActivity>;
const mockedFetchUnread = fetchFamilyActivityUnread as jest.MockedFunction<typeof fetchFamilyActivityUnread>;
const mockedMarkSeen = markFamilyActivitySeen as jest.MockedFunction<typeof markFamilyActivitySeen>;

describe('useFamilyActivity integration', () => {
  let queryClient: QueryClient;
  let wrapper: ({ children }: { children: ReactNode }) => React.JSX.Element;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, gcTime: Infinity },
      },
    });
    wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedFetchActivity.mockResolvedValue({ data: [], error: null });
    mockedFetchUnread.mockResolvedValue({ data: false, error: null });
    mockedMarkSeen.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    queryClient.clear();
  });

  describe('useFamilyActivity enabled gating', () => {
    it('does not fetch while disabled', async () => {
      renderHook(() => useFamilyActivity('family-1', { enabled: false }), { wrapper });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockedFetchActivity).not.toHaveBeenCalled();
    });

    it('does not fetch without a familyId even when enabled', async () => {
      renderHook(() => useFamilyActivity(null, { enabled: true }), { wrapper });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockedFetchActivity).not.toHaveBeenCalled();
    });

    it('fetches once enabled flips true (the sheet-open transition)', async () => {
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useFamilyActivity('family-1', { enabled }),
        { initialProps: { enabled: false }, wrapper },
      );

      expect(mockedFetchActivity).not.toHaveBeenCalled();

      rerender({ enabled: true });

      await waitFor(() => expect(mockedFetchActivity).toHaveBeenCalledWith('family-1'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
    });
  });

  describe('useFamilyActivityUnread', () => {
    it('fetches the unread flag for the given family', async () => {
      mockedFetchUnread.mockResolvedValue({ data: true, error: null });

      const { result } = renderHook(() => useFamilyActivityUnread('family-1'), { wrapper });

      await waitFor(() => expect(result.current.unread).toBe(true));
      expect(fetchFamilyActivityUnread).toHaveBeenCalledWith('family-1');
    });
  });

  describe('useMarkFamilyActivitySeen', () => {
    it('optimistically clears the unread flag and confirms it on success', async () => {
      queryClient.setQueryData(familyActivityUnreadQueryKey('family-1'), true);

      const { result } = renderHook(() => useMarkFamilyActivitySeen(), { wrapper });

      result.current.mutate();

      await waitFor(() =>
        expect(queryClient.getQueryData(familyActivityUnreadQueryKey('family-1'))).toBe(false),
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(markFamilyActivitySeen).toHaveBeenCalledWith('family-1');
    });

    it('rolls back the unread flag on failure', async () => {
      // Resolves after a tick (rather than immediately) so the optimistic
      // clear is observable before the mutation settles and rolls back --
      // an instantly-resolving mock collapses onMutate/mutationFn/onError
      // into the same microtask flush, making the intermediate state
      // unobservable via waitFor's polling.
      mockedMarkSeen.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ error: { message: 'boom' } }), 300)),
      );
      queryClient.setQueryData(familyActivityUnreadQueryKey('family-1'), true);

      const { result } = renderHook(() => useMarkFamilyActivitySeen(), { wrapper });

      result.current.mutate();

      // Optimistic clear happens first...
      await waitFor(() =>
        expect(queryClient.getQueryData(familyActivityUnreadQueryKey('family-1'))).toBe(false),
      );
      // ...then rolls back once the mutation settles with an error.
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(queryClient.getQueryData(familyActivityUnreadQueryKey('family-1'))).toBe(true);
    });
  });
});
