// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '../../app/(app)/(tabs)/settings';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useUserProfile } from '@/hooks/useUserProfile';
import {
  sharingApprovalsRoute,
  sharingInviteRoute,
  sharingPendingInvitesRoute,
  sharingRedeemRoute,
} from '@/lib/routes';
import { leaveFamily, removeMember, updateFamilyName, updateMemberRole } from '@/services/family';

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

jest.mock('@/hooks/useFamilyInvites', () => ({
  useFamilyInvites: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
  familyMembershipsQueryKey: ['family-memberships'],
}));

jest.mock('@/hooks/useFamilyMemberProfiles', () => ({
  useFamilyMemberProfiles: jest.fn(),
}));

jest.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: jest.fn(),
}));

jest.mock('@/services/family', () => ({
  leaveFamily: jest.fn(),
  updateFamilyName: jest.fn(),
  updateMemberRole: jest.fn(),
  removeMember: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyInvites = useFamilyInvites as jest.MockedFunction<typeof useFamilyInvites>;
const mockedUseFamilyMemberProfiles = useFamilyMemberProfiles as jest.MockedFunction<
  typeof useFamilyMemberProfiles
>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;
const mockedLeaveFamily = leaveFamily as jest.MockedFunction<typeof leaveFamily>;
const mockedUpdateFamilyName = updateFamilyName as jest.MockedFunction<typeof updateFamilyName>;
const mockedUpdateMemberRole = updateMemberRole as jest.MockedFunction<typeof updateMemberRole>;
const mockedRemoveMember = removeMember as jest.MockedFunction<typeof removeMember>;

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <SettingsScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

describe('Settings Family section', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseAuth.mockReturnValue({
      session: { user: { id: 'user-1' } } as never,
      user: { id: 'user-1', email: 'rosa@example.com' } as never,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    });

    mockedUseUserProfile.mockReturnValue({
      profile: { name: 'Rosa', enable_daily_reminder: false } as never,
      isLoading: false,
      isError: false,
      error: null,
      updateProfile: jest.fn().mockResolvedValue(undefined),
      isUpdating: false,
      deleteAccount: jest.fn(),
      isDeletingAccount: false,
      cancelAccountDeletion: jest.fn(),
      isCancelingDeletion: false,
    } as never);

    mockedUseFamilyInvites.mockReturnValue({
      invites: [],
      pendingInvites: [],
      redeemedInvites: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      revokeInvite: jest.fn(),
      isRevoking: false,
    } as never);

    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [
        {
          user_id: 'user-1',
          name: 'Rosa',
          role: 'owner',
          is_active_member: true,
          created_at: '2026-05-28T00:00:00Z',
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it('shows the family name and role, with no edit affordance for a viewer', () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'viewer',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'viewer', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { getByText, queryByTestId } = renderScreen();

    expect(getByText("Rosa's family")).toBeTruthy();
    expect(getByText('Viewer')).toBeTruthy();
    expect(queryByTestId('settings-family-name-edit')).toBeNull();
  });

  it('lets a manager edit and save the family name', async () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'manager',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'manager', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    mockedUpdateFamilyName.mockResolvedValue({
      data: {
        id: 'family-1',
        owner_id: 'user-0',
        name: 'The Rivera family',
        illustration_style: 'default',
        deleted_at: null,
        created_at: '2026-05-28T00:00:00Z',
        updated_at: '2026-05-28T00:00:00Z',
      },
      error: null,
    });

    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('settings-family-name-edit'));
    fireEvent.changeText(getByTestId('settings-family-name-input'), 'The Rivera family');
    fireEvent.press(getByTestId('settings-family-name-save'));

    await waitFor(() => {
      expect(mockedUpdateFamilyName).toHaveBeenCalledWith('family-1', 'The Rivera family');
    });
    await waitFor(() => {
      expect(queryByTestId('settings-family-name-input')).toBeNull();
    });
  });

  it('hides the leave-family button for the owner and shows it for a manager', () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { queryByTestId, rerender } = renderScreen();
    expect(queryByTestId('settings-leave-family')).toBeNull();

    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'manager',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'manager', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <QueryClientProvider client={new QueryClient()}>
          <SettingsScreen />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );

    expect(queryByTestId('settings-leave-family')).toBeTruthy();
  });

  it('leaves the family after confirming the alert', async () => {
    const refetchMemberships = jest.fn().mockResolvedValue(undefined);
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'manager',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'manager', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships,
      justLostAccess: false,
    });
    mockedLeaveFamily.mockResolvedValue({ error: null });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const leaveButton = buttons?.find((button) => button.text === 'Leave');
      leaveButton?.onPress?.();
    });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('settings-leave-family'));

    await waitFor(() => {
      expect(mockedLeaveFamily).toHaveBeenCalledWith('family-1', 'user-1');
    });
    await waitFor(() => {
      expect(refetchMemberships).toHaveBeenCalled();
    });

    alertSpy.mockRestore();
  });

  it('shows manager sharing entry points and routes to each sharing screen', () => {
    const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'manager',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'manager', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('settings-invite-family-member'));
    expect(router.push).toHaveBeenCalledWith(sharingInviteRoute);

    fireEvent.press(getByTestId('settings-pending-invites'));
    expect(router.push).toHaveBeenCalledWith(sharingPendingInvitesRoute);

    fireEvent.press(getByTestId('settings-approvals'));
    expect(router.push).toHaveBeenCalledWith(sharingApprovalsRoute);

    fireEvent.press(getByTestId('settings-join-family'));
    expect(router.push).toHaveBeenCalledWith(sharingRedeemRoute);
  });

  it('hides manager-only sharing rows from viewers but keeps Join a family', () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'viewer',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'viewer', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { queryByTestId } = renderScreen();

    expect(queryByTestId('settings-invite-family-member')).toBeNull();
    expect(queryByTestId('settings-pending-invites')).toBeNull();
    expect(queryByTestId('settings-approvals')).toBeNull();
    expect(queryByTestId('settings-join-family')).toBeTruthy();
  });

  it('badges the approvals row with the redeemed-invite count', () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    mockedUseFamilyInvites.mockReturnValue({
      invites: [],
      pendingInvites: [],
      redeemedInvites: [{ id: 'invite-1' }, { id: 'invite-2' }],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      revokeInvite: jest.fn(),
      isRevoking: false,
    } as never);

    const { getByText } = renderScreen();

    expect(getByText('2')).toBeTruthy();
  });

  it('only renders the family picker when there is more than one membership', () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { queryByTestId } = renderScreen();
    expect(queryByTestId('settings-family-picker')).toBeNull();
  });
});

