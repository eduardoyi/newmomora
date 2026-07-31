// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import FamilyNameScreen from '../../app/(onboarding)/family-name';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingBridgeRoute } from '@/lib/onboarding-routes';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';

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
      <FamilyNameScreen />
    </SafeAreaProvider>,
  );
}

function mockDraft(overrides: Partial<OnboardingDraft>) {
  const patch = jest.fn();
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('family-name'), ...overrides },
    isHydrated: true,
    patch,
    clear: jest.fn(),
  });
  return patch;
}

describe('FamilyNameScreen (S7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes the step to the draft on mount so the flow is resumable', () => {
    const patch = mockDraft({ kidNames: ['Lila'] });

    renderScreen();

    expect(patch).toHaveBeenCalledWith({ step: 'family-name' });
  });

  it('prefills and headlines for a single kid', () => {
    mockDraft({ kidNames: ['Lila'] });

    const { getByTestId, getByText } = renderScreen();

    expect(getByTestId('onb-family-name-input').props.value).toBe("Lila's Family");
    expect(getByText("Lila's stories need a home.")).toBeTruthy();
  });

  it('prefills and headlines for two kids', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'] });

    const { getByTestId, getByText } = renderScreen();

    expect(getByTestId('onb-family-name-input').props.value).toBe("Lila & Miguel's Family");
    expect(getByText('Their stories need a home.')).toBeTruthy();
  });

  it('prefills and headlines for three or more kids', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel', 'Teo'] });

    const { getByTestId, getByText } = renderScreen();

    expect(getByTestId('onb-family-name-input').props.value).toBe("Lila, Miguel & Teo's Family");
    expect(getByText('Their stories need a home.')).toBeTruthy();
  });

  it('prefers an already-edited familyName on the draft over recomputing the default', () => {
    mockDraft({ kidNames: ['Lila'], familyName: 'The Rivera Family' });

    const { getByTestId } = renderScreen();

    expect(getByTestId('onb-family-name-input').props.value).toBe('The Rivera Family');
  });

  it('persists an edit to the draft and advances to the bridge screen', () => {
    const patch = mockDraft({ kidNames: ['Lila'] });

    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('onb-family-name-input'), 'The Rivera Family ');
    fireEvent.press(getByTestId('onb-family-name-continue-button'));

    expect(patch).toHaveBeenCalledWith({ familyName: 'The Rivera Family' });
    expect(router.push).toHaveBeenCalledWith(onboardingBridgeRoute);
  });
});
