// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '../../app/(app)/(tabs)/settings';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useUserProfile } from '@/hooks/useUserProfile';
import { leaveFamily, updateFamilyName } from '@/services/family';

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

jest.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: jest.fn(),
}));

jest.mock('@/services/family', () => ({
  leaveFamily: jest.fn(),
  updateFamilyName: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMemberProfiles = useFamilyMemberProfiles as jest.MockedFunction<
  typeof useFamilyMemberProfiles
>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;
const mockedLeaveFamily = leaveFamily as jest.MockedFunction<typeof leaveFamily>;
const mockedUpdateFamilyName = updateFamilyName as jest.MockedFunction<typeof updateFamilyName>;

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
