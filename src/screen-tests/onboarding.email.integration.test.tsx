// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// Covers WP6's S12A change: the owner's display name is now collected on
// this screen (previously `requestSignUpOtp` was called with a hardcoded
// empty name, leaving user_profiles.name blank -- the name shown next to
// the owner's own comments/memories). Asserts both the enable-on-both-
// fields rule and that the trimmed name is actually threaded through to
// `requestSignUpOtp`.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingEmailScreen from '../../app/(onboarding)/email';
import { useAuth } from '@/hooks/use-auth';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { discardAnonymousSession } from '@/lib/anonymous-session';
import { createEmptyOnboardingDraft } from '@/utils/onboarding-progress';
import { spacing } from '@/constants/theme';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/lib/anonymous-session', () => ({
  discardAnonymousSession: jest.fn(),
}));

// createEmptyOnboardingDraft lives in the same module as the real
// AsyncStorage-backed persistence helpers (src/utils/onboarding-progress.ts)
// -- swap in the maintained mock so importing it doesn't pull in the native
// module under Jest (same pattern as onboarding.code.integration.test.tsx).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;
const mockedDiscardAnonymousSession = discardAnonymousSession as jest.MockedFunction<typeof discardAnonymousSession>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <OnboardingEmailScreen />
    </SafeAreaProvider>,
  );
}

describe('OnboardingEmailScreen (S12A) -- owner display name', () => {
  const requestSignUpOtp = jest.fn().mockResolvedValue({ error: null });

  beforeEach(() => {
    jest.clearAllMocks();
    requestSignUpOtp.mockResolvedValue({ error: null });
    mockedDiscardAnonymousSession.mockResolvedValue(undefined);

    mockedUseAuth.mockReturnValue({
      session: null,
      user: null,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp,
      verifyOtp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    } as never);

    mockedUseOnboardingFlow.mockReturnValue({
      draft: createEmptyOnboardingDraft('email'),
      isHydrated: true,
      patch: jest.fn(),
      clear: jest.fn(),
    });
  });

  it('keeps "Send my code" disabled until both the name and email fields are filled', async () => {
    const { getByTestId } = renderScreen();

    // Neither field filled.
    fireEvent.press(getByTestId('onboarding-email-send'));
    expect(requestSignUpOtp).not.toHaveBeenCalled();

    // Name only.
    fireEvent.changeText(getByTestId('onboarding-email-name-input'), 'Rosa');
    fireEvent.press(getByTestId('onboarding-email-send'));
    expect(requestSignUpOtp).not.toHaveBeenCalled();

    // Email only (name cleared) -- still blocked.
    fireEvent.changeText(getByTestId('onboarding-email-name-input'), '');
    fireEvent.changeText(getByTestId('onboarding-email-input'), 'rosa@rivera.family');
    fireEvent.press(getByTestId('onboarding-email-send'));
    expect(requestSignUpOtp).not.toHaveBeenCalled();

    // Both filled -- enabled.
    fireEvent.changeText(getByTestId('onboarding-email-name-input'), 'Rosa');
    fireEvent.press(getByTestId('onboarding-email-send'));
    await waitFor(() => {
      expect(requestSignUpOtp).toHaveBeenCalledWith({ name: 'Rosa', email: 'rosa@rivera.family' });
    });
  });

  it('reserves enough keyboard clearance to keep the email field below the focused name tappable', () => {
    const { getByTestId } = renderScreen();

    fireEvent(getByTestId('onboarding-email-name-input'), 'focus');

    expect(getByTestId('onb-shell-keyboard-frame').props.behavior).toBe('height');
    expect(getByTestId('onb-shell-scroll').props.bottomOffset).toBe(
      spacing.xxl * 5 + spacing.md,
    );
  });

  it('trims the name and threads it through to requestSignUpOtp, then navigates to the code screen', async () => {
    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('onboarding-email-name-input'), '  Rosa  ');
    fireEvent.changeText(getByTestId('onboarding-email-input'), '  ROSA@rivera.family  ');
    fireEvent.press(getByTestId('onboarding-email-send'));

    await waitFor(() => {
      expect(requestSignUpOtp).toHaveBeenCalledWith({ name: 'Rosa', email: 'rosa@rivera.family' });
    });

    expect(mockedDiscardAnonymousSession).toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(onboarding)/code',
        params: { email: 'rosa@rivera.family' },
      }),
    );
  });
});
