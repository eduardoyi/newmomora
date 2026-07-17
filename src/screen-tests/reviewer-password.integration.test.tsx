import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { KeyboardAvoidingView } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PasswordScreen from '../../app/(auth)/password';
import LoginScreen from '../../app/(auth)/login';
import { useAuth } from '@/hooks/use-auth';
import { REVIEWER_EMAIL } from '@/services/reviewer-auth';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: jest.fn(() => null),
  router: {
    push: jest.fn(),
    replace: jest.fn(),
  },
  useLocalSearchParams: jest.fn(),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

const { Redirect: mockRedirect, router, useLocalSearchParams: mockUseLocalSearchParams } = jest.requireMock('expo-router') as {
  Redirect: jest.Mock;
  router: { push: jest.Mock; replace: jest.Mock };
  useLocalSearchParams: jest.Mock;
};
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const requestSignInOtp = jest.fn();
const signInWithPassword = jest.fn();

function renderScreen(screen: React.ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {screen}
    </SafeAreaProvider>,
  );
}

describe('reviewer password sign-in', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalSearchParams.mockReturnValue({ email: REVIEWER_EMAIL });
    requestSignInOtp.mockResolvedValue({ error: null, userNotFound: false });
    mockedUseAuth.mockReturnValue({
      requestSignInOtp,
      signInWithPassword,
    } as never);
  });

  it('uses the normal email field to enter the password branch after normalizing the reviewer email', async () => {
    const { getByTestId, queryByText } = renderScreen(<LoginScreen />);

    fireEvent.changeText(getByTestId('login-email-input'), '  HELLO+TESTING@USEMOMORA.COM  ');
    fireEvent.press(getByTestId('login-submit-button'));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith({
        pathname: '/(auth)/password',
        params: { email: REVIEWER_EMAIL },
      });
    });
    expect(queryByText('Sending code…')).toBeNull();
    expect(requestSignInOtp).not.toHaveBeenCalled();
    expect(queryByText('App review access')).toBeNull();
    expect(queryByText(/App Store|Google Play|reviewer/i)).toBeNull();
  });

  it('keeps the normal OTP flow unchanged for other emails', async () => {
    const { getByTestId } = renderScreen(<LoginScreen />);

    fireEvent.changeText(getByTestId('login-email-input'), '  parent@example.com  ');
    fireEvent.press(getByTestId('login-submit-button'));

    await waitFor(() => {
      expect(requestSignInOtp).toHaveBeenCalledWith('parent@example.com');
      expect(router.push).toHaveBeenCalledWith({
        pathname: '/(auth)/verify-otp',
        params: { email: 'parent@example.com', mode: 'signin' },
      });
    });
  });

  it('redirects direct password-route access with another email before rendering the form', () => {
    mockUseLocalSearchParams.mockReturnValue({ email: 'parent@example.com' });

    const { queryByTestId } = renderScreen(<PasswordScreen />);

    expect(mockRedirect).toHaveBeenCalledWith(
      { href: '/(auth)/login' },
      undefined,
    );
    expect(queryByTestId('password-input')).toBeNull();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['array', { email: [REVIEWER_EMAIL] }],
  ])('redirects a %s route email before rendering the password form', (_case, params) => {
    mockUseLocalSearchParams.mockReturnValue(params);

    const { queryByTestId } = renderScreen(<PasswordScreen />);

    expect(mockRedirect).toHaveBeenCalledWith(
      { href: '/(auth)/login' },
      undefined,
    );
    expect(queryByTestId('password-input')).toBeNull();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('is keyboard-safe, shows the selected email, masks the password, and disables an incomplete form', () => {
    const { getByLabelText, getByTestId, getByText, UNSAFE_getByType } = renderScreen(
      <PasswordScreen />,
    );

    expect(UNSAFE_getByType(KeyboardAvoidingView)).toBeTruthy();
    expect(getByText(`Sign in as ${REVIEWER_EMAIL}.`)).toBeTruthy();
    expect(getByLabelText('Password').props.secureTextEntry).toBe(true);
    expect(getByTestId('password-submit-button').props.accessibilityState).toEqual({
      disabled: true,
    });
  });

  it('shows loading, submits only the guarded email, and routes to the timeline on success', async () => {
    let resolveSignIn!: (value: { error: null }) => void;
    signInWithPassword.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );

    const { getByTestId, getByText } = renderScreen(<PasswordScreen />);

    fireEvent.changeText(getByTestId('password-input'), 'test-password');
    fireEvent.press(getByTestId('password-submit-button'));

    await waitFor(() => {
      expect(getByText('Signing in…')).toBeTruthy();
    });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: REVIEWER_EMAIL,
      password: 'test-password',
    });

    resolveSignIn({ error: null });

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline');
    });
  });

  it('shows invalid-credential errors without navigating', async () => {
    signInWithPassword.mockResolvedValue({
      error: { message: 'Invalid login credentials', code: 'invalid_credentials' },
    });

    const { findByRole, getByTestId, getByText } = renderScreen(<PasswordScreen />);

    fireEvent.changeText(getByTestId('password-input'), 'incorrect-password');
    fireEvent.press(getByTestId('password-submit-button'));

    expect(await findByRole('alert')).toHaveTextContent('Invalid login credentials');
    expect(getByText('Enter your password')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
