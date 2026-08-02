import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { KeyboardController } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import VerifyOtpScreen from '../../app/(auth)/verify-otp';
import { useAuth } from '@/hooks/use-auth';

jest.mock('expo-router', () => ({
  Link: jest.fn(({ children }: { children: React.ReactNode }) => children),
  router: { replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ email: 'parent@example.com', mode: 'signin' })),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/utils/pending-invite-code', () => ({
  getPendingInviteCode: jest.fn().mockResolvedValue(null),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <VerifyOtpScreen />
    </SafeAreaProvider>,
  );
}

describe('VerifyOtpScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (KeyboardController.isVisible as jest.Mock).mockReturnValue(false);
    mockedUseAuth.mockReturnValue({
      verifyOtp: jest.fn(),
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn(),
    } as never);
  });

  it('rechecks focus when the OTP boxes are tapped after the keyboard is dismissed', () => {
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('verify-otp-code-input-target'));

    expect(KeyboardController.isVisible).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
