// Soft-editorial login restyle (app/(auth)/login.tsx). Routing/reviewer-
// password behavior is already covered end-to-end by
// reviewer-password.integration.test.tsx -- this file covers what changed
// with the restyle: the new keyboard-safe container, the mockup-matched
// copy (no em dash per docs/plans/onboarding-design-brief.md), the "Sign
// in" CTA states, and the dev/E2E password toggle staying functional.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import LoginScreen from '../../app/(auth)/login';
import { colors, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { isE2eFixturesEnabled } from '@/utils/e2e-fixtures';

jest.mock('expo-router', () => ({
  Link: jest.fn(({ children }: { children: React.ReactNode }) => children),
  router: {
    push: jest.fn(),
    replace: jest.fn(),
  },
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

// Mocked (rather than relying on ambient __DEV__) so each test controls the
// toggle's visibility explicitly -- matches the pattern already used by
// add-family-member-photo-date.integration.test.tsx.
jest.mock('@/utils/e2e-fixtures', () => ({
  isE2eFixturesEnabled: jest.fn(),
}));

const { router, Link: mockLink } = jest.requireMock('expo-router') as {
  router: { push: jest.Mock; replace: jest.Mock };
  Link: jest.Mock;
};
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedIsE2eFixturesEnabled = isE2eFixturesEnabled as jest.MockedFunction<
  typeof isE2eFixturesEnabled
>;
const requestSignInOtp = jest.fn();
const signInWithPassword = jest.fn();

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <LoginScreen />
    </SafeAreaProvider>,
  );
}

describe('LoginScreen (soft editorial)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestSignInOtp.mockResolvedValue({ error: null, userNotFound: false });
    mockedUseAuth.mockReturnValue({
      requestSignInOtp,
      signInWithPassword,
    } as never);
    mockedIsE2eFixturesEnabled.mockReturnValue(false);
  });

  describe('layout and copy', () => {
    it('renders the wordmark and the two-line "Welcome back." headline', () => {
      const { getByTestId, getByText } = renderScreen();

      expect(getByTestId('login-wordmark')).toBeTruthy();
      // RNTL's default text normalizer collapses the headline's embedded
      // "\n" (the two-line "Welcome" / "back." break) to a single space.
      expect(getByText('Welcome back.')).toBeTruthy();
    });

    it('uses the design-brief subtitle without an em dash', () => {
      const { getByText, queryByText } = renderScreen();

      expect(
        getByText('Pick up where you left off. Your moments are waiting.'),
      ).toBeTruthy();
      // The mockup's original copy used an em dash, forbidden by
      // docs/plans/onboarding-design-brief.md's copy rules.
      expect(queryByText(/—/)).toBeNull();
    });

    it('keeps the focused email field and the Sign in button above the keyboard', () => {
      const { getByTestId } = renderScreen();
      const scrollView = getByTestId('login-screen-scroll');

      fireEvent(getByTestId('login-email-input'), 'focus');

      expect(scrollView.props.bottomOffset).toBe(spacing.xxl * 2);
      expect(scrollView.props.disableScrollOnKeyboardHide).toBe(true);
      expect(scrollView.props.keyboardShouldPersistTaps).toBe('handled');
      expect(scrollView.props.mode).toBe('insets');
    });
  });

  describe('Sign in CTA', () => {
    it('disables Sign in until an email is entered, then requests a code', async () => {
      const { getByTestId, getByText } = renderScreen();

      expect(getByTestId('login-submit-button').props.accessibilityState).toEqual({
        disabled: true,
      });

      fireEvent.changeText(getByTestId('login-email-input'), 'parent@example.com');
      expect(getByText('Sign in')).toBeTruthy();

      fireEvent.press(getByTestId('login-submit-button'));

      await waitFor(() => {
        expect(requestSignInOtp).toHaveBeenCalledWith('parent@example.com');
        expect(router.push).toHaveBeenCalledWith({
          pathname: '/(auth)/verify-otp',
          params: { email: 'parent@example.com', mode: 'signin' },
        });
      });
    });

    it('shows a sending state while the OTP request is in flight', async () => {
      let resolveRequest!: (value: { error: null; userNotFound: false }) => void;
      requestSignInOtp.mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
      );

      const { getByTestId, getByText } = renderScreen();

      fireEvent.changeText(getByTestId('login-email-input'), 'parent@example.com');
      fireEvent.press(getByTestId('login-submit-button'));

      await waitFor(() => {
        expect(getByText('Sending code…')).toBeTruthy();
      });

      resolveRequest({ error: null, userNotFound: false });

      await waitFor(() => {
        expect(router.push).toHaveBeenCalled();
      });
    });
  });

  describe('dev/E2E password toggle', () => {
    it('stays hidden and inert when E2E fixtures are disabled (production)', () => {
      mockedIsE2eFixturesEnabled.mockReturnValue(false);

      const { queryByTestId } = renderScreen();

      expect(queryByTestId('login-dev-toggle-button')).toBeNull();
      expect(queryByTestId('login-password-input')).toBeNull();
      expect(queryByTestId('login-dev-submit-button')).toBeNull();
    });

    it('reveals the password field and signs in with password when toggled on', async () => {
      mockedIsE2eFixturesEnabled.mockReturnValue(true);

      const { getByTestId, queryByTestId } = renderScreen();

      expect(queryByTestId('login-password-input')).toBeNull();

      fireEvent.press(getByTestId('login-dev-toggle-button'));

      expect(getByTestId('login-password-input')).toBeTruthy();

      fireEvent.changeText(getByTestId('login-email-input'), 'dev@example.com');
      fireEvent.changeText(getByTestId('login-password-input'), 'super-secret');

      signInWithPassword.mockResolvedValue({ error: null });
      fireEvent.press(getByTestId('login-dev-submit-button'));

      await waitFor(() => {
        expect(signInWithPassword).toHaveBeenCalledWith({
          email: 'dev@example.com',
          password: 'super-secret',
        });
        expect(router.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline');
      });
    });

    it('disables the dev submit button until email and password are both filled in', () => {
      mockedIsE2eFixturesEnabled.mockReturnValue(true);

      const { getByTestId } = renderScreen();

      fireEvent.press(getByTestId('login-dev-toggle-button'));

      expect(getByTestId('login-dev-submit-button').props.accessibilityState).toEqual({
        disabled: true,
      });

      fireEvent.changeText(getByTestId('login-email-input'), 'dev@example.com');
      fireEvent.changeText(getByTestId('login-password-input'), 'super-secret');

      expect(getByTestId('login-dev-submit-button').props.accessibilityState).toEqual({
        disabled: false,
      });
    });
  });

  it('keeps the primary/bold color mapping for the "Create an account" link', () => {
    renderScreen();

    // The Link mock (like reviewer-password.integration.test.tsx's) renders
    // only its children, discarding props -- so style is asserted on the
    // recorded call instead of the rendered tree.
    const [props] = mockLink.mock.calls[mockLink.mock.calls.length - 1];
    const flatStyle = Object.assign({}, ...[].concat(props.style));
    expect(flatStyle.color).toBe(colors.primary);
    expect(flatStyle.fontWeight).toBe('700');
  });
});
