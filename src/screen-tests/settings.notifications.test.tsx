// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '../../app/(app)/(tabs)/settings';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useNotificationsRegistration } from '@/hooks/useNotifications';
import { useUserProfile } from '@/hooks/useUserProfile';

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

// The registration flow itself (permissions, expo-notifications) is covered
// by useNotifications.test.ts -- here we only assert that the screen invokes
// it correctly and reacts to its result.
jest.mock('@/hooks/useNotifications', () => ({
  useNotificationsRegistration: jest.fn(),
}));

jest.mock('@/services/family', () => ({
  leaveFamily: jest.fn(),
  updateFamilyName: jest.fn(),
}));

// Toggling a reminder on should always send the device's current timezone
// (not a possibly-stale saved value) -- fix the return value so tests can
// assert on it precisely.
jest.mock('@/services/auth', () => ({
  getDeviceTimezone: jest.fn(() => 'America/Denver'),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyInvites = useFamilyInvites as jest.MockedFunction<typeof useFamilyInvites>;
const mockedUseFamilyMemberProfiles = useFamilyMemberProfiles as jest.MockedFunction<
  typeof useFamilyMemberProfiles
>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;
const mockedUseNotificationsRegistration = useNotificationsRegistration as jest.MockedFunction<
  typeof useNotificationsRegistration
>;

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

describe('Settings notifications toggles', () => {
  const updateProfile = jest.fn().mockResolvedValue(undefined);
  const deleteAccount = jest.fn().mockResolvedValue(undefined);
  const signOut = jest.fn().mockResolvedValue(undefined);
  const requestRegistration = jest
    .fn()
    .mockResolvedValue({ granted: true, canAskAgain: true, isRegistered: true });

  beforeEach(() => {
    jest.clearAllMocks();
    updateProfile.mockClear();
    deleteAccount.mockClear();
    signOut.mockClear();
    requestRegistration.mockClear();
    requestRegistration.mockResolvedValue({ granted: true, canAskAgain: true, isRegistered: true });

    mockedUseNotificationsRegistration.mockReturnValue({ requestRegistration });

    mockedUseAuth.mockReturnValue({
      session: { user: { id: 'user-1' } } as never,
      user: { id: 'user-1', email: 'rosa@example.com' } as never,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut,
    });

    mockedUseFamily.mockReturnValue({
      family: null,
      familyId: null,
      role: null,
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
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
      profiles: [],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  function mockProfile(overrides: Record<string, unknown> = {}) {
    mockedUseUserProfile.mockReturnValue({
      profile: {
        name: 'Rosa',
        enable_daily_reminder: false,
        notification_time: null,
        notify_new_memories: true,
        ...overrides,
      } as never,
      isLoading: false,
      isError: false,
      error: null,
      updateProfile,
      isUpdating: false,
      deleteAccount,
      isDeletingAccount: false,
      cancelAccountDeletion: jest.fn(),
      isCancelingDeletion: false,
    } as never);
  }

  it('reflects notify_new_memories = true as the initial toggle value', () => {
    mockProfile({ notify_new_memories: true });

    const { getByTestId } = renderScreen();

    expect(getByTestId('settings-new-memory-alerts-toggle').props.value).toBe(true);
  });

  it('reflects notify_new_memories = false as the initial toggle value', () => {
    mockProfile({ notify_new_memories: false });

    const { getByTestId } = renderScreen();

    expect(getByTestId('settings-new-memory-alerts-toggle').props.value).toBe(false);
  });

  it('defaults to true while the profile has not loaded yet', () => {
    mockedUseUserProfile.mockReturnValue({
      profile: undefined,
      isLoading: true,
      isError: false,
      error: null,
      updateProfile,
      isUpdating: false,
      deleteAccount,
      isDeletingAccount: false,
      cancelAccountDeletion: jest.fn(),
      isCancelingDeletion: false,
    } as never);

    const { getByTestId } = renderScreen();

    expect(getByTestId('settings-new-memory-alerts-toggle').props.value).toBe(true);
  });

  it('calls updateProfile with notifyNewMemories when toggled off', async () => {
    mockProfile({ notify_new_memories: true });

    const { getByTestId } = renderScreen();

    fireEvent(getByTestId('settings-new-memory-alerts-toggle'), 'valueChange', false);

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith({ notifyNewMemories: false });
    });
  });

  it('calls updateProfile with notifyNewMemories when toggled on', async () => {
    mockProfile({ notify_new_memories: false });

    const { getByTestId } = renderScreen();

    fireEvent(getByTestId('settings-new-memory-alerts-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith({ notifyNewMemories: true });
    });
  });

  it('does not touch the daily-reminder fields when toggling new memory alerts', async () => {
    mockProfile({ notify_new_memories: true, enable_daily_reminder: true });

    const { getByTestId } = renderScreen();

    fireEvent(getByTestId('settings-new-memory-alerts-toggle'), 'valueChange', false);

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith({ notifyNewMemories: false });
    });
    expect(updateProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({ enableDailyReminder: expect.anything() }),
    );
  });

  it('hides the daily journal reminder from viewers but keeps new-memory alerts', () => {
    mockProfile({ enable_daily_reminder: true });
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'viewer',
      memberships: [{ id: 'membership-1', familyId: 'family-1', role: 'viewer', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    } as never);

    const { queryByTestId, getByTestId } = renderScreen();

    expect(queryByTestId('settings-daily-reminder-toggle')).toBeNull();
    expect(getByTestId('settings-new-memory-alerts-toggle')).toBeTruthy();
  });

  it('requests push registration when the reminder toggle turns on', async () => {
    mockProfile({ enable_daily_reminder: false });

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-daily-reminder-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(requestRegistration).toHaveBeenCalledTimes(1);
    });
  });

  it('requests push registration when the new-memory-alerts toggle turns on', async () => {
    mockProfile({ notify_new_memories: false });

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-new-memory-alerts-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(requestRegistration).toHaveBeenCalledTimes(1);
    });
  });

  it('does not request push registration when a toggle turns off', async () => {
    mockProfile({ enable_daily_reminder: true });

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-daily-reminder-toggle'), 'valueChange', false);

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ enableDailyReminder: false }),
      );
    });
    expect(requestRegistration).not.toHaveBeenCalled();
  });

  it('sends the current device timezone when turning the reminder toggle on, ignoring the stale saved value', async () => {
    mockProfile({ enable_daily_reminder: false, timezone: 'Stale/Zone' });

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-daily-reminder-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ enableDailyReminder: true, timezone: 'America/Denver' }),
      );
    });
  });

  it('shows an alert linking to system settings when notifications are permanently denied', async () => {
    mockProfile({ enable_daily_reminder: false });
    requestRegistration.mockResolvedValue({ granted: false, canAskAgain: false, isRegistered: false });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockImplementation(jest.fn());

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-daily-reminder-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        expect.stringContaining('off'),
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
          expect.objectContaining({ text: 'Open settings' }),
        ]),
      );
    });

    const buttons = alertSpy.mock.calls[0][2];
    buttons?.find((button) => button.text === 'Open settings')?.onPress?.();

    expect(openSettingsSpy).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
    openSettingsSpy.mockRestore();
  });

  it('does not enable reminders when notification permission is declined', async () => {
    mockProfile({ enable_daily_reminder: false });
    requestRegistration.mockResolvedValue({ granted: false, canAskAgain: true, isRegistered: false });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-daily-reminder-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Notifications are off', expect.any(String));
    });
    expect(updateProfile).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('does not enable alerts when the device token cannot be registered', async () => {
    mockProfile({ notify_new_memories: false });
    requestRegistration.mockResolvedValue({ granted: true, canAskAgain: true, isRegistered: false });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-new-memory-alerts-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Could not enable notifications', expect.any(String));
    });
    expect(updateProfile).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('shows a failure alert when a reminder preference cannot be saved', async () => {
    mockProfile({ enable_daily_reminder: true });
    updateProfile.mockRejectedValueOnce(new Error('network down'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-daily-reminder-toggle'), 'valueChange', false);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Could not update reminders', 'network down');
    });

    alertSpy.mockRestore();
  });

  it('does not show the settings alert when permission is granted', async () => {
    mockProfile({ enable_daily_reminder: false });
    requestRegistration.mockResolvedValue({ granted: true, canAskAgain: true, isRegistered: true });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

    const { getByTestId } = renderScreen();
    fireEvent(getByTestId('settings-daily-reminder-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(requestRegistration).toHaveBeenCalledTimes(1);
    });
    expect(alertSpy).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('hides the reminder time picker while reminders are disabled', () => {
    mockProfile({ enable_daily_reminder: false });
    const { queryByTestId } = renderScreen();

    expect(queryByTestId('settings-reminder-time')).toBeNull();
  });

  it('shows the reminder time picker once reminders are enabled', () => {
    mockProfile({ enable_daily_reminder: true, notification_time: '20:00:00' });
    const { queryByTestId } = renderScreen();

    expect(queryByTestId('settings-reminder-time')).toBeTruthy();
  });

  it('writes the selected hour through updateProfile as notificationTime', async () => {
    mockProfile({ enable_daily_reminder: true, notification_time: '20:00:00' });

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('settings-reminder-time'));
    fireEvent.press(getByTestId('settings-reminder-time-option-08:00:00'));

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith({ notificationTime: '08:00:00' });
    });
  });

  it('opens the FAQ and privacy policy in the default browser', async () => {
    mockProfile();
    const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    const { getByTestId, queryByText } = renderScreen();
    fireEvent.press(getByTestId('settings-faq'));
    fireEvent.press(getByTestId('settings-privacy-policy'));

    await waitFor(() => {
      expect(openUrlSpy).toHaveBeenCalledWith('https://usemomora.com/faq/');
      expect(openUrlSpy).toHaveBeenCalledWith('https://usemomora.com/privacy-policy/');
    });
    expect(queryByText('Send feedback')).toBeNull();
    expect(queryByText('Export data')).toBeNull();
    expect(queryByText('How illustrations work')).toBeNull();

    openUrlSpy.mockRestore();
  });

  it('shows a confirmation before scheduling account deletion', () => {
    mockProfile();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('settings-delete-account'));

    expect(deleteAccount).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Schedule account deletion?',
      'Your account and family journal will be permanently deleted in 15 days. You can cancel at any time before then.',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Schedule deletion', style: 'destructive' }),
      ]),
    );

    alertSpy.mockRestore();
  });

  it('schedules account deletion only after confirming', () => {
    mockProfile();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Schedule deletion')?.onPress?.();
    });

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('settings-delete-account'));

    expect(deleteAccount).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
  });

  it('shows a failure alert when signing out fails', async () => {
    mockProfile();
    signOut.mockRejectedValueOnce(new Error('session unavailable'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('settings-sign-out-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Could not sign out', 'session unavailable');
    });

    alertSpy.mockRestore();
  });
});
