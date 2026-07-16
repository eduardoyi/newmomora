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
  sharingMembersRoute,
  sharingPendingInvitesRoute,
  sharingRedeemRoute,
} from '@/lib/routes';
import { leaveFamily, updateFamilyName } from '@/services/family';

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

// This screen's notification registration flow (permissions, expo-notifications)
// is covered by useNotifications.test.ts and settings.notifications.test.tsx --
// stub it out here since this file only exercises the Family section.
jest.mock('@/hooks/useNotifications', () => ({
  useNotificationsRegistration: jest.fn(() => ({ requestRegistration: jest.fn() })),
}));

jest.mock('@/services/family', () => ({
  leaveFamily: jest.fn(),
  updateFamilyName: jest.fn(),
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

const FUTURE_EXPIRY = '2030-01-01T00:00:00Z';
const PAST_EXPIRY = '2020-01-01T00:00:00Z';

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
        <QueryClientProvider
          client={new QueryClient({
            defaultOptions: {
              queries: { gcTime: Infinity },
              mutations: { gcTime: Infinity },
            },
          })}
        >
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

  it('badges the Family members row with the active-member count and routes to the members screen', () => {
    const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
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
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [
        {
          user_id: 'user-1',
          name: 'Rosa',
          role: 'owner',
          is_active_member: true,
          created_at: '2026-05-28T00:00:00Z',
        },
        {
          user_id: 'user-2',
          name: 'Dana',
          role: 'manager',
          is_active_member: true,
          created_at: '2026-05-28T00:00:00Z',
        },
        {
          user_id: 'user-3',
          name: 'Former',
          role: null,
          is_active_member: false,
          created_at: '2026-05-28T00:00:00Z',
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });

    const { getByTestId, getByText, queryByTestId } = renderScreen();

    // Only the two active members count, the former member does not.
    expect(getByTestId('settings-family-members')).toBeTruthy();
    expect(getByText('2')).toBeTruthy();
    // The member list itself no longer renders inline.
    expect(queryByTestId('member-row-user-1')).toBeNull();

    fireEvent.press(getByTestId('settings-family-members'));
    expect(router.push).toHaveBeenCalledWith(sharingMembersRoute);
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
    mockedUseFamilyInvites.mockReturnValue({
      invites: [],
      pendingInvites: [{ id: 'invite-1', status: 'pending', expires_at: FUTURE_EXPIRY }],
      redeemedInvites: [{ id: 'invite-2', status: 'redeemed' }],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      revokeInvite: jest.fn(),
      isRevoking: false,
    } as never);

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

  it('hides viewer-restricted family rows but keeps Join a family', () => {
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
    expect(queryByTestId('settings-family-members')).toBeNull();
    // A viewer role never fires the invites query -- RLS would deny it anyway.
    expect(mockedUseFamilyInvites).toHaveBeenCalledWith('family-1', { enabled: false });
  });

  it('only shows Pending invites when there is at least one non-expired pending invite', () => {
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

    // No invites at all -- hidden.
    const { queryByTestId, rerender } = renderScreen();
    expect(queryByTestId('settings-pending-invites')).toBeNull();

    // Only an expired pending invite -- still hidden.
    mockedUseFamilyInvites.mockReturnValue({
      invites: [],
      pendingInvites: [{ id: 'invite-1', status: 'pending', expires_at: PAST_EXPIRY }],
      redeemedInvites: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      revokeInvite: jest.fn(),
      isRevoking: false,
    } as never);
    rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <QueryClientProvider
          client={new QueryClient({
            defaultOptions: {
              queries: { gcTime: Infinity },
              mutations: { gcTime: Infinity },
            },
          })}
        >
          <SettingsScreen />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
    expect(queryByTestId('settings-pending-invites')).toBeNull();

    // A non-expired pending invite -- shown.
    mockedUseFamilyInvites.mockReturnValue({
      invites: [],
      pendingInvites: [{ id: 'invite-2', status: 'pending', expires_at: FUTURE_EXPIRY }],
      redeemedInvites: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      revokeInvite: jest.fn(),
      isRevoking: false,
    } as never);
    rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <QueryClientProvider
          client={new QueryClient({
            defaultOptions: {
              queries: { gcTime: Infinity },
              mutations: { gcTime: Infinity },
            },
          })}
        >
          <SettingsScreen />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
    expect(queryByTestId('settings-pending-invites')).toBeTruthy();
  });

  it('does not flicker Pending invites/Approvals placeholders while invite data is loading', () => {
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
      redeemedInvites: [],
      isLoading: true,
      isError: false,
      error: null,
      refetch: jest.fn(),
      revokeInvite: jest.fn(),
      isRevoking: false,
    } as never);

    const { queryByTestId } = renderScreen();

    expect(queryByTestId('settings-pending-invites')).toBeNull();
    expect(queryByTestId('settings-approvals')).toBeNull();
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
