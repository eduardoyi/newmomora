import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import WelcomeScreen, { getWelcomeIllustrationHeight } from '../../app/(onboarding)/welcome';
import { spacing } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { createEmptyOnboardingDraft } from '@/utils/onboarding-progress';

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

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 852, width: 393, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 59 },
      }}
    >
      <WelcomeScreen />
    </SafeAreaProvider>,
  );
}

describe('WelcomeScreen (S0)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseOnboardingFlow.mockReturnValue({
      draft: createEmptyOnboardingDraft('welcome'),
      isHydrated: true,
      patch: jest.fn(),
      clear: jest.fn(),
    });
  });

  it('keeps screen-specific breathing room between the welcome copy and its actions', () => {
    const { getByTestId } = renderScreen();

    expect(StyleSheet.flatten(getByTestId('onb-welcome-actions').props.style)).toMatchObject({
      paddingTop: spacing.md,
    });
  });

  it('caps the illustration on tall phones so the complete copy stays above the actions', () => {
    expect(getWelcomeIllustrationHeight(874)).toBe(340);
  });

  it('shrinks the illustration proportionally on shorter phones instead of applying the tall-phone cap', () => {
    expect(getWelcomeIllustrationHeight(667)).toBeCloseTo(260.13);
    expect(getWelcomeIllustrationHeight(667)).toBeLessThan(getWelcomeIllustrationHeight(874));
  });
});
