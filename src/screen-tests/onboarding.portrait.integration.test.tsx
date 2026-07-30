// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S16 is fully wired (plan WP3), unlike S13-S15: these tests prove the real
// pipeline wiring -- the right child is resolved from the draft, picking a
// photo calls createPortraitVersion (via usePortraitVersions) for that exact
// member and transitions to "painting", and the Android
// ImagePicker.getPendingResultAsync() recovery effect (mirrored from
// app/(app)/add-family-member.tsx) starts a portrait on its own.
//
// WP6 extends this suite: "painting" reads the real portrait status instead
// of a purely decorative pulse -- `ready` hands off to S17's reveal, `failed`
// surfaces a retry.
import * as ImagePicker from 'expo-image-picker';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PortraitScreen from '../../app/(onboarding)/portrait';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';
import { onboardingRevealRoute } from '@/lib/onboarding-routes';
import { timelineRoute } from '@/lib/routes';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';
import {
  parsePendingPickerResult,
  pickFamilyProfilePhotoFromLibrary,
} from '@/utils/family-profile-photo-picker';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: jest.fn(),
}));

jest.mock('@/hooks/usePortraitVersions', () => ({
  usePortraitVersions: jest.fn(),
}));

jest.mock('@/utils/family-profile-photo-picker', () => ({
  pickFamilyProfilePhotoFromLibrary: jest.fn(),
  parsePendingPickerResult: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  getPendingResultAsync: jest.fn(),
}));

// createEmptyOnboardingDraft lives in the same module as the real
// AsyncStorage-backed persistence helpers (src/utils/onboarding-progress.ts)
// -- swap in the maintained mock so importing it doesn't pull in the native
// module under Jest (same pattern as onboarding-progress.test.ts).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUsePortraitVersions = usePortraitVersions as jest.MockedFunction<typeof usePortraitVersions>;
const mockedPickFromLibrary = pickFamilyProfilePhotoFromLibrary as jest.MockedFunction<typeof pickFamilyProfilePhotoFromLibrary>;
const mockedParsePendingPickerResult = parsePendingPickerResult as jest.MockedFunction<typeof parsePendingPickerResult>;
const mockedGetPendingResultAsync = ImagePicker.getPendingResultAsync as jest.MockedFunction<typeof ImagePicker.getPendingResultAsync>;

const LILA_MEMBER = {
  id: 'member-lila',
  user_id: 'user-1',
  family_id: 'family-1',
  name: 'Lila',
  nicknames: [],
  date_of_birth: '2022-03-14',
  gender: null,
  profile_picture_key: null,
  illustrated_profile_key: null,
  illustrated_profile_status: 'pending' as const,
  additional_info: null,
  is_user_profile: false,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

const MIGUEL_MEMBER = {
  ...LILA_MEMBER,
  id: 'member-miguel',
  name: 'Miguel',
  date_of_birth: '2020-05-05',
};

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <PortraitScreen />
    </SafeAreaProvider>,
  );
}

function mockDraft(overrides: Partial<OnboardingDraft>) {
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('portrait'), committedFamilyId: 'family-1', ...overrides },
    isHydrated: true,
    patch: jest.fn(),
    clear: jest.fn(),
  });
}

