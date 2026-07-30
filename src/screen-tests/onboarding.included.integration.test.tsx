// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S14 had zero test coverage before WP7-A -- this suite closes that gap for
// the draft-first path (mirrors onboarding.paywall.integration.test.tsx,
// which shares the exact same personalization rule via
// useOnboardingKidPossessive). Every case here hand-populates the draft
// with enough to resolve a name/neutral phrase on its own, so
// useFamilyMembers() is mocked at the hook boundary and never actually
// consulted -- the real-server-data fallback (the one WP7-A fixed: the
// draft is genuinely empty, matching S12B's code.tsx clearing it before
// routing here) is covered by
// onboarding.post-commit-real-data.integration.test.tsx, which deliberately
// does NOT mock useOnboardingFlow or useFamilyMembers.
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import IncludedScreen from '../../app/(onboarding)/included';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { onboardingPaywallRoute } from '@/lib/onboarding-routes';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: jest.fn(),
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
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <IncludedScreen />
    </SafeAreaProvider>,
  );
}

function mockDraft(overrides: Partial<OnboardingDraft>) {
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('included'), ...overrides },
    isHydrated: true,
    patch: jest.fn(),
    clear: jest.fn(),
  });
}

describe('IncludedScreen (S14)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDraft({ kidNames: ['Lila'], capture: { text: 'Bath time giggles', taggedKidIndexes: [0] } });
    // Every case in this suite resolves a name/neutral phrase from the draft
    // alone -- this hook is never actually consulted here (see the file
    // header comment for where the real-data fallback IS covered).
    mockedUseFamilyMembers.mockReturnValue({
      members: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
  });

  it('renders the checklist and the signed promise card, personalized from the draft', () => {
    const { getByText, getByTestId } = renderScreen();

    expect(getByText("Everything Lila's journal comes with:")).toBeTruthy();
    expect(getByText("Lila's illustrated portrait and storybook pages")).toBeTruthy();
    expect(getByText('Unlimited memories: talk, type, photos, video')).toBeTruthy();
    expect(getByText('The whole family can join, grandparents included, free')).toBeTruthy();
    expect(getByText('Every memory searchable, finally out of the camera roll')).toBeTruthy();
    expect(getByTestId('onb-included-promise')).toBeTruthy();
    expect(getByText('Your memories are always yours.')).toBeTruthy();
    expect(getByText('Eduardo & Adriana')).toBeTruthy();
  });

  it('uses the neutral "their" phrasing when several kids are tagged on the first memory', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'], capture: { text: 'x', taggedKidIndexes: [0, 1] } });

    const { getByText } = renderScreen();

    expect(getByText("Everything their journal comes with:")).toBeTruthy();
    expect(getByText('their illustrated portrait and storybook pages')).toBeTruthy();
  });

  it('advances "Almost done" to the paywall route', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-included-cta-button'));

    expect(router.push).toHaveBeenCalledWith(onboardingPaywallRoute);
  });
});
