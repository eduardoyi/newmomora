import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { FamilyProvider, useFamily } from '@/hooks/use-family';
import { useAuth } from '@/hooks/use-auth';
import { fetchMyFamilyMemberships } from '@/services/family';
import { fetchUserProfile, updateUserProfile } from '@/services/user-profile';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/services/family', () => ({
  fetchMyFamilyMemberships: jest.fn(),
}));

jest.mock('@/services/user-profile', () => ({
  fetchUserProfile: jest.fn(),
  updateUserProfile: jest.fn(),
}));

// useUserProfile (used internally by FamilyProvider) also pulls in
// @/services/ai for account-deletion actions -- mock it too so the real
// module chain (-> @/lib/supabase -> AsyncStorage) never loads in Jest.
jest.mock('@/services/ai', () => ({
  cancelAccountDeletion: jest.fn(),
  deleteUserAccount: jest.fn(),
}));

// FamilyProvider also mounts useMemoriesRealtime (Workstream D2) directly,
// which imports the real @/lib/supabase -> AsyncStorage chain the mock
// above is guarding against -- mock it out too. This file exercises
// FamilyProvider's membership-resolution logic, not realtime; the dedicated
// coverage for useMemoriesRealtime lives in useMemoriesRealtime.test.tsx.
jest.mock('@/hooks/useMemoriesRealtime', () => ({
  useMemoriesRealtime: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedFetchMemberships = fetchMyFamilyMemberships as jest.MockedFunction<
  typeof fetchMyFamilyMemberships
>;
const mockedFetchUserProfile = fetchUserProfile as jest.MockedFunction<typeof fetchUserProfile>;
const mockedUpdateUserProfile = updateUserProfile as jest.MockedFunction<typeof updateUserProfile>;

function familyAMembership() {
  return {
    id: 'membership-a',
    family_id: 'family-a',
    role: 'owner',
    family: { id: 'family-a', name: "A's family", illustration_style: 'default', deleted_at: null },
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <FamilyProvider>{children}</FamilyProvider>
      </QueryClientProvider>
    );
  };
}

describe('FamilyProvider', () => {
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
  });

  it('resolves the active family from active_family_id when it matches a membership', async () => {
    mockedFetchUserProfile.mockResolvedValue({
      data: { id: 'user-1', active_family_id: 'family-a', name: 'Test' } as never,
      error: null,
    });
    mockedFetchMemberships.mockResolvedValue({ data: [familyAMembership()], error: null });

    const { result } = renderHook(() => useFamily(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.familyId).toBe('family-a');
    expect(result.current.role).toBe('owner');
    expect(result.current.family).toEqual({ id: 'family-a', name: "A's family" });
    expect(mockedUpdateUserProfile).not.toHaveBeenCalled();
  });

  it('falls back to the first membership and persists the correction when active_family_id is stale', async () => {
    mockedFetchUserProfile
      .mockResolvedValueOnce({
        data: { id: 'user-1', active_family_id: 'stale-family', name: 'Test' } as never,
        error: null,
      })
      .mockResolvedValue({
        data: { id: 'user-1', active_family_id: 'family-a', name: 'Test' } as never,
        error: null,
      });
    mockedFetchMemberships.mockResolvedValue({ data: [familyAMembership()], error: null });
    mockedUpdateUserProfile.mockResolvedValue({
      data: { id: 'user-1', active_family_id: 'family-a' } as never,
      error: null,
    });

    const { result } = renderHook(() => useFamily(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.familyId).toBe('family-a'));

    await waitFor(() => {
      expect(mockedUpdateUserProfile).toHaveBeenCalledWith(
        expect.objectContaining({ activeFamilyId: 'family-a' }),
      );
    });
  });

  it('sets justLostAccess once memberships go from non-empty to empty this session', async () => {
    mockedFetchUserProfile.mockResolvedValue({
      data: { id: 'user-1', active_family_id: 'family-a', name: 'Test' } as never,
      error: null,
    });
    mockedFetchMemberships
      .mockResolvedValueOnce({ data: [familyAMembership()], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const { result } = renderHook(() => useFamily(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.familyId).toBe('family-a'));
    expect(result.current.justLostAccess).toBe(false);

    await act(async () => {
      await result.current.refetchMemberships();
    });

    await waitFor(() => expect(result.current.memberships).toHaveLength(0));
    expect(result.current.familyId).toBeNull();
    expect(result.current.justLostAccess).toBe(true);
  });

  it('does not report justLostAccess for a brand-new user who never had a family', async () => {
    mockedFetchUserProfile.mockResolvedValue({
      data: { id: 'user-1', active_family_id: null, name: 'Test' } as never,
      error: null,
    });
    mockedFetchMemberships.mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() => useFamily(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.familyId).toBeNull();
    expect(result.current.justLostAccess).toBe(false);
  });
});
