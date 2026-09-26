// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '../../app/(app)/(tabs)/settings';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useUserProfile } from '@/hooks/useUserProfile';
import {
  familySettingsRoute,
  sharingInviteRoute,
  sharingManageRoute,
  sharingMembersRoute,
  sharingRedeemRoute,
} from '@/lib/routes';
import { clearPersistedQueryCache } from '@/lib/query-persistence';
import { requestDataExport } from '@/services/export';
import { leaveFamily } from '@/services/family';

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

jest.mock('@/hooks/use-billing', () => ({
  useBilling: jest.fn(),
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
// stub it out here since this file exercises the Family section and the owner
// archive export entry point, not notification registration.
jest.mock('@/hooks/useNotifications', () => ({
  useNotificationsRegistration: jest.fn(() => ({ requestRegistration: jest.fn() })),
}));

jest.mock('@/services/family', () => ({
  leaveFamily: jest.fn(),
}));

jest.mock('@/services/export', () => ({
  requestDataExport: jest.fn(),
}));

jest.mock('@/lib/query-persistence', () => ({
  clearPersistedQueryCache: jest.fn().mockResolvedValue(undefined),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseBilling = useBilling as jest.MockedFunction<typeof useBilling>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyInvites = useFamilyInvites as jest.MockedFunction<typeof useFamilyInvites>;
const mockedUseFamilyMemberProfiles = useFamilyMemberProfiles as jest.MockedFunction<
  typeof useFamilyMemberProfiles
>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;
const mockedRequestDataExport = requestDataExport as jest.MockedFunction<typeof requestDataExport>;
const mockedLeaveFamily = leaveFamily as jest.MockedFunction<typeof leaveFamily>;
const mockedClearPersistedQueryCache = clearPersistedQueryCache as jest.Mock;

const SECOND_FAMILY = { id: 'm2', familyId: 'family-2', role: 'viewer', name: 'Second family' };

function setFamily(
  role: string,
  {
    extraMemberships = [],
    setActiveFamily = jest.fn(),
    refetchMemberships = jest.fn(),
  }: {
    extraMemberships?: typeof SECOND_FAMILY[];
    setActiveFamily?: jest.Mock;
    refetchMemberships?: jest.Mock;
  } = {},
) {
  mockedUseFamily.mockReturnValue({
    family: { id: 'family-1', name: "Rosa's family" },
    familyId: 'family-1',
    role,
    memberships: [{ id: 'm1', familyId: 'family-1', role, name: "Rosa's family" }, ...extraMemberships],
    isLoading: false,
    setActiveFamily,
    refetchMemberships,
    justLostAccess: false,
  });
}

function setRedeemedInvites(count: number, isLoading = false) {
  mockedUseFamilyInvites.mockReturnValue({
    invites: [],
    pendingInvites: [],
    redeemedInvites: Array.from({ length: count }, (_, index) => ({ id: `invite-${index}`, status: 'redeemed' })),
    isLoading,
    isError: false,
    error: null,
    refetch: jest.fn(),
    revokeInvite: jest.fn(),
    isRevoking: false,
  } as never);
}

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

    mockedUseBilling.mockReturnValue({
      offerings: null,
      status: null,
      isConfigured: false,
      isLoading: false,
      isOffline: false,
      purchase: jest.fn(),
      restore: jest.fn(),
      startOnboardingIllustration: jest.fn(),
      refresh: jest.fn(),
    } as never);

    mockedRequestDataExport.mockResolvedValue({
      data: { jobId: 'job-1', alreadyRunning: false, email: 'rosa@example.test' },
      error: null,
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

  it('shows the family name and role with a Families link for a single-family viewer', () => {
    setFamily('viewer');

    const { getByText, getByTestId } = renderScreen();

    expect(getByText("Rosa's family")).toBeTruthy();
    expect(getByText('Viewer')).toBeTruthy();
    expect(getByTestId('settings-family-switch')).toBeTruthy();
    expect(getByText('Families')).toBeTruthy();
  });

  it('gives a viewer the trimmed screen: members and leave, no management, journal import, or export', () => {
    setFamily('viewer');

    const { queryByTestId } = renderScreen();

    expect(queryByTestId('settings-family-members')).toBeTruthy();
    expect(queryByTestId('settings-leave-family')).toBeTruthy();
    expect(queryByTestId('settings-invite-family-member')).toBeNull();
    expect(queryByTestId('settings-family-settings')).toBeNull();
    expect(queryByTestId('settings-gallery-import')).toBeNull();
    expect(queryByTestId('settings-daily-reminder-toggle')).toBeNull();
    expect(queryByTestId('settings-manage-subscription')).toBeNull();
    expect(queryByTestId('settings-export-memories')).toBeNull();
    // A viewer role never fires the invites query -- RLS would deny it anyway.
    expect(mockedUseFamilyInvites).toHaveBeenCalledWith('family-1', { enabled: false });
  });

  it('routes a manager to invite and family settings', () => {
    const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
    setFamily('manager');

    const { getByTestId, getByText } = renderScreen();

    fireEvent.press(getByTestId('settings-invite-family-member'));
    expect(router.push).toHaveBeenCalledWith(sharingInviteRoute);

    expect(getByText('Name and sharing')).toBeTruthy();
    fireEvent.press(getByTestId('settings-family-settings'));
    expect(router.push).toHaveBeenCalledWith(familySettingsRoute);
  });

  it('mentions photo captions in the owner family-settings caption', () => {
    setFamily('owner');

    const { getByText } = renderScreen();

    expect(getByText('Name, sharing, and photo captions')).toBeTruthy();
  });

  it('hides Leave family for the owner and shows it for a manager', () => {
    setFamily('owner');
    const { queryByTestId, unmount } = renderScreen();
    expect(queryByTestId('settings-leave-family')).toBeNull();
    unmount();

    setFamily('manager');
    expect(renderScreen().queryByTestId('settings-leave-family')).toBeTruthy();
  });

  it('starts a private archive export from the owner settings', async () => {
    setFamily('owner');

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('settings-export-memories'));

    await waitFor(() => {
      expect(mockedRequestDataExport).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledWith(
        'Preparing your archive',
        expect.stringContaining('email a download link to rosa@example.test'),
      );
    });
    alertSpy.mockRestore();
  });

  it('tells the owner when an export is already being prepared', async () => {
    setFamily('owner');
    mockedRequestDataExport.mockResolvedValue({
      data: { jobId: 'job-1', alreadyRunning: true, email: 'rosa@example.test' },
      error: null,
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('settings-export-memories'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Already on its way', expect.stringContaining('still preparing'));
    });
    alertSpy.mockRestore();
  });

  it('shows an error when the archive export cannot be created', async () => {
    setFamily('owner');
    mockedRequestDataExport.mockResolvedValue({
      data: null,
      error: { message: 'Export service unavailable', code: 'export_unavailable' },
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('settings-export-memories'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Could not export memories', 'Export service unavailable');
    });

    alertSpy.mockRestore();
  });

  it('keeps export owner-only', () => {
    setFamily('manager');

    const { queryByTestId } = renderScreen();

    expect(queryByTestId('settings-export-memories')).toBeNull();
  });

  it('leaves the family after confirming the alert', async () => {
    const refetchMemberships = jest.fn().mockResolvedValue(undefined);
    setFamily('manager', { refetchMemberships });
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
    // Purge happens before the memberships refetch (O4,
    // docs/plans/offline-awareness-and-share-cards.md) -- a device handed
    // to another user, or this user re-invited later, must never cold-boot
    // into the family they just left.
    await waitFor(() => {
      expect(mockedClearPersistedQueryCache).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(refetchMemberships).toHaveBeenCalled();
    });

    alertSpy.mockRestore();
  });

  it('shows the active-member count on the Members row and routes to the members screen', () => {
    const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
    setFamily('owner');
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [
        { user_id: 'user-1', name: 'Rosa', role: 'owner', is_active_member: true, created_at: '2026-05-28T00:00:00Z' },
        { user_id: 'user-2', name: 'Dana', role: 'manager', is_active_member: true, created_at: '2026-05-28T00:00:00Z' },
        { user_id: 'user-3', name: 'Former', role: null, is_active_member: false, created_at: '2026-05-28T00:00:00Z' },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });

    const { getByTestId, getByText, queryByTestId } = renderScreen();

    // Only the two active members count, the former member does not.
    expect(getByText('2')).toBeTruthy();
    // The member list itself never renders inline.
    expect(queryByTestId('member-row-user-1')).toBeNull();

    fireEvent.press(getByTestId('settings-family-members'));
    expect(router.push).toHaveBeenCalledWith(sharingMembersRoute);
  });

  it('surfaces waiting approvals on the Members row instead of a separate row', () => {
    setFamily('owner');
    setRedeemedInvites(2);

    const { getByText, queryByTestId } = renderScreen();

    expect(getByText('2 waiting for approval')).toBeTruthy();
    expect(queryByTestId('settings-approvals')).toBeNull();
    expect(queryByTestId('settings-pending-invites')).toBeNull();
  });

  it('does not show a waiting count while invite data is loading', () => {
    setFamily('owner');
    setRedeemedInvites(2, true);

    const { queryByText } = renderScreen();

    expect(queryByText('2 waiting for approval')).toBeNull();
  });

  it('switches families from the switcher sheet', async () => {
    const setActiveFamily = jest.fn().mockResolvedValue(undefined);
    setFamily('owner', { extraMemberships: [SECOND_FAMILY], setActiveFamily });

    const { getByTestId, getByText } = renderScreen();

    expect(getByText('Switch')).toBeTruthy();
    fireEvent.press(getByTestId('settings-family-switch'));
    fireEvent.press(getByTestId('family-switcher-option-family-2'));

    await waitFor(() => {
      expect(setActiveFamily).toHaveBeenCalledWith('family-2');
    });
  });

  it('does not re-activate the current family when it is picked again', () => {
    const setActiveFamily = jest.fn().mockResolvedValue(undefined);
    setFamily('owner', { extraMemberships: [SECOND_FAMILY], setActiveFamily });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('settings-family-switch'));
    fireEvent.press(getByTestId('family-switcher-option-family-1'));

    expect(setActiveFamily).not.toHaveBeenCalled();
  });

  it('routes to join and manage families from the switcher sheet, even with one family', () => {
    const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
    setFamily('viewer');

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('settings-family-switch'));
    fireEvent.press(getByTestId('family-switcher-join'));
    expect(router.push).toHaveBeenCalledWith(sharingRedeemRoute);

    fireEvent.press(getByTestId('settings-family-switch'));
    fireEvent.press(getByTestId('family-switcher-manage'));
    expect(router.push).toHaveBeenCalledWith(sharingManageRoute);
  });

  it('edits the display name from the identity card and saves the trimmed value', async () => {
    setFamily('owner');
    const updateProfile = jest.fn().mockResolvedValue(undefined);
    mockedUseUserProfile.mockReturnValue({
      ...mockedUseUserProfile(),
      updateProfile,
    } as never);

    const { getByTestId, queryByTestId } = renderScreen();

    // No always-open name field anymore.
    expect(queryByTestId('settings-display-name')).toBeNull();

    fireEvent.press(getByTestId('settings-profile-edit'));
    fireEvent.changeText(getByTestId('settings-display-name'), '  Rosa R  ');
    fireEvent.press(getByTestId('settings-display-name-save'));

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith({ name: 'Rosa R' });
    });
    await waitFor(() => {
      expect(queryByTestId('settings-display-name')).toBeNull();
    });
  });

  it('refuses to save an empty display name', () => {
    setFamily('owner');
    const updateProfile = jest.fn().mockResolvedValue(undefined);
    mockedUseUserProfile.mockReturnValue({
      ...mockedUseUserProfile(),
      updateProfile,
    } as never);

    const { getByTestId, getByText } = renderScreen();

    fireEvent.press(getByTestId('settings-profile-edit'));
    fireEvent.changeText(getByTestId('settings-display-name'), '   ');
    fireEvent.press(getByTestId('settings-display-name-save'));

    expect(getByText('Your name is required')).toBeTruthy();
    expect(updateProfile).not.toHaveBeenCalled();
  });
});
