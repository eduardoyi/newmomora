import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingYearScreen from '../../app/(onboarding)/year';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingNotificationsRoute } from '@/lib/onboarding-routes';
import { createEmptyOnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  // This screen's focus effect only controls a decorative drift animation;
  // leave that native-navigation concern out of this layout integration test.
  useFocusEffect: jest.fn(),
}));

jest.mock('lucide-react-native', () => ({
  Play: () => null,
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

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
      <OnboardingYearScreen />
    </SafeAreaProvider>,
  );
}

describe('OnboardingYearScreen (S10b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseOnboardingFlow.mockReturnValue({
      draft: createEmptyOnboardingDraft('year'),
      isHydrated: true,
      patch: jest.fn(),
      clear: jest.fn(),
    });
  });

  it('keeps its primary action outside the long timeline, so it remains reachable without scrolling', () => {
    const { getByTestId } = renderScreen();
    const scrollView = getByTestId('onb-shell-scroll');
    let ancestor = getByTestId('onboarding-year-continue').parent;

    expect(getByTestId('onb-shell-footer')).toBeTruthy();
    while (ancestor) {
      expect(ancestor).not.toBe(scrollView);
      ancestor = ancestor.parent;
    }

    fireEvent.press(getByTestId('onboarding-year-continue'));
    expect(router.push).toHaveBeenCalledWith(onboardingNotificationsRoute);
  });
});
