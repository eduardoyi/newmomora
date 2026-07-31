// Deliberately outside app/ -- expo-router's require.context picks up every
// .ts(x) file under app/ as a route (see no-family.test.tsx for the full
// rationale), so screen tests live here and import the screen via a
// relative path instead.
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import KidsScreen from '../../app/(onboarding)/kids';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingFamilyNameRoute } from '@/lib/onboarding-routes';
import { createEmptyOnboardingDraft } from '@/utils/onboarding-progress';
import { FOOTER_KEYBOARD_CLEARANCE } from '@/components/onboarding/onb-shell';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
  },
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
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

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <KidsScreen />
    </SafeAreaProvider>,
  );
}

describe('KidsScreen (S6)', () => {
  const patch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseOnboardingFlow.mockReturnValue({
      draft: createEmptyOnboardingDraft('kids'),
      isHydrated: true,
      patch,
      clear: jest.fn(),
    });
  });

  it('writes the step to the draft on mount so the flow is resumable', () => {
    renderScreen();

    expect(patch).toHaveBeenCalledWith({ step: 'kids' });
  });

  it('adds kids as chips, removes one, and still continues with an un-added typed name', () => {
    const { getByTestId, getByText, queryByText } = renderScreen();

    fireEvent.changeText(getByTestId('onb-kids-input'), 'Lila');
    fireEvent.press(getByTestId('onb-kids-add-button'));
    expect(getByText('Lila')).toBeTruthy();
    // The field clears and re-prompts for the next kid once a chip exists.
    expect(getByTestId('onb-kids-input').props.value).toBe('');
    expect(getByTestId('onb-kids-input').props.placeholder).toBe('And their name');

    fireEvent.changeText(getByTestId('onb-kids-input'), 'Miguel');
    fireEvent.press(getByTestId('onb-kids-add-button'));
    expect(getByText('Miguel')).toBeTruthy();

    // Remove the first chip (Lila) -- Miguel stays.
    fireEvent.press(getByTestId('onb-kids-chip-0-remove'));
    expect(queryByText('Lila')).toBeNull();
    expect(getByText('Miguel')).toBeTruthy();

    // Type a third name but never tap "+ Add another kiddo" -- Continue
    // must still pick it up (a parent who types one name and never taps add
    // must not be blocked).
    fireEvent.changeText(getByTestId('onb-kids-input'), 'Teo');
    fireEvent.press(getByTestId('onb-kids-continue-button'));

    expect(patch).toHaveBeenCalledWith({ kidNames: ['Miguel', 'Teo'] });
    expect(router.push).toHaveBeenCalledWith(onboardingFamilyNameRoute);
  });

  it('continues on a single un-added typed name with no chips at all', () => {
    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('onb-kids-input'), 'Lila');
    fireEvent.press(getByTestId('onb-kids-continue-button'));

    expect(patch).toHaveBeenCalledWith({ kidNames: ['Lila'] });
    expect(router.push).toHaveBeenCalledWith(onboardingFamilyNameRoute);
  });

  it('disables Continue while neither a chip nor typed text exists', () => {
    const { getByTestId } = renderScreen();

    expect(getByTestId('onb-kids-continue-button').props.accessibilityState.disabled).toBe(true);
  });

  it('enables Continue as soon as a name is typed, even before it is added as a chip', () => {
    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('onb-kids-input'), 'Lila');

    expect(getByTestId('onb-kids-continue-button').props.accessibilityState.disabled).toBe(false);
  });

  it('keeps its primary action in the resized shell frame when the name field is focused', () => {
    const { getByTestId } = renderScreen();

    fireEvent(getByTestId('onb-kids-input'), 'focus');

    const scrollView = getByTestId('onb-shell-scroll');
    // Device-testing fix (2026-07-31, onb-shell.tsx): the shell no longer
    // wraps its frame in a `KeyboardAvoidingView` (that layout-capture bug
    // is what put the CTA under the Android nav bar on device -- see
    // onb-shell.tsx's header comment) -- `onb-shell-sticky-footer`
    // (`KeyboardStickyView`) is what keeps the footer above the keyboard
    // now.
    const stickyFooter = getByTestId('onb-shell-sticky-footer');
    let ancestor = getByTestId('onb-kids-continue-button').parent;

    expect(getByTestId('onb-shell-footer')).toBeTruthy();
    expect(stickyFooter).toBeTruthy();
    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);
    while (ancestor) {
      expect(ancestor).not.toBe(scrollView);
      ancestor = ancestor.parent;
    }
  });

  it('ignores the add affordance while the field is empty', () => {
    const { getByTestId, queryByText } = renderScreen();

    fireEvent.press(getByTestId('onb-kids-add-button'));

    expect(queryByText('Lila')).toBeNull();
    expect(patch).not.toHaveBeenCalledWith(expect.objectContaining({ kidNames: expect.anything() }));
  });

  it('resumes with previously-entered kid names shown as chips', () => {
    mockedUseOnboardingFlow.mockReturnValue({
      draft: { ...createEmptyOnboardingDraft('kids'), kidNames: ['Lila', 'Miguel'] },
      isHydrated: true,
      patch,
      clear: jest.fn(),
    });

    const { getByText } = renderScreen();

    expect(getByText('Lila')).toBeTruthy();
    expect(getByText('Miguel')).toBeTruthy();
  });
});
