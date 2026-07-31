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

// Photo/video attachment picking itself (permissions, library/camera
// launch) is MemoryMediaPicker's own concern (tested elsewhere) -- stubbed
// out here the same way new-memory.integration.test.tsx stubs
// VoiceSpeakItModal, keeping this suite focused on capture.tsx's own logic.
// Unlike a bare `() => null`, this exposes the real `onSelect` callback
// behind a pressable test hook so the media-sizing regression test below
// can drive capture.tsx's handleAddMedia with a picked MediaAttachment
// (including aspectRatio/durationMs) exactly as the real picker would.
jest.mock('@/components/memory-media-picker', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  const { Pressable } = require('react-native') as typeof import('react-native');
  return {
    MemoryMediaPicker: ({
      onSelect,
    }: {
      onSelect: (attachments: Array<{
        id: string;
        uri: string;
        contentType: string;
        aspectRatio?: number;
        durationMs?: number;
        sizeBytes: number;
      }>) => void;
    }) => (
      <Pressable
        onPress={() =>
          onSelect([
            {
              id: 'attachment-1',
              uri: 'file:///photo.jpg',
              contentType: 'image/jpeg',
              aspectRatio: 0.75,
              sizeBytes: 1000,
            },
          ])
        }
        testID="onboarding-capture-media-picker-mock"
      />
    ),
  };
});

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

  // Regression test for the media-sizing bug (docs high-risk note: onboarding
  // photos rendered pillarboxed in the timeline because the captured
  // aspect ratio never left this screen). MemoryMediaPicker already computes
  // aspectRatio via aspectRatioFromDimensions before handing back the
  // MediaAttachment (see the mock above) -- this asserts capture.tsx
  // threads that value into the patched draft instead of dropping it.
  it('threads the picked media’s aspect ratio through to the patched draft capture', () => {
    const patch = mockDraft({ kidNames: ['Lila'] });
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-capture-type-instead'));
    fireEvent.press(screen.getByTestId('onboarding-capture-media-picker-mock'));
    fireEvent.press(screen.getByTestId('onboarding-capture-keep'));

    expect(patch).toHaveBeenCalledWith({
      capture: {
        text: '',
        mediaUri: 'file:///photo.jpg',
        mediaContentType: 'image/jpeg',
        mediaAspectRatio: 0.75,
        mediaDurationMs: undefined,
        taggedKidIndexes: [0],
      },
      step: 'aha',
    });
  });

  it('does not advance when the textarea is only whitespace', () => {
    mockDraft({ kidNames: ['Lila'] });
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-capture-type-instead'));
    fireEvent.changeText(screen.getByTestId('onboarding-capture-textarea'), '   ');
    fireEvent.press(screen.getByTestId('onboarding-capture-keep'));

    expect(router.push).not.toHaveBeenCalled();
  });

  it('pre-selects every kid by default for a multi-kid family (not just the first-entered one)', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'] });
    const screen = renderScreen();

    expect(screen.getByTestId('onboarding-capture-kid-chips')).toBeTruthy();
    expect(screen.getByTestId('onboarding-capture-kid-chip-0').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('onboarding-capture-kid-chip-1').props.accessibilityState.selected).toBe(true);
    // capturePrompt's "two of them" ladder rung, driven by both being selected.
    expect(screen.getByText("What's something small the two of them did this week that made you smile?")).toBeTruthy();
  });

  it('pre-selects all kids for 3 and 5-kid families, leaning on the "all of them" copy ladder rung instead of naming everyone', () => {
    const threeKids = mockDraft({ kidNames: ['Lila', 'Miguel', 'Teo'] });
    const threeScreen = renderScreen();
    expect(threeScreen.getByTestId('onboarding-capture-kid-chip-0').props.accessibilityState.selected).toBe(true);
    expect(threeScreen.getByTestId('onboarding-capture-kid-chip-1').props.accessibilityState.selected).toBe(true);
    expect(threeScreen.getByTestId('onboarding-capture-kid-chip-2').props.accessibilityState.selected).toBe(true);
    expect(
      threeScreen.getByText("What's something small all of them did this week that made you smile?"),
    ).toBeTruthy();
    void threeKids;

    mockDraft({ kidNames: ['Lila', 'Miguel', 'Teo', 'Ana', 'Sam'] });
    const fiveScreen = renderScreen();
    for (let index = 0; index < 5; index += 1) {
      expect(
        fiveScreen.getByTestId(`onboarding-capture-kid-chip-${index}`).props.accessibilityState.selected,
      ).toBe(true);
    }
    expect(
      fiveScreen.getByText("What's something small all of them did this week that made you smile?"),
    ).toBeTruthy();
  });

  it('deselecting a chip down to the last one tags only that kid, and tapping it again keeps it selected', () => {
    const patch = mockDraft({ kidNames: ['Lila', 'Miguel'] });
    const screen = renderScreen();

    // Both start selected; deselect Miguel to narrow the tag to Lila alone.
    fireEvent.press(screen.getByTestId('onboarding-capture-kid-chip-1'));
    expect(screen.getByTestId('onboarding-capture-kid-chip-0').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('onboarding-capture-kid-chip-1').props.accessibilityState.selected).toBe(false);

    // Never lets the selection empty out -- tapping the sole remaining chip is a no-op.
    fireEvent.press(screen.getByTestId('onboarding-capture-kid-chip-0'));
    expect(screen.getByTestId('onboarding-capture-kid-chip-0').props.accessibilityState.selected).toBe(true);

    fireEvent.press(screen.getByTestId('onboarding-capture-type-instead'));
    fireEvent.changeText(screen.getByTestId('onboarding-capture-textarea'), 'Lila moment.');
    fireEvent.press(screen.getByTestId('onboarding-capture-keep'));

    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ capture: expect.objectContaining({ taggedKidIndexes: [0] }) }),
    );
  });

  it('a manual deselect wins over auto-tagging -- typing the deselected kid’s name does not silently re-select them', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'] });
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-capture-kid-chip-1'));
    expect(screen.getByTestId('onboarding-capture-kid-chip-1').props.accessibilityState.selected).toBe(false);

    fireEvent.press(screen.getByTestId('onboarding-capture-type-instead'));
    fireEvent.changeText(
      screen.getByTestId('onboarding-capture-textarea'),
      'Miguel built a blanket fort in the living room.',
    );

    expect(screen.getByTestId('onboarding-capture-kid-chip-1').props.accessibilityState.selected).toBe(false);
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
  it('keeps the focused composer in the scroll view while its primary action stays in the resized shell frame', () => {
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
