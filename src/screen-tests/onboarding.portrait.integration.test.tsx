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
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { router, useFocusEffect } from 'expo-router';
import { AccessibilityInfo, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PortraitScreen, { PORTRAIT_ROTATION_INTERVAL_MS } from '../../app/(onboarding)/portrait';
import { onboardingPortraitPairs } from '@/constants/onboarding-portrait-pairs';
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
  // Default: a no-op, same as onboarding.year.integration.test.tsx -- most
  // cases in this file don't exercise the pick-state rotation this drives,
  // so leaving it inert keeps them from racing a real interval. The
  // rotation-specific tests below override this per-test to actually invoke
  // (and later clean up) the effect.
  useFocusEffect: jest.fn(),
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
const mockedUseFocusEffect = useFocusEffect as jest.MockedFunction<typeof useFocusEffect>;
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
    // jest.clearAllMocks() (above) only clears call history, not a custom
    // implementation a test installed via mockImplementation -- reset back
    // to the inert default so a rotation test's real callback-invoking
    // implementation can never leak into an unrelated test.
    mockedUseFocusEffect.mockImplementation(() => undefined);
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

  describe('pick-state before/after rotation (PROBLEM 1 fix)', () => {
    // These tests need useFocusEffect to actually run its effect (and later
    // its cleanup) -- unlike every other test above, which relies on the
    // inert default so an unrelated test can't race a real interval. This
    // local override is undone by the outer afterEach.
    function focusAndCaptureCleanup() {
      let cleanup: (() => void) | undefined;
      mockedUseFocusEffect.mockImplementation((callback) => {
        cleanup = (callback() ?? undefined) as (() => void) | undefined;
      });
      return () => cleanup?.();
    }

    beforeEach(() => {
      mockedUseFamilyMembers.mockReturnValue({
        members: [LILA_MEMBER],
        isLoading: false,
      } as unknown as ReturnType<typeof useFamilyMembers>);
      mockDraft({ kidNames: ['Lila'], capture: null });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('shows the first bundled demo pair (not a placeholder + fixed finished portrait) and cross-fades on advance', async () => {
      jest.useFakeTimers();
      const stopFocus = focusAndCaptureCleanup();
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
      const removeListener = jest.fn();
      jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: removeListener } as never);

      const { getByTestId } = renderScreen();

      const before = () => getByTestId('onb-portrait-before-image');
      const after = () => getByTestId('onb-portrait-after-image');

      // Real photo on the left, its illustrated portrait on the right --
      // never the old empty-placeholder + fixed portrait-sample pairing.
      expect(before().props.source[0]).toBe(onboardingPortraitPairs[0].photo);
      expect(after().props.source[0]).toBe(onboardingPortraitPairs[0].portrait);
      // Cross-fade, not a hard cut: both images carry a positive transition duration
      // (expo-image normalizes a numeric `transition` prop into { duration } internally).
      expect(before().props.transition?.duration).toBeGreaterThan(0);
      expect(after().props.transition?.duration).toBeGreaterThan(0);

      // Let the isReduceMotionEnabled() microtask resolve and start the interval.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(PORTRAIT_ROTATION_INTERVAL_MS);
      });

      expect(before().props.source[0]).toBe(onboardingPortraitPairs[1].photo);
      expect(after().props.source[0]).toBe(onboardingPortraitPairs[1].portrait);

      stopFocus();
    });

    it('holds on one pair when reduce motion is enabled, instead of rotating', async () => {
      jest.useFakeTimers();
      const stopFocus = focusAndCaptureCleanup();
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
      jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);

      const { getByTestId } = renderScreen();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(PORTRAIT_ROTATION_INTERVAL_MS * 3);
      });

      expect(getByTestId('onb-portrait-before-image').props.source[0]).toBe(onboardingPortraitPairs[0].photo);
      expect(getByTestId('onb-portrait-after-image').props.source[0]).toBe(onboardingPortraitPairs[0].portrait);

      stopFocus();
    });

    it('stops advancing once the screen loses focus, so the Stack keeping S16 mounted underneath S17 cannot leak a running timer', async () => {
      jest.useFakeTimers();
      const stopFocus = focusAndCaptureCleanup();
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
      jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);

      const { getByTestId } = renderScreen();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Simulate the screen losing focus (S17's sibling chain, "Take me to
      // the journal", etc.) -- the Stack keeps this screen mounted, so only
      // the focus-effect cleanup (not unmount) stops the timer in practice.
      stopFocus();

      await act(async () => {
        jest.advanceTimersByTime(PORTRAIT_ROTATION_INTERVAL_MS * 3);
      });

      expect(getByTestId('onb-portrait-before-image').props.source[0]).toBe(onboardingPortraitPairs[0].photo);
    });
  });
});
