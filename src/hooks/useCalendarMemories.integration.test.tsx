import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCalendarMemoriesInRange, useOldestMemoryDate } from '@/hooks/useCalendarMemories';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { fetchMemoriesInDateRange, fetchOldestMemoryDate } from '@/services/memories';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/services/memories', () => ({
  fetchMemoriesInDateRange: jest.fn(),
  fetchOldestMemoryDate: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedFetchMemoriesInDateRange = fetchMemoriesInDateRange as jest.MockedFunction<
  typeof fetchMemoriesInDateRange
>;
const mockedFetchOldestMemoryDate = fetchOldestMemoryDate as jest.MockedFunction<
  typeof fetchOldestMemoryDate
>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useCalendarMemories hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseAuth.mockReturnValue({
      session: { user: { id: 'user-1' } } as never,
      user: { id: 'user-1' } as never,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    });

    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Test's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Test's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
  });

  it('loads the oldest memory date for calendar extent', async () => {
    mockedFetchOldestMemoryDate.mockResolvedValue({
      data: '2024-02-03',
      error: null,
    });

    const { result } = renderHook(() => useOldestMemoryDate(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.data).toBe('2024-02-03');
    });

    expect(mockedFetchOldestMemoryDate).toHaveBeenCalledTimes(1);
    expect(mockedFetchOldestMemoryDate).toHaveBeenCalledWith('family-1');
  });

  it('loads memories only for the requested calendar date range', async () => {
    mockedFetchMemoriesInDateRange.mockResolvedValue({
      data: [
        {
          id: 'memory-1',
          memory_date: '2026-05-24',
          illustration_status: 'none',
          memory_type: 'text_only',
          content: 'A day at the park',
          emotion: 'joy',
          media_content_type: null,
          created_at: '2026-05-24T00:00:00Z',
          taggedMembers: [],
          mediaAssets: [],
        } as never,
      ],
      error: null,
    });

    const { result } = renderHook(
      () => useCalendarMemoriesInRange({ startDate: '2026-05-01', endDate: '2026-05-31' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
    });

    expect(mockedFetchMemoriesInDateRange).toHaveBeenCalledWith(
      'family-1',
      '2026-05-01',
      '2026-05-31',
    );
  });

  it('does not fetch a calendar range when there is no active family', async () => {
    mockedUseFamily.mockReturnValue({
      family: null,
      familyId: null,
      role: null,
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    renderHook(
      () => useCalendarMemoriesInRange({ startDate: '2026-05-01', endDate: '2026-05-31' }),
      { wrapper: createWrapper() },
    );

    expect(mockedFetchMemoriesInDateRange).not.toHaveBeenCalled();
  });
});
