// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S15b (2026-10-02): where the paywall's "Leave" lands. The owner stays
// signed in; "See plans" goes back to the same paywall variant and "Log out"
// is the explicit way to sign out.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PausedScreen from '../../app/(onboarding)/paused';
import { useAuth } from '@/hooks/use-auth';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { onboardingPaywallRouteForMode, onboardingWelcomeRoute } from '@/lib/onboarding-routes';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-onboarding-kid-possessive', () => ({
  useOnboardingKidPossessive: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockedUseOnboardingKidPossessive = useOnboardingKidPossessive as jest.MockedFunction<
  typeof useOnboardingKidPossessive
>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <PausedScreen />
    </SafeAreaProvider>,
  );
}

describe('PausedScreen (S15b)', () => {
  const signOut = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    signOut.mockResolvedValue(undefined);
    mockedUseAuth.mockReturnValue({ signOut } as never);
    mockedUseLocalSearchParams.mockReturnValue({ mode: 'new-owner' });
    mockedUseOnboardingKidPossessive.mockReturnValue("Lila's");
  });

  it("names the kid's journal for one kid and says 'Your journal' for several", () => {
    const { getByText, rerender } = renderScreen();
    expect(getByText("Lila's journal will be right here.")).toBeTruthy();

    mockedUseOnboardingKidPossessive.mockReturnValue('their');
    rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <PausedScreen />
      </SafeAreaProvider>,
    );
    expect(getByText('Your journal will be right here.')).toBeTruthy();
  });

  it('"See plans" returns to the same paywall variant without signing out', () => {
    mockedUseLocalSearchParams.mockReturnValue({ mode: 'resubscribe' });
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-paused-see-plans-button'));

    expect(router.replace).toHaveBeenCalledWith(onboardingPaywallRouteForMode('resubscribe'));
    expect(signOut).not.toHaveBeenCalled();
  });

  it('"Log out" signs out and returns to the welcome screen', async () => {
    const { getByTestId } = renderScreen();

    await act(async () => {
      fireEvent.press(getByTestId('onb-paused-log-out-link'));
    });

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(onboardingWelcomeRoute);
  });

  it('shows a retryable error when signing out fails', async () => {
    signOut.mockRejectedValue(new Error('offline'));
    const { getByTestId } = renderScreen();

    await act(async () => {
      fireEvent.press(getByTestId('onb-paused-log-out-link'));
    });

    await waitFor(() => expect(getByTestId('onb-paused-error')).toBeTruthy());
    expect(router.replace).not.toHaveBeenCalled();
  });
});
