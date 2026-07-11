// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '../../app/(app)/(tabs)/settings';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
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

  beforeEach(() => {
    jest.clearAllMocks();
    updateProfile.mockClear();

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
      deleteAccount: jest.fn(),
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
      deleteAccount: jest.fn(),
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
});
