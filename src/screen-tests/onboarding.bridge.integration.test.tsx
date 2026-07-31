// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S8 had zero test coverage before this fix. Device-reported bug
// (2026-07-31): the body used to read only `draft.kidNames[0]`, so a
// two-kid family's body always named the first-entered kid ("Enzo's
// journal...") regardless of how many kids existed. This suite is the
// regression coverage for the fix: single-kid families keep the named
// possessive, and 2+ kid families get the journal-flavored "Your" instead
// of singling out one kid (see journalPossessive's doc comment in
// src/utils/onboarding-copy.ts).
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import BridgeScreen from '../../app/(onboarding)/bridge';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingCaptureRoute } from '@/lib/onboarding-routes';
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
      <BridgeScreen />
    </SafeAreaProvider>,
  );
}

function mockDraft(overrides: Partial<OnboardingDraft>) {
  const patch = jest.fn();
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('bridge'), ...overrides },
    isHydrated: true,
    patch,
    clear: jest.fn(),
  });
  return patch;
}

describe('BridgeScreen (S8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes the step to the draft on mount so the flow is resumable', () => {
    const patch = mockDraft({ kidNames: ['Lila'] });

    renderScreen();

    expect(patch).toHaveBeenCalledWith({ step: 'bridge' });
  });

  it('names the single kid in the body for a one-kid family', () => {
    mockDraft({ kidNames: ['Lila'] });

    const { getByText } = renderScreen();

    expect(
      getByText("Lila's journal starts with one little thing from this week. Silly counts. Boring counts double."),
    ).toBeTruthy();
  });

  it('applies the s-ending possessive rule for the single kid', () => {
    mockDraft({ kidNames: ['Chris'] });

    const { getByText } = renderScreen();

    expect(
      getByText("Chris' journal starts with one little thing from this week. Silly counts. Boring counts double."),
    ).toBeTruthy();
  });

  it('uses "Your" (not the first kid\'s name) for a two-kid family', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'] });

    const { getByText, queryByText } = renderScreen();

    expect(
      getByText("Your journal starts with one little thing from this week. Silly counts. Boring counts double."),
    ).toBeTruthy();
    expect(queryByText(/^Lila's journal starts/)).toBeNull();
  });

  it('uses "Your" for a three-or-more-kid family', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel', 'Teo'] });

    const { getByText } = renderScreen();

    expect(
      getByText("Your journal starts with one little thing from this week. Silly counts. Boring counts double."),
    ).toBeTruthy();
  });

  it('advances "Start with tonight" to the capture screen', () => {
    mockDraft({ kidNames: ['Lila'] });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-bridge-cta-button'));

    expect(router.push).toHaveBeenCalledWith(onboardingCaptureRoute);
  });
});
