// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S13 routing on billing state. Only S13 is trial-specific: a first-time
// owner who can't get the free week skips it but still sees S14 ("what's
// included") before the price (2026-10-02). A lapsed owner goes straight to
// the resubscribe paywall.
import { render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import TrialScreen from '../../app/(onboarding)/trial';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingIncludedRoute, onboardingPaywallRouteForMode } from '@/lib/onboarding-routes';
import { timelineRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
}));

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-billing', () => ({ useBilling: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/use-onboarding-flow', () => ({ useOnboardingFlow: jest.fn() }));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseBilling = useBilling as jest.MockedFunction<typeof useBilling>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;

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
  });

  it('shows the free-week timeline to a trial-eligible first-time owner', () => {
    mockBilling({});
    const { getByText } = renderScreen();

    expect(getByText('Try everything free for 7 days.')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each(['ineligible', 'unknown'] as const)(
    'skips only the trial screen for a first-time owner whose store trial is %s: S14 still comes before the price',
    async (annualTrialEligibility) => {
      mockBilling({ annualTrialEligibility });
      renderScreen();

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(onboardingIncludedRoute));
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
