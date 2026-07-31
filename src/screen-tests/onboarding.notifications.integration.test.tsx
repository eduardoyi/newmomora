// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// Covers WP2's S11 (docs/plans/onboarding-implementation.md): the first
// three option cards write `notificationChoice` and fire the real OS
// permission prompt via useNotificationsRegistration().requestRegistration();
// the fourth ("No reminders") skips the prompt entirely -- no penalty, no
// re-ask this session.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingNotificationsScreen from '../../app/(onboarding)/notifications';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useNotificationsRegistration } from '@/hooks/useNotifications';
import { onboardingEmailRoute } from '@/lib/onboarding-routes';
import { createEmptyOnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/hooks/useNotifications', () => ({
  useNotificationsRegistration: jest.fn(),
}));

// lucide-react-native (Moon, Sun, X) is stubbed globally in jest.setup.ts --
// no per-file mock needed here.

// createEmptyOnboardingDraft lives in the same module as the real
// AsyncStorage-backed persistence helpers (src/utils/onboarding-progress.ts)
// -- swap in the maintained mock so importing it doesn't pull in the native
// module under Jest (same pattern as onboarding.paywall.integration.test.tsx).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;
const mockedUseNotificationsRegistration = useNotificationsRegistration as jest.MockedFunction<
  typeof useNotificationsRegistration
>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <OnboardingNotificationsScreen />
    </SafeAreaProvider>,
  );
}

describe('OnboardingNotificationsScreen (S11)', () => {
  const patch = jest.fn();
  const requestRegistration = jest.fn().mockResolvedValue(null);

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseOnboardingFlow.mockReturnValue({
      draft: createEmptyOnboardingDraft('notifications'),
      isHydrated: true,
      patch,
      clear: jest.fn(),
    });
    requestRegistration.mockResolvedValue(null);
    mockedUseNotificationsRegistration.mockReturnValue({ requestRegistration });
  });

  it('disables the automatic mount-time registration effect (passes enabled: false)', () => {
    renderScreen();

    expect(mockedUseNotificationsRegistration).toHaveBeenCalledWith(false);
  });

  it('renders the handoff\'s verbatim option copy with an honest time chip on each real option', () => {
    const { getByText } = renderScreen();

    expect(getByText("Evenings, once they're finally asleep")).toBeTruthy();
    expect(getByText('8:00 pm')).toBeTruthy();
    expect(getByText('Later, when the dishes are done')).toBeTruthy();
    expect(getByText('10:00 pm')).toBeTruthy();
    expect(getByText('Mornings, coffee in hand')).toBeTruthy();
    expect(getByText('8:00 am')).toBeTruthy();
    expect(getByText("No reminders. I'll show up on my own")).toBeTruthy();
  });

  it.each(['eve', 'morn', 'late'])('selecting a real option writes notificationChoice %s, fires the OS prompt, and advances to email', async (choiceId) => {
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId(`onboarding-notifications-option-${choiceId}`));

    await waitFor(() => {
      expect(requestRegistration).toHaveBeenCalledTimes(1);
    });
    expect(patch).toHaveBeenCalledWith({ notificationChoice: choiceId, step: 'email' });
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(onboardingEmailRoute);
    });
  });

  it('selecting "No reminders" writes notificationChoice: none, never calls requestRegistration, and advances to email', async () => {
    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-notifications-option-none'));

    expect(patch).toHaveBeenCalledWith({ notificationChoice: 'none', step: 'email' });
    expect(requestRegistration).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(onboardingEmailRoute);
    });
  });

  it('ignores a second tap while the first selection is still processing', async () => {
    let resolveRegistration: (() => void) | undefined;
    requestRegistration.mockReturnValue(
      new Promise((resolve) => {
        resolveRegistration = () => resolve(null);
      }),
    );

    const screen = renderScreen();

    fireEvent.press(screen.getByTestId('onboarding-notifications-option-eve'));
    fireEvent.press(screen.getByTestId('onboarding-notifications-option-morn'));

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ notificationChoice: 'eve', step: 'email' });

    resolveRegistration?.();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(onboardingEmailRoute);
    });
  });
});
