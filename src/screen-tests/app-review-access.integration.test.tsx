import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { KeyboardAvoidingView } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import AppReviewAccessScreen from '../../app/(auth)/app-review-access';
import LoginScreen from '../../app/(auth)/login';
import { useAuth } from '@/hooks/use-auth';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  router: {
    push: jest.fn(),
    replace: jest.fn(),
  },
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

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

describe('app review access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({
      requestSignInOtp,
      signInWithPassword,
    } as never);
  });

  it('keeps OTP primary and opens reviewer access from a separate, low-profile action', () => {
    const { getByTestId } = renderScreen(<LoginScreen />);

    expect(getByTestId('login-submit-button')).toBeTruthy();
    fireEvent.press(getByTestId('app-review-access-link'));

    expect(router.push).toHaveBeenCalledWith('/(auth)/app-review-access');
  });

  it('is keyboard-safe, labels its fields, masks the password, and disables an incomplete form', () => {
    const { getByLabelText, getByTestId, UNSAFE_getByType } = renderScreen(
      <AppReviewAccessScreen />,
    );

    expect(UNSAFE_getByType(KeyboardAvoidingView)).toBeTruthy();
    expect(getByLabelText('Reviewer email')).toBeTruthy();
    expect(getByLabelText('Reviewer password').props.secureTextEntry).toBe(true);
    expect(getByTestId('app-review-submit-button').props.accessibilityState).toEqual({
      disabled: true,
    });
  });

  it('submits trimmed reviewer credentials and shows a loading state', async () => {
    let resolveSignIn!: (value: { error: null }) => void;
    signInWithPassword.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );

    const { getByTestId, getByText } = renderScreen(<AppReviewAccessScreen />);

    fireEvent.changeText(getByTestId('app-review-email-input'), '  reviewer@example.com  ');
    fireEvent.changeText(getByTestId('app-review-password-input'), 'secret-password');
    fireEvent.press(getByTestId('app-review-submit-button'));

    await waitFor(() => {
      expect(getByText('Signing in…')).toBeTruthy();
    });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'reviewer@example.com',
      password: 'secret-password',
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

    const { findByRole, getByTestId, getByText } = renderScreen(<AppReviewAccessScreen />);

    fireEvent.changeText(getByTestId('app-review-email-input'), 'reviewer@example.com');
    fireEvent.changeText(getByTestId('app-review-password-input'), 'incorrect-password');
    fireEvent.press(getByTestId('app-review-submit-button'));

    expect(await findByRole('alert')).toHaveTextContent('Invalid login credentials');
    expect(getByText('App review access')).toBeTruthy();
    expect(getByTestId('app-review-email-input')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
