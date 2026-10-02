// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S13 routing on billing state, and its content. Order (2026-10-02):
// S12B -> S14 -> S13 -> S15, so S13 is the last beat before the price: an
// owner who can't get the free week goes straight from here to the paywall
// (S14 already ran), a lapsed owner to the resubscribe paywall.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import TrialScreen from '../../app/(onboarding)/trial';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { onboardingPaywallRouteForMode } from '@/lib/onboarding-routes';
import { timelineRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-billing', () => ({ useBilling: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/use-onboarding-flow', () => ({ useOnboardingFlow: jest.fn() }));
jest.mock('@/hooks/use-onboarding-kid-possessive', () => ({ useOnboardingKidPossessive: jest.fn() }));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseBilling = useBilling as jest.MockedFunction<typeof useBilling>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;
const mockedUseOnboardingKidPossessive = useOnboardingKidPossessive as jest.MockedFunction<
  typeof useOnboardingKidPossessive
>;

function mockBilling({
  annualTrialEligibility = 'eligible',
  hasWriteAccess = false,
  hasEverHadAccess = false,
  trialEligible = true,
}: {
  annualTrialEligibility?: 'eligible' | 'ineligible' | 'unknown';
  hasWriteAccess?: boolean;
  hasEverHadAccess?: boolean;
  trialEligible?: boolean;
}) {
  mockedUseBilling.mockReturnValue({
    offerings: { annualTrialEligibility },
    status: {
      family_id: 'family-1',
      owner_user_id: 'user-1',
      has_write_access: hasWriteAccess,
      has_ever_had_access: hasEverHadAccess,
      trial_eligible: trialEligible,
    },
    billingStatusError: null,
    isLoading: false,
    refresh: jest.fn(),
  } as never);
}

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <TrialScreen />
    </SafeAreaProvider>,
  );
}

describe('TrialScreen (S13) billing routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', isLoading: false, role: 'owner' } as never);
    mockedUseOnboardingFlow.mockReturnValue({ patch: jest.fn() } as never);
    mockedUseOnboardingKidPossessive.mockReturnValue("Lila's");
  });

  it('shows the free-week timeline to a trial-eligible first-time owner, with Today marked as the current step', () => {
    mockBilling({});
    const { getByText, getByTestId } = renderScreen();

    expect(getByText('Try everything free for 7 days.')).toBeTruthy();
    expect(getByText('how the free week works')).toBeTruthy();
    expect(getByTestId('onb-trial-here-tag')).toBeTruthy();
    expect(getByTestId('onb-trial-no-risk')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names the kid's portrait on the Today step, and doesn't single one out for several kids", () => {
    mockBilling({});
    const { getByText, rerender } = renderScreen();
    expect(getByText("Full access, $0.00 today. We start with Lila's portrait, right after this.")).toBeTruthy();

    mockedUseOnboardingKidPossessive.mockReturnValue('their');
    rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <TrialScreen />
      </SafeAreaProvider>,
    );
    expect(getByText('Full access, $0.00 today. We start with their portraits, right after this.')).toBeTruthy();
  });

  it('"Sounds fair" goes to the paywall (S14 already came before this screen)', () => {
    mockBilling({});
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-trial-cta-button'));

    expect(router.push).toHaveBeenCalledWith(onboardingPaywallRouteForMode('new-owner'));
  });

  it.each(['ineligible', 'unknown'] as const)(
    'goes straight to the paywall for a first-time owner whose store trial is %s',
    async (annualTrialEligibility) => {
      mockBilling({ annualTrialEligibility });
      renderScreen();

      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith(onboardingPaywallRouteForMode('new-owner')),
      );
    },
  );

  it('sends a lapsed owner straight to the resubscribe paywall', async () => {
    mockBilling({ hasEverHadAccess: true, trialEligible: false, annualTrialEligibility: 'ineligible' });
    renderScreen();

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(onboardingPaywallRouteForMode('resubscribe')),
    );
  });

  it('sends an owner who already has access to the journal', async () => {
    mockBilling({ hasWriteAccess: true });
    renderScreen();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(timelineRoute));
  });
});
