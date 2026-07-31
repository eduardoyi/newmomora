// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// Covers WP2's S9 (docs/plans/onboarding-implementation.md): the typed-entry
// path (voice needs a real device/expo-audio native module, so it's mocked
// out entirely here -- the voice failure->typing degrade path is exercised
// via a rejected ensureAnonymousSession, which needs no native recording at
// all) and the keyboard-avoidance contract every high-risk TextInput screen
// must satisfy (CLAUDE.md, in the spirit of keyboard-aware-form-screen.test.tsx).
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingCaptureScreen from '../../app/(onboarding)/capture';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { ensureAnonymousSession } from '@/lib/anonymous-session';
import { onboardingAhaRoute } from '@/lib/onboarding-routes';
import { processOnboardingVoiceMemory } from '@/services/ai';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';
import { FOOTER_KEYBOARD_CLEARANCE } from '@/components/onboarding/onb-shell';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/lib/anonymous-session', () => ({
  ensureAnonymousSession: jest.fn(),
}));

jest.mock('@/services/ai', () => ({
  processOnboardingVoiceMemory: jest.fn(),
}));

jest.mock('@/utils/local-files', () => ({
  readLocalFileAsBase64: jest.fn(),
}));

jest.mock('@/utils/native-permissions', () => ({
  getOrRequestNativePermission: jest.fn(),
  waitForNativePresentationToSettle: jest.fn().mockResolvedValue(undefined),
}));

// createEmptyOnboardingDraft lives in the same module as the real
// AsyncStorage-backed persistence helpers (src/utils/onboarding-progress.ts)
// -- swap in the maintained mock so importing it doesn't pull in the native
// module under Jest (same pattern as onboarding.paywall.integration.test.tsx).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// expo-audio's native recorder has no Jest double -- these stubs are only
// exercised by the voice path, which this suite doesn't drive (the
// ensure-anonymous-session failure test degrades to typing before the
// recorder is ever touched).
jest.mock('expo-audio', () => ({
  useAudioRecorder: jest.fn(() => ({
    prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
    record: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
    uri: null,
  })),
  useAudioRecorderState: jest.fn(() => ({ isRecording: false, durationMillis: 0 })),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  AudioModule: {
    getRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
    requestRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
  },
  RecordingPresets: { HIGH_QUALITY: {} },
}));

// Photo/video attachment is MemoryMediaPicker's own concern (tested
// elsewhere) -- stubbed out here the same way new-memory.integration.test.tsx
// stubs VoiceSpeakItModal, keeping this suite focused on the typed path.
jest.mock('@/components/memory-media-picker', () => ({
  MemoryMediaPicker: () => null,
}));

// lucide-react-native (Mic, Square, Type, X) is stubbed globally in
// jest.setup.ts -- no per-file mock needed here.

const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;
const mockedEnsureAnonymousSession = ensureAnonymousSession as jest.MockedFunction<typeof ensureAnonymousSession>;
const mockedProcessOnboardingVoiceMemory = processOnboardingVoiceMemory as jest.MockedFunction<
  typeof processOnboardingVoiceMemory
>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <OnboardingCaptureScreen />
    </SafeAreaProvider>,
  );
}

function mockDraft(overrides: Partial<OnboardingDraft>, patch = jest.fn()) {
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('capture'), ...overrides },
    isHydrated: true,
    patch,
    clear: jest.fn(),
  });
  return patch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedEnsureAnonymousSession.mockResolvedValue({ error: null });
});

describe('OnboardingCaptureScreen (S9) -- typed path', () => {
  it('keeps "Keep this one" disabled until text is entered, then patches the draft and navigates to the aha screen', () => {
    const patch = mockDraft({ kidNames: ['Lila'] });

    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-capture-type-instead'));

    expect(screen.getByTestId('onboarding-capture-keep').props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(
      screen.getByTestId('onboarding-capture-textarea'),
      'She lined up her stuffed animals to watch for the garbage truck.',
    );

    expect(screen.getByTestId('onboarding-capture-keep').props.accessibilityState.disabled).toBe(false);

    fireEvent.press(screen.getByTestId('onboarding-capture-keep'));

    expect(patch).toHaveBeenCalledWith({
      capture: {
        text: 'She lined up her stuffed animals to watch for the garbage truck.',
        mediaUri: undefined,
        mediaContentType: undefined,
        taggedKidIndexes: [0],
      },
      step: 'aha',
    });
    expect(router.push).toHaveBeenCalledWith(onboardingAhaRoute);
  });

  it('does not advance when the textarea is only whitespace', () => {
    mockDraft({ kidNames: ['Lila'] });
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-capture-type-instead'));
    fireEvent.changeText(screen.getByTestId('onboarding-capture-textarea'), '   ');
    fireEvent.press(screen.getByTestId('onboarding-capture-keep'));

    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows selectable kid chips for a multi-kid family and tags the memory to the selection made', () => {
    const patch = mockDraft({ kidNames: ['Lila', 'Miguel'] });
    const screen = renderScreen();

    expect(screen.getByTestId('onboarding-capture-kid-chips')).toBeTruthy();
    // First kid is pre-selected by default.
    expect(screen.getByTestId('onboarding-capture-kid-chip-0').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('onboarding-capture-kid-chip-1').props.accessibilityState.selected).toBe(false);

    fireEvent.press(screen.getByTestId('onboarding-capture-kid-chip-1'));
    fireEvent.press(screen.getByTestId('onboarding-capture-type-instead'));
    fireEvent.changeText(screen.getByTestId('onboarding-capture-textarea'), 'Sibling moment.');
    fireEvent.press(screen.getByTestId('onboarding-capture-keep'));

    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ capture: expect.objectContaining({ taggedKidIndexes: [0, 1] }) }),
    );
  });

  it('never lets the selection empty out -- tapping the sole selected chip again keeps it selected', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'] });
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-capture-kid-chip-0'));

    expect(screen.getByTestId('onboarding-capture-kid-chip-0').props.accessibilityState.selected).toBe(true);
  });

  it('degrades to typing with warm copy, never mentioning quotas or limits, when ensureAnonymousSession fails', async () => {
    mockDraft({ kidNames: ['Lila'] });
    mockedEnsureAnonymousSession.mockResolvedValue({ error: { message: 'anonymous sign-ins disabled' } });

    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-capture-mic'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-capture-textarea')).toBeTruthy();
    });

    const note = screen.getByTestId('onboarding-capture-fallback-note').props.children;
    expect(String(note).toLowerCase()).not.toMatch(/quota|limit/);
    expect(mockedProcessOnboardingVoiceMemory).not.toHaveBeenCalled();
  });
});

describe('OnboardingCaptureScreen (S9) -- keyboard avoidance', () => {
  it('keeps the focused composer in the scroll view while its primary action lives in the keyboard-sticky region', () => {
    mockDraft({ kidNames: ['Lila'] });
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-capture-type-instead'));
    fireEvent(screen.getByTestId('onboarding-capture-textarea'), 'focus');

    const scrollView = screen.getByTestId('onb-shell-scroll');
    let keepButtonAncestor = screen.getByTestId('onboarding-capture-keep').parent;

    expect(screen.getByTestId('onb-shell-footer')).toBeTruthy();
    while (keepButtonAncestor) {
      expect(keepButtonAncestor).not.toBe(scrollView);
      keepButtonAncestor = keepButtonAncestor.parent;
    }
    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);
    expect(scrollView.props.disableScrollOnKeyboardHide).toBe(false);
    expect(scrollView.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scrollView.props.mode).toBe('insets');
  });
});