describe('PortraitScreen (S16)', () => {
  const originalPlatform = Platform.OS;
  const mockCreateVersion = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockCreateVersion.mockResolvedValue({ id: 'version-1' });
    mockedUsePortraitVersions.mockReturnValue({
      createVersion: mockCreateVersion,
      isCreating: false,
    } as unknown as ReturnType<typeof usePortraitVersions>);
    mockedGetPendingResultAsync.mockResolvedValue(null);
    mockedParsePendingPickerResult.mockReturnValue({});
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  it('starts with the kid tagged in the first memory, calls createPortraitVersion for that member, and transitions to painting', async () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER, MIGUEL_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockDraft({ kidNames: ['Lila', 'Miguel'], capture: { text: 'x', taggedKidIndexes: [1] } });
    mockedPickFromLibrary.mockResolvedValue({
      selection: {
        uri: 'file:///miguel.jpg',
        contentType: 'image/jpeg',
        captureDate: '2026-06-01',
        referenceDate: '2026-06-01',
        dateSource: 'exif',
      },
    });

    const { getByText, getByTestId } = renderScreen();

    expect(getByText("Let's make Miguel's portrait.")).toBeTruthy();
    expect(getByTestId('onb-portrait-multi-kid-note')).toBeTruthy();
    expect(mockedUsePortraitVersions).toHaveBeenCalledWith('member-miguel');

    fireEvent.press(getByTestId('onb-portrait-choose-photo-button'));

    await waitFor(() => expect(mockCreateVersion).toHaveBeenCalledWith({
      photoUri: 'file:///miguel.jpg',
      photoContentType: 'image/jpeg',
      referenceDate: '2026-06-01',
      dateSource: 'exif',
      dateOfBirth: '2020-05-05',
    }));

    expect(await waitFor(() => getByText("We're painting."))).toBeTruthy();
  });

  it('falls back to the first-entered name when nothing is tagged yet, and hides the multi-kid note for a single kid', () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [{ ...LILA_MEMBER, name: 'Teo', id: 'member-teo', date_of_birth: null }],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockDraft({ kidNames: ['Teo'], capture: null });

    const { getByText, queryByTestId } = renderScreen();

    expect(getByText("Let's make Teo's portrait.")).toBeTruthy();
    expect(queryByTestId('onb-portrait-multi-kid-note')).toBeNull();
    expect(mockedUsePortraitVersions).toHaveBeenCalledWith('member-teo');
  });

  it('shows an inline error and stays in "pick" when the photo picker fails, without starting a portrait', async () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockDraft({ kidNames: ['Lila'], capture: null });
    mockedPickFromLibrary.mockResolvedValue({ error: 'Photo library access is required to choose a profile photo.' });

    const { getByTestId, findByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-portrait-choose-photo-button'));

    expect(await findByTestId('onb-portrait-error')).toBeTruthy();
    expect(mockCreateVersion).not.toHaveBeenCalled();
  });

  it('recovers a pending Android photo pick on mount and starts the portrait automatically', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockDraft({ kidNames: ['Lila'], capture: null });

    const pendingResult = { canceled: false, assets: [{ uri: 'file:///recovered.jpg' }] };
    mockedGetPendingResultAsync.mockResolvedValue(pendingResult as never);
    mockedParsePendingPickerResult.mockReturnValue({
      selection: {
        uri: 'file:///recovered.jpg',
        contentType: 'image/jpeg',
        captureDate: null,
        referenceDate: '2026-07-01',
        dateSource: 'default_today',
      },
    });

    const { getByText } = renderScreen();

    await waitFor(() => expect(mockCreateVersion).toHaveBeenCalledWith({
      photoUri: 'file:///recovered.jpg',
      photoContentType: 'image/jpeg',
      referenceDate: '2026-07-01',
      dateSource: 'default_today',
      dateOfBirth: '2022-03-14',
    }));
    expect(await waitFor(() => getByText("We're painting."))).toBeTruthy();
  });

  it('navigates to the journal from the painting state without waiting for generation to finish', async () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockDraft({ kidNames: ['Lila'], capture: null });
    mockedPickFromLibrary.mockResolvedValue({
      selection: {
        uri: 'file:///lila.jpg',
        contentType: 'image/jpeg',
        captureDate: null,
        referenceDate: '2026-07-01',
        dateSource: 'default_today',
      },
    });

    const { getByTestId, findByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-portrait-choose-photo-button'));
    fireEvent.press(await findByTestId('onb-portrait-journal-button'));

    expect(router.replace).toHaveBeenCalledWith(timelineRoute);
  });

  it('navigates to the reveal screen for the right member once the real status flips to ready', async () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockDraft({ kidNames: ['Lila'], capture: null });
    mockedPickFromLibrary.mockResolvedValue({
      selection: {
        uri: 'file:///lila.jpg',
        contentType: 'image/jpeg',
        captureDate: null,
        referenceDate: '2026-07-01',
        dateSource: 'default_today',
      },
    });
    mockCreateVersion.mockResolvedValue({ id: 'version-1', illustrated_profile_status: 'pending' });

    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onb-portrait-choose-photo-button'));
    expect(await screen.findByText("We're painting.")).toBeTruthy();

    // Simulate the poll (usePortraitVersions already refetches on its own --
    // see shouldPollPortraitVersions) discovering the generation finished.
    mockedUsePortraitVersions.mockReturnValue({
      createVersion: mockCreateVersion,
      isCreating: false,
      versions: [{ id: 'version-1', illustrated_profile_status: 'ready' }],
      retryVersion: jest.fn(),
    } as unknown as ReturnType<typeof usePortraitVersions>);
    screen.rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <PortraitScreen />
      </SafeAreaProvider>,
    );

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(onboardingRevealRoute('member-lila'));
    });
  });

  it('surfaces a failed generation warmly with a retry, keeping the journal escape available', async () => {
    mockedUseFamilyMembers.mockReturnValue({
      members: [LILA_MEMBER],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
    mockDraft({ kidNames: ['Lila'], capture: null });
    mockedPickFromLibrary.mockResolvedValue({
      selection: {
        uri: 'file:///lila.jpg',
        contentType: 'image/jpeg',
        captureDate: null,
        referenceDate: '2026-07-01',
        dateSource: 'default_today',
      },
    });
    mockCreateVersion.mockResolvedValue({ id: 'version-1', illustrated_profile_status: 'pending' });
    const mockRetryVersion = jest.fn().mockResolvedValue(undefined);
    mockedUsePortraitVersions.mockReturnValue({
      createVersion: mockCreateVersion,
      isCreating: false,
      versions: [{ id: 'version-1', illustrated_profile_status: 'failed' }],
      retryVersion: mockRetryVersion,
    } as unknown as ReturnType<typeof usePortraitVersions>);

    const { getByTestId, findByTestId, queryByText } = renderScreen();

    fireEvent.press(getByTestId('onb-portrait-choose-photo-button'));

    expect(await findByTestId('onb-portrait-failed-title')).toBeTruthy();
    // Warm, no-blame register -- never the raw status label or an alarm word.
    expect(queryByText('Portrait failed')).toBeNull();
    expect(getByTestId('onb-portrait-journal-button')).toBeTruthy();

    fireEvent.press(getByTestId('onb-portrait-retry-button'));

    await waitFor(() => {
      expect(mockRetryVersion).toHaveBeenCalledWith('version-1');
    });
  });
});
