import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { familyMemberProfilesQueryKey } from '@/hooks/queryKeys';
import { MemberChangedElsewhereError, useMemberManagement } from '@/hooks/useMemberManagement';
import { removeMember, updateMemberRole, type FamilyMemberProfile } from '@/services/family';

// useMemberManagement only needs the query-key constant from use-family --
// mock the whole module so this test doesn't pull in the real hook's chain
// (use-auth -> supabase -> AsyncStorage native module, unavailable in Jest).
jest.mock('@/hooks/use-family', () => ({
  familyMembershipsQueryKey: ['family-memberships'],
}));

jest.mock('@/services/family', () => ({
  updateMemberRole: jest.fn(),
  removeMember: jest.fn(),
}));

const mockedUpdateMemberRole = updateMemberRole as jest.MockedFunction<typeof updateMemberRole>;
const mockedRemoveMember = removeMember as jest.MockedFunction<typeof removeMember>;

const familyId = 'family-1';

const initialProfiles: FamilyMemberProfile[] = [
  { user_id: 'user-1', name: 'Rosa', role: 'owner', is_active_member: true, created_at: '2026-01-01T00:00:00Z' },
  { user_id: 'user-2', name: 'Ana', role: 'viewer', is_active_member: true, created_at: '2026-01-01T00:00:00Z' },
];

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(familyMemberProfilesQueryKey(familyId), initialProfiles);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { queryClient, wrapper };
}

function getCachedRole(queryClient: QueryClient, userId: string) {
  const cached = queryClient.getQueryData<FamilyMemberProfile[]>(familyMemberProfilesQueryKey(familyId));
  return cached?.find((profile) => profile.user_id === userId);
}

describe('useMemberManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies a role change optimistically before the service call resolves', async () => {
    let resolveUpdate: (value: { data: { id: string; role: string }[]; error: null }) => void;
    mockedUpdateMemberRole.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useMemberManagement(familyId), { wrapper });

    let mutationPromise: Promise<unknown>;
    act(() => {
      mutationPromise = result.current.changeRole({ userId: 'user-2', role: 'manager' });
    });

    await waitFor(() => {
      expect(getCachedRole(queryClient, 'user-2')?.role).toBe('manager');
    });

    resolveUpdate!({ data: [{ id: 'membership-2', role: 'manager' }], error: null });
    await act(async () => {
      await mutationPromise;
    });

    expect(mockedUpdateMemberRole).toHaveBeenCalledWith(familyId, 'user-2', 'manager');
  });

  it('rolls back the optimistic role change when the service call fails', async () => {
    mockedUpdateMemberRole.mockResolvedValue({
      data: null,
      error: { message: 'permission denied' },
    });

    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useMemberManagement(familyId), { wrapper });

    await act(async () => {
      await expect(result.current.changeRole({ userId: 'user-2', role: 'manager' })).rejects.toThrow(
        'permission denied',
      );
    });

    expect(getCachedRole(queryClient, 'user-2')?.role).toBe('viewer');
  });

  it('throws MemberChangedElsewhereError and does not keep a stale optimistic value when zero rows match', async () => {
    mockedUpdateMemberRole.mockResolvedValue({ data: [], error: null });

    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useMemberManagement(familyId), { wrapper });

    await act(async () => {
      await expect(result.current.changeRole({ userId: 'user-2', role: 'manager' })).rejects.toBeInstanceOf(
        MemberChangedElsewhereError,
      );
    });

    // onError rolls back to the pre-mutation snapshot rather than leaving the
    // optimistic "manager" value in place.
    expect(getCachedRole(queryClient, 'user-2')?.role).toBe('viewer');
  });

  it('removes a member and calls the service with the right args', async () => {
    mockedRemoveMember.mockResolvedValue({ data: [{ id: 'membership-2' }], error: null });

    const { wrapper } = setup();
    const { result } = renderHook(() => useMemberManagement(familyId), { wrapper });

    await act(async () => {
      await result.current.removeMember('user-2');
    });

    expect(mockedRemoveMember).toHaveBeenCalledWith(familyId, 'user-2');
  });

  it('rolls back an optimistic removal when the service call fails', async () => {
    mockedRemoveMember.mockResolvedValue({ data: null, error: { message: 'network error' } });

    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useMemberManagement(familyId), { wrapper });

    await act(async () => {
      await expect(result.current.removeMember('user-2')).rejects.toThrow('network error');
    });

    const restored = getCachedRole(queryClient, 'user-2');
    expect(restored?.is_active_member).toBe(true);
    expect(restored?.role).toBe('viewer');
  });
});
