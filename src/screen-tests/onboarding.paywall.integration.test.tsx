// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S15 is a deliberate, non-functional placeholder (plan WP3): these tests
// exist specifically to prove the CTA advances the flow WITHOUT touching any
// billing service (there is none to mock -- no RevenueCat/StoreKit import
// anywhere in paywall.tsx), and that the close-confirm sheet opens/dismisses.
//
// This suite mocks useFamilyMembers() at the hook boundary (not the service
// boundary) -- deliberately: every case here hand-populates the draft with
// enough to resolve a name/neutral phrase on its own (see
// useOnboardingKidPossessive's draft-first priority), so real family-member
// data is never actually consulted. The real-server-data fallback path (the
// one WP7-A fixed -- the draft is genuinely empty, matching S12B's code.tsx
// clearing it before routing here) is covered by the dedicated
// onboarding.post-commit-real-data.integration.test.tsx, which deliberately
// does NOT mock useOnboardingFlow or useFamilyMembers, since mocking either
// is what let this bug ship unnoticed in the first place.
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PaywallScreen from '../../app/(onboarding)/paywall';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { onboardingPortraitRoute } from '@/lib/onboarding-routes';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
    // Terms/Privacy are real external links (not billing) -- stub Link as a
    // plain Text that keeps `href` inspectable, same shape signup.tsx's
    // (untested) usage relies on.
    Link: ({ href, style, testID, children }: {
      href: string;
      style?: unknown;
      testID?: string;
      children?: React.ReactNode;
    }) => (
      <Text href={href} style={style} testID={testID}>
        {children}
      </Text>
    ),
  };
});

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
      <PaywallScreen />
    </SafeAreaProvider>,
  );
}

function mockDraft(overrides: Partial<OnboardingDraft>) {
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('paywall'), ...overrides },
    isHydrated: true,
    patch: jest.fn(),
    clear: jest.fn(),
  });
}

describe('PaywallScreen (S15)', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    // React Native's Modal only reflects `visible` deterministically on
    // Android in Jest -- on iOS it also renders while `isRendered` from a
    // prior open lingers (there's no native dismiss animation callback in
    // tests to clear it). Forcing Android here keeps the open/dismiss
    // assertions below reliable regardless of the host machine's default.
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockDraft({ kidNames: ['Lila'], capture: { text: 'Bath time giggles', taggedKidIndexes: [0] } });
    // Every case in this suite resolves a name/neutral phrase from the draft
    // alone -- this hook is never actually consulted here (see the file
    // header comment for where the real-data fallback IS covered).
    mockedUseFamilyMembers.mockReturnValue({
      members: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useFamilyMembers>);
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  it('renders the complete placeholder: headline, single plan card, trust bullets, and legal links', () => {
    const { getByText, getByTestId } = renderScreen();

    expect(getByText("Turn Lila's little moments into something you'll hold forever.")).toBeTruthy();
    expect(getByText('7 days free, then $99.99/year')).toBeTruthy();
    expect(getByText("That's $8.33/month")).toBeTruthy();
    expect(getByText('$0.00 today')).toBeTruthy();
    expect(getByText('Reminder before your trial ends')).toBeTruthy();
    expect(getByText('Cancelling takes about 10 seconds')).toBeTruthy();
    expect(getByText('Your memories export free, forever')).toBeTruthy();
    expect(getByTestId('onb-paywall-restore-button')).toBeTruthy();
    expect(getByTestId('onb-paywall-terms-link').props.href).toBe('https://usemomora.com/terms-of-service/');
    expect(getByTestId('onb-paywall-privacy-link').props.href).toBe('https://usemomora.com/privacy-policy/');
  });

  it('uses the neutral "their" phrasing when several kids are tagged on the first memory', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'], capture: { text: 'x', taggedKidIndexes: [0, 1] } });

    const { getByText } = renderScreen();

    expect(getByText("Turn their little moments into something you'll hold forever.")).toBeTruthy();
  });

  it('advances "Start my free week" straight to the portrait screen with no billing call', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-paywall-cta-button'));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(onboardingPortraitRoute);
  });

  it('opens the close-confirm sheet from the quiet X and dismisses it via Stay', () => {
    const { getByTestId, queryByTestId, getByText } = renderScreen();

    expect(queryByTestId('onb-paywall-sheet')).toBeNull();

    fireEvent.press(getByTestId('onb-paywall-close-button'));

    expect(getByText("Leave Lila's first page here for now?")).toBeTruthy();
    expect(getByText("It'll be waiting if you come back.")).toBeTruthy();

    fireEvent.press(getByTestId('onb-paywall-sheet-stay-button'));

    expect(queryByTestId('onb-paywall-sheet')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('dismisses the sheet via "Leave" without advancing the flow or calling any service', () => {
    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-paywall-close-button'));
    fireEvent.press(getByTestId('onb-paywall-sheet-leave-button'));

    expect(queryByTestId('onb-paywall-sheet')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('leaves "Restore purchases" inert', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-paywall-restore-button'));

    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
