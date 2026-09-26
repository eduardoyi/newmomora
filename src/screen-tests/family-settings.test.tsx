// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import FamilySettingsScreen from '../../app/(app)/family-settings';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useGalleryCaptionSettings } from '@/hooks/useGalleryImport';
import { updateFamilyName, updateFamilyViewerSharing } from '@/services/family';

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

jest.mock('@/hooks/useGalleryImport', () => ({
  useGalleryCaptionSettings: jest.fn(),
  useGalleryImportEntryStatus: jest.fn(),
}));

jest.mock('@/utils/gallery-import-flags', () => ({ isGalleryImportFeatureEnabled: true }));

jest.mock('@/services/family', () => ({
  updateFamilyName: jest.fn(),
  updateFamilyViewerSharing: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCaptionSettings = useGalleryCaptionSettings as jest.MockedFunction<typeof useGalleryCaptionSettings>;
const mockedUpdateFamilyName = updateFamilyName as jest.MockedFunction<typeof updateFamilyName>;
const mockedUpdateFamilyViewerSharing = updateFamilyViewerSharing as jest.MockedFunction<
  typeof updateFamilyViewerSharing
>;

function setFamily(role: string, viewerSharingEnabled?: boolean) {
  mockedUseFamily.mockReturnValue({
    family: { id: 'family-1', name: "Rosa's family", viewerSharingEnabled },
    familyId: 'family-1',
    role,
    memberships: [{ id: 'm1', familyId: 'family-1', role, name: "Rosa's family" }],
    isLoading: false,
    setActiveFamily: jest.fn(),
    refetchMemberships: jest.fn(),
    justLostAccess: false,
  });
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
        <FamilySettingsScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

describe('Family settings screen', () => {
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
    mockedCaptionSettings.mockReturnValue({
      settings: { language: 'en-GB', instructions: '', updatedAt: null },
      save: jest.fn(),
    } as never);
  });

  it('shows no controls to a viewer who navigates here directly', () => {
    setFamily('viewer');

    const { getByTestId, queryByTestId } = renderScreen();

    expect(getByTestId('family-settings-not-allowed')).toBeTruthy();
    expect(queryByTestId('settings-family-name-edit')).toBeNull();
    expect(queryByTestId('settings-viewer-sharing-toggle')).toBeNull();
    expect(queryByTestId('settings-gallery-caption')).toBeNull();
  });

  it('shows the photo caption language row alongside the family rules', () => {
    setFamily('owner');

    const { getByTestId, getByText } = renderScreen();

    expect(getByTestId('settings-gallery-caption')).toBeTruthy();
    expect(getByText('English (United Kingdom)')).toBeTruthy();
  });

  it('lets a manager edit and save the family name', async () => {
    setFamily('manager');
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
    } as never);

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

  it('requires a family name', () => {
    setFamily('owner');

    const { getByTestId, getByText } = renderScreen();

    fireEvent.press(getByTestId('settings-family-name-edit'));
    fireEvent.changeText(getByTestId('settings-family-name-input'), '  ');
    fireEvent.press(getByTestId('settings-family-name-save'));

    expect(getByText('Family name is required')).toBeTruthy();
    expect(mockedUpdateFamilyName).not.toHaveBeenCalled();
  });

  describe('viewer sharing toggle', () => {
    it('defaults to on when viewerSharingEnabled is unset', () => {
      setFamily('owner');

      const { getByTestId } = renderScreen();

      expect(getByTestId('settings-viewer-sharing-toggle').props.value).toBe(true);
    });

    it('reflects viewerSharingEnabled = false', () => {
      setFamily('manager', false);

      const { getByTestId } = renderScreen();

      expect(getByTestId('settings-viewer-sharing-toggle').props.value).toBe(false);
    });

    it('flips the toggle and calls the service with the family id and new value', async () => {
      setFamily('owner', true);
      mockedUpdateFamilyViewerSharing.mockResolvedValue({
        data: {
          id: 'family-1',
          owner_id: 'user-0',
          name: "Rosa's family",
          illustration_style: 'default',
          deleted_at: null,
          viewer_sharing_enabled: false,
          created_at: '2026-05-28T00:00:00Z',
          updated_at: '2026-08-05T00:00:00Z',
        } as never,
        error: null,
      });

      const { getByTestId } = renderScreen();

      fireEvent(getByTestId('settings-viewer-sharing-toggle'), 'valueChange', false);

      await waitFor(() => {
        expect(mockedUpdateFamilyViewerSharing).toHaveBeenCalledWith('family-1', false);
      });
    });

    it('shows a billing-lockout error when the update matches zero rows (lapsed subscription)', async () => {
      setFamily('owner', true);
      mockedUpdateFamilyViewerSharing.mockResolvedValue({ data: null, error: null });

      const { getByTestId, getByText } = renderScreen();

      fireEvent(getByTestId('settings-viewer-sharing-toggle'), 'valueChange', false);

      await waitFor(() => {
        expect(
          getByText("Your family's subscription isn't active, so this setting can't be changed right now."),
        ).toBeTruthy();
      });
    });

    it('shows a generic error message when the service call fails', async () => {
      setFamily('owner', true);
      mockedUpdateFamilyViewerSharing.mockResolvedValue({
        data: null,
        error: { message: 'Network request failed' },
      } as never);

      const { getByTestId, getByText } = renderScreen();

      fireEvent(getByTestId('settings-viewer-sharing-toggle'), 'valueChange', false);

      await waitFor(() => {
        expect(getByText('Network request failed')).toBeTruthy();
      });
    });
  });
});