describe('Settings Family section member management', () => {
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

  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseAuth.mockReturnValue({
      session: { user: { id: 'user-1' } } as never,
      user: { id: 'user-1', email: 'rosa@example.com' } as never,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    });

    mockedUseUserProfile.mockReturnValue({
      profile: { name: 'Rosa', enable_daily_reminder: false } as never,
      isLoading: false,
      isError: false,
      error: null,
      updateProfile: jest.fn().mockResolvedValue(undefined),
      isUpdating: false,
      deleteAccount: jest.fn(),
      isDeletingAccount: false,
      cancelAccountDeletion: jest.fn(),
      isCancelingDeletion: false,
    } as never);

    mockedUseFamilyInvites.mockReturnValue({
      invites: [],
      pendingInvites: [],
      redeemedInvites: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      revokeInvite: jest.fn(),
      isRevoking: false,
    } as never);
  });

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
    });
  }

  it('lets the owner manage manager/viewer rows but not the owner row or their own', () => {
    setFamily('owner', 'user-1');
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });

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
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });

    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-1'));
    expect(queryByTestId('member-action-remove')).toBeNull();

    fireEvent.press(getByTestId('member-row-user-2'));
    expect(queryByTestId('member-action-remove')).toBeNull();

    fireEvent.press(getByTestId('member-row-user-3'));
    expect(getByTestId('member-action-promote')).toBeTruthy();
  });

  it('never offers member actions to a viewer', () => {
    setFamily('viewer', 'user-3');
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });

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
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });
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
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });
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
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });
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
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });
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
