// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import FamilyMembersScreen from '../../app/(app)/sharing/members';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { sharingInviteRoute } from '@/lib/routes';
import { removeMember, updateMemberRole } from '@/services/family';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
  },
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
  familyMembershipsQueryKey: ['family-memberships'],
}));

jest.mock('@/hooks/useFamilyMemberProfiles', () => ({
  useFamilyMemberProfiles: jest.fn(),
}));

jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false,
    isError: false,
    isReporting: false,
    isUpdatingBlock: false,
    isTargetReported: () => false,
    hasActiveReport: () => false,
    getBlockForUser: () => undefined,
    isUserBlocked: () => false,
    setAccountBlocked: jest.fn(),
    report: jest.fn(),
    refetch: jest.fn(),
  }),
}));

jest.mock('@/services/family', () => ({
  updateMemberRole: jest.fn(),
  removeMember: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMemberProfiles = useFamilyMemberProfiles as jest.MockedFunction<
  typeof useFamilyMemberProfiles
>;
const mockedUpdateMemberRole = updateMemberRole as jest.MockedFunction<typeof updateMemberRole>;
const mockedRemoveMember = removeMember as jest.MockedFunction<typeof removeMember>;

const ownerProfile = {
  user_id: 'user-1',
  name: 'Rosa',
  role: 'owner',
  is_active_member: true,
  created_at: '2026-05-28T00:00:00Z',
};
const managerProfile = {
  user_id: 'user-2',
  name: 'Dana',
  role: 'manager',
  is_active_member: true,
  created_at: '2026-05-28T00:00:00Z',
};
const viewerProfile = {
  user_id: 'user-3',
  name: 'Ana',
  role: 'viewer',
  is_active_member: true,
  created_at: '2026-05-28T00:00:00Z',
};

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });

  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <FamilyMembersScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

function setFamily(role: string, userId = 'user-1') {
  mockedUseAuth.mockReturnValue({
    session: { user: { id: userId } } as never,
    user: { id: userId, email: 'test@example.com' } as never,
    isLoading: false,
    requestSignInOtp: jest.fn(),
    requestSignUpOtp: jest.fn(),
    verifyOtp: jest.fn(),
    signInWithPassword: jest.fn(),
    signOut: jest.fn(),
  });
  mockedUseFamily.mockReturnValue({
    family: { id: 'family-1', name: "Rosa's family" },
    familyId: 'family-1',
    role,
    memberships: [{ id: 'm1', familyId: 'family-1', role, name: "Rosa's family" }],
    isLoading: false,
    setActiveFamily: jest.fn(),
    refetchMemberships: jest.fn(),
    justLostAccess: false,
  } as never);
}

describe('Family members screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it('shows the invite affordance for an owner and routes to the invite screen', () => {
    const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
    setFamily('owner', 'user-1');

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('members-invite-family-member'));
    expect(router.push).toHaveBeenCalledWith(sharingInviteRoute);
  });

  it('shows the invite affordance for a manager', () => {
    setFamily('manager', 'user-2');

    const { getByTestId } = renderScreen();

    expect(getByTestId('members-invite-family-member')).toBeTruthy();
  });

  it('hides the invite affordance for a viewer', () => {
    setFamily('viewer', 'user-3');

    const { queryByTestId } = renderScreen();

    expect(queryByTestId('members-invite-family-member')).toBeNull();
  });

  it('lets the owner manage manager/viewer rows but not the owner row or their own', () => {
    setFamily('owner', 'user-1');

    const { getByTestId, queryByTestId } = renderScreen();

    // Own row (the owner) is inert -- tapping it does nothing.
    fireEvent.press(getByTestId('member-row-user-1'));
    expect(queryByTestId('member-action-remove')).toBeNull();

    // Manager row is actionable -- offers "Make viewer".
    fireEvent.press(getByTestId('member-row-user-2'));
    expect(getByTestId('member-action-demote')).toBeTruthy();
    fireEvent.press(getByTestId('member-action-cancel'));

    // Viewer row is actionable -- offers "Make manager".
    fireEvent.press(getByTestId('member-row-user-3'));
    expect(getByTestId('member-action-promote')).toBeTruthy();
  });

  it('lets a manager manage other non-owner rows but not the owner or their own row', () => {
    setFamily('manager', 'user-2');

    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-1'));
    expect(queryByTestId('member-action-remove')).toBeNull();

    fireEvent.press(getByTestId('member-row-user-2'));
    expect(queryByTestId('member-action-remove')).toBeNull();

    fireEvent.press(getByTestId('member-row-user-3'));
    expect(getByTestId('member-action-promote')).toBeTruthy();
  });

  it('never offers member actions to a viewer, and the list stays read-only', () => {
    setFamily('viewer', 'user-3');

    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-1'));
    fireEvent.press(getByTestId('member-row-user-2'));
    fireEvent.press(getByTestId('member-row-user-3'));
    expect(queryByTestId('member-action-promote')).toBeNull();
    expect(queryByTestId('member-action-demote')).toBeNull();
    expect(queryByTestId('member-action-remove')).toBeNull();
  });

  it('promotes a viewer with a single tap', async () => {
    setFamily('manager', 'user-2');
    mockedUpdateMemberRole.mockResolvedValue({ data: [{ id: 'membership-3', role: 'manager' }], error: null });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-3'));
    fireEvent.press(getByTestId('member-action-promote'));

    await waitFor(() => {
      expect(mockedUpdateMemberRole).toHaveBeenCalledWith('family-1', 'user-3', 'manager');
    });
  });

  it('demotes a manager with a single tap', async () => {
    setFamily('owner', 'user-1');
    mockedUpdateMemberRole.mockResolvedValue({ data: [{ id: 'membership-2', role: 'viewer' }], error: null });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-2'));
    fireEvent.press(getByTestId('member-action-demote'));

    await waitFor(() => {
      expect(mockedUpdateMemberRole).toHaveBeenCalledWith('family-1', 'user-2', 'viewer');
    });
  });

  it('only removes a member after confirming the destructive alert', async () => {
    setFamily('owner', 'user-1');
    mockedRemoveMember.mockResolvedValue({ data: [{ id: 'membership-3' }], error: null });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons) => {
      expect(title).toBe('Remove from family');
      expect(message).toContain('Ana');
      expect(message).toContain('will no longer be able to see the family journal');
      const cancelButton = buttons?.find((button) => button.text === 'Cancel');
      cancelButton?.onPress?.();
    });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-3'));
    fireEvent.press(getByTestId('member-action-remove'));

    expect(alertSpy).toHaveBeenCalled();
    expect(mockedRemoveMember).not.toHaveBeenCalled();

    alertSpy.mockImplementation((_title, _message, buttons) => {
      const removeButton = buttons?.find((button) => button.text === 'Remove');
      removeButton?.onPress?.();
    });

    fireEvent.press(getByTestId('member-row-user-3'));
    fireEvent.press(getByTestId('member-action-remove'));

    await waitFor(() => {
      expect(mockedRemoveMember).toHaveBeenCalledWith('family-1', 'user-3');
    });

    alertSpy.mockRestore();
  });

  it('refreshes the list with a non-scary message when the member was already changed elsewhere', async () => {
    setFamily('owner', 'user-1');
    mockedUpdateMemberRole.mockResolvedValue({ data: [], error: null });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-3'));
    fireEvent.press(getByTestId('member-action-promote'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'List refreshed',
        'Looks like something changed — the list has been refreshed.',
      );
    });

    alertSpy.mockRestore();
  });
});
