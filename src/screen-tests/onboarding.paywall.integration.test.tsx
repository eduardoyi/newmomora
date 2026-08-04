// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S15 is a real RevenueCat paywall. The native SDK is mocked at the hook
// boundary here; purchase, restore, entitlement verification, and the
// post-purchase illustration hand-off are still exercised as one screen flow.
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
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PaywallScreen from '../../app/(onboarding)/paywall';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { onboardingPortraitRoute, onboardingWelcomeRoute } from '@/lib/onboarding-routes';
import { timelineRoute } from '@/lib/routes';
import { setPersonProperties, trackEvent } from '@/services/analytics';
import { commitOnboarding } from '@/services/onboarding';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';
import { colors } from '@/constants/theme';

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: jest.fn(() => ({})),
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

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-billing', () => ({
  useBilling: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/use-pending-memory-uploads', () => ({
  usePendingMemoryUploads: jest.fn(() => ({ enqueue: jest.fn() })),
}));

jest.mock('@/services/onboarding', () => ({
  commitOnboarding: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
  setPersonProperties: jest.fn(),
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
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseBilling = useBilling as jest.MockedFunction<typeof useBilling>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCommitOnboarding = commitOnboarding as jest.MockedFunction<typeof commitOnboarding>;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;
const mockedSetPersonProperties = setPersonProperties as jest.MockedFunction<typeof setPersonProperties>;

const annualPackage = {
  identifier: '$rc_annual',
  packageType: 'ANNUAL',
  product: {
    identifier: 'momora_annual_v1',
    priceString: '$99.99',
    pricePerMonthString: '$8.33',
  },
} as never;
const monthlyPackage = {
  identifier: '$rc_monthly',
  packageType: 'MONTHLY',
  product: {
    identifier: 'momora_monthly_v1',
    priceString: '$12.99',
  },
} as never;

const pendingBillingStatus = {
  family_id: 'family-1',
  owner_user_id: 'user-1',
  has_write_access: false,
  has_ever_had_access: false,
  trial_eligible: true,
} as never;

function activeCustomerInfo() {
  return { originalAppUserId: 'user-1', entitlements: { active: { momora_plus: {} } } } as never;
}

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

// Re-renders the same element tree so a mid-test change to a mocked hook's
// return value (e.g. offerings arriving after mode has already settled) is
// picked up -- the hooks here are jest.fn() mocks, not real state, so
// nothing re-renders the screen on its own when their return value changes.
function rerenderScreen(utils: ReturnType<typeof renderScreen>) {
  utils.rerender(
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
  const patch = jest.fn();
  const clear = jest.fn().mockResolvedValue(undefined);
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('paywall'), ...overrides },
    isHydrated: true,
    patch,
    clear,
  });
  return { patch, clear };
}

describe('PaywallScreen (S15)', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    (useLocalSearchParams as jest.Mock).mockReturnValue({});
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
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' }, signOut: jest.fn().mockResolvedValue(undefined) } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedUseBilling.mockReturnValue({
      offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
      status: pendingBillingStatus,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: jest.fn().mockResolvedValue(activeCustomerInfo()),
      restore: jest.fn().mockResolvedValue(activeCustomerInfo()),
      startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  it('renders the live annual default, monthly option, trust bullets, and legal links', async () => {
    const { getByText, getByTestId } = renderScreen();

    expect(getByText("Turn Lila's little moments into something you'll hold forever.")).toBeTruthy();
    await waitFor(() => expect(getByText('Try it FREE for 7 days')).toBeTruthy());
    expect(getByText('Then $99.99/year (just $8.33/month)')).toBeTruthy();
    expect(getByText('Skip free trial')).toBeTruthy();
    expect(StyleSheet.flatten(getByTestId('onb-paywall-annual-plan').props.style)).toEqual(
      expect.objectContaining({ borderColor: colors.primary }),
    );
    expect(StyleSheet.flatten(getByTestId('onb-paywall-monthly-plan').props.style)).toEqual(
      expect.objectContaining({ borderColor: 'transparent' }),
    );
    expect(getByText('$0.00 today')).toBeTruthy();
    expect(getByText('Reminder before your trial ends')).toBeTruthy();
    expect(getByText('Cancelling takes about 10 seconds')).toBeTruthy();
    expect(getByText('Your memories export free, forever')).toBeTruthy();
    expect(getByTestId('onb-paywall-restore-button')).toBeTruthy();
    expect(getByTestId('onb-paywall-terms-link').props.href).toBe('https://usemomora.com/terms-of-service/');
    expect(getByTestId('onb-paywall-privacy-link').props.href).toBe('https://usemomora.com/privacy-policy/');
  });

  it('does not show a fallback no-trial paywall while the owner status refresh is pending', async () => {
    let releaseRefresh!: () => void;
    const refresh = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    mockedUseBilling.mockReturnValue({
      offerings: {
        offering: {} as never,
        annual: annualPackage,
        monthly: monthlyPackage,
        annualTrialEligibility: 'eligible',
        raw: {} as never,
      },
      status: pendingBillingStatus,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: jest.fn(),
      restore: jest.fn(),
      startOnboardingIllustration: jest.fn(),
      refresh,
    } as never);

    const { getByTestId, queryByTestId } = renderScreen();

    expect(queryByTestId('onb-paywall-annual-plan')).toBeNull();
    expect(queryByTestId('onb-paywall-monthly-plan')).toBeNull();
    expect(getByTestId('onb-paywall-cta-button').props.accessibilityState?.disabled).toBe(true);

    releaseRefresh();
    await waitFor(() => expect(getByTestId('onb-paywall-annual-plan')).toBeTruthy());
  });

  it('corrects a stale resubscribe URL to the server-authoritative first-time trial mode', async () => {
    (useLocalSearchParams as jest.Mock).mockReturnValue({ mode: 'resubscribe' });
    const { patch } = mockDraft({ kidNames: ['Lila'] });

    const { getByText } = renderScreen();

    await waitFor(() => expect(getByText('Try it FREE for 7 days')).toBeTruthy());
    expect(getByText('Then $99.99/year (just $8.33/month)')).toBeTruthy();
    expect(patch).toHaveBeenCalledWith({ step: 'paywall', paywallMode: 'new-owner' });
  });

  it('fails closed when the billing status cannot be verified', async () => {
    mockedUseBilling.mockReturnValue({
      offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
      status: null,
      billingStatusError: new Error('offline'),
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: jest.fn(),
      restore: jest.fn(),
      startOnboardingIllustration: jest.fn(),
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);

    const { getByTestId } = renderScreen();

    await waitFor(() => expect(getByTestId('onb-paywall-billing-unavailable')).toBeTruthy());
    expect(getByTestId('onb-paywall-cta-button').props.accessibilityState?.disabled).toBe(true);
    expect(getByTestId('onb-paywall-retry-billing')).toBeTruthy();
  });

  it('never charges or leaves a non-owner on the owner paywall', async () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' } as never);
    const { clear } = mockDraft({ kidNames: ['Lila'] });

    renderScreen();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(timelineRoute));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('persists the first-time paywall as the relaunch resume point', async () => {
    const { patch } = mockDraft({ kidNames: ['Lila'] });

    renderScreen();

    await waitFor(() => expect(patch).toHaveBeenCalledWith({ step: 'paywall', paywallMode: 'new-owner' }));
  });

  it('uses the neutral "their" phrasing when several kids are tagged on the first memory', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'], capture: { text: 'x', taggedKidIndexes: [0, 1] } });

    const { getByText } = renderScreen();

    expect(getByText("Turn their little moments into something you'll hold forever.")).toBeTruthy();
  });

  it('keeps each plan label stable and moves the border to the selected monthly option', async () => {
    const { getByTestId, queryByText, getByText } = renderScreen();

    await waitFor(() => expect(getByTestId('onb-paywall-monthly-plan')).toBeTruthy());
    fireEvent.press(getByTestId('onb-paywall-monthly-plan'));

    expect(getByText('Try it FREE for 7 days')).toBeTruthy();
    expect(getByText('Then $99.99/year (just $8.33/month)')).toBeTruthy();
    expect(getByText('Skip free trial')).toBeTruthy();
    expect(queryByText('$0.00 today')).toBeNull();
    expect(getByText('Your subscription starts immediately')).toBeTruthy();
    expect(StyleSheet.flatten(getByTestId('onb-paywall-annual-plan').props.style)).toEqual(
      expect.objectContaining({ borderColor: 'transparent' }),
    );
    expect(StyleSheet.flatten(getByTestId('onb-paywall-monthly-plan').props.style)).toEqual(
      expect.objectContaining({ borderColor: colors.primary }),
    );
  });

  it('uses paid-now copy when RevenueCat cannot confirm trial eligibility', async () => {
    mockedUseBilling.mockReturnValue({
      offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'unknown', raw: {} as never },
      status: pendingBillingStatus,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: jest.fn().mockResolvedValue(activeCustomerInfo()),
      restore: jest.fn().mockResolvedValue(activeCustomerInfo()),
      startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);

    const { queryByText, getByText } = renderScreen();

    await waitFor(() => expect(getByText('Your subscription starts immediately')).toBeTruthy());
    expect(queryByText('Try it FREE for 7 days')).toBeNull();
    expect(queryByText('Then $99.99/year (just $8.33/month)')).toBeNull();
    expect(getByText('Annual (Save 36%)')).toBeTruthy();
    expect(getByText('$99.99/year (just $8.33/month)')).toBeTruthy();
    expect(getByText('Monthly')).toBeTruthy();
    expect(getByText('$12.99/month')).toBeTruthy();
    expect(queryByText('$0.00 today')).toBeNull();
  });

  it('purchases the selected annual package, verifies the entitlement, and starts the first illustration', async () => {
    const billing = {
      purchase: jest.fn().mockResolvedValue(activeCustomerInfo()),
      startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
    };
    mockedUseBilling.mockReturnValue({
      offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
      status: pendingBillingStatus,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: billing.purchase,
      restore: jest.fn(),
      startOnboardingIllustration: billing.startOnboardingIllustration,
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);
    const { getByTestId } = renderScreen();

    await waitFor(() => expect(getByTestId('onb-paywall-cta-button').props.accessibilityState?.disabled).toBeFalsy());
    fireEvent.press(getByTestId('onb-paywall-cta-button'));

    await waitFor(() => {
      expect(billing.purchase).toHaveBeenCalledWith(annualPackage, { useAnnualTrial: true });
      expect(billing.startOnboardingIllustration).toHaveBeenCalledTimes(1);
      expect(router.replace).toHaveBeenCalledWith(onboardingPortraitRoute);
    });
  });

  it('commits a pending pre-paywall capture for a first-time owner before continuing to portraits', async () => {
    mockDraft({
      kidNames: ['Lila'],
      committedFamilyId: 'family-1',
      captureCommitted: false,
      capture: { text: 'Bath time giggles', taggedKidIndexes: [0] },
    });
    mockedCommitOnboarding.mockResolvedValue({
      data: { familyId: 'family-1', memoryId: 'memory-2', isNewFamily: false, pendingMediaUpload: null },
      error: null,
    });
    const billing = {
      purchase: jest.fn().mockResolvedValue(activeCustomerInfo()),
      startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
    };
    mockedUseBilling.mockReturnValue({
      offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
      status: pendingBillingStatus,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: billing.purchase,
      restore: jest.fn(),
      startOnboardingIllustration: billing.startOnboardingIllustration,
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);

    const { getByTestId } = renderScreen();

    await waitFor(() => expect(getByTestId('onb-paywall-cta-button').props.accessibilityState?.disabled).toBeFalsy());
    fireEvent.press(getByTestId('onb-paywall-cta-button'));

    await waitFor(() => {
      expect(mockedCommitOnboarding).toHaveBeenCalledWith(expect.objectContaining({
        committedFamilyId: 'family-1',
        captureCommitted: false,
      }));
      expect(billing.startOnboardingIllustration).toHaveBeenCalledWith('memory-2');
      expect(router.replace).toHaveBeenCalledWith(onboardingPortraitRoute);
    });
  });

  it('bypasses purchase for a confirmed complimentary new owner', async () => {
    const billing = {
      purchase: jest.fn(),
      startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
    };
    mockedUseBilling.mockReturnValue({
      offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
      status: {
        family_id: 'family-1',
        owner_user_id: 'user-1',
        has_write_access: true,
        has_ever_had_access: false,
        trial_eligible: true,
        access_reason: 'complimentary',
      } as never,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: billing.purchase,
      restore: jest.fn(),
      startOnboardingIllustration: billing.startOnboardingIllustration,
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);

    const { queryByTestId } = renderScreen();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(onboardingPortraitRoute));
    expect(queryByTestId('onb-paywall-cta-button')).toBeNull();
    expect(billing.purchase).not.toHaveBeenCalled();
    expect(billing.startOnboardingIllustration).toHaveBeenCalledTimes(1);
  });

  it('bypasses purchase for a confirmed complimentary resubscribe owner', async () => {
    (useLocalSearchParams as jest.Mock).mockReturnValue({ mode: 'resubscribe' });
    const billing = {
      purchase: jest.fn(),
      startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
    };
    mockedUseBilling.mockReturnValue({
      offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
      status: {
        family_id: 'family-1',
        owner_user_id: 'user-1',
        has_write_access: true,
        has_ever_had_access: false,
        trial_eligible: true,
        access_reason: 'complimentary',
      } as never,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: billing.purchase,
      restore: jest.fn(),
      startOnboardingIllustration: billing.startOnboardingIllustration,
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);

    const { queryByTestId } = renderScreen();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(timelineRoute));
    expect(queryByTestId('onb-paywall-cta-button')).toBeNull();
    expect(billing.purchase).not.toHaveBeenCalled();
  });

  it('bypasses purchase for any server-confirmed paid access, not only complimentary grants', async () => {
    const billing = {
      purchase: jest.fn(),
      startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
    };
    mockedUseBilling.mockReturnValue({
      offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
      status: {
        family_id: 'family-1',
        owner_user_id: 'user-1',
        has_write_access: true,
        has_ever_had_access: true,
        trial_eligible: false,
        access_reason: 'active',
      } as never,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: billing.purchase,
      restore: jest.fn(),
      startOnboardingIllustration: billing.startOnboardingIllustration,
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);

    const { queryByTestId, getByTestId } = renderScreen();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(onboardingPortraitRoute));
    expect(queryByTestId('onb-paywall-cta-button')).toBeNull();
    expect(getByTestId('onb-paywall-access-confirmed')).toBeTruthy();
    expect(billing.purchase).not.toHaveBeenCalled();
  });

  it('does not render a purchasable fallback when RevenueCat returns no offering', () => {
    mockedUseBilling.mockReturnValue({
      offerings: null,
      status: pendingBillingStatus,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      offeringsError: new Error('No active offering'),
      purchase: jest.fn(),
      restore: jest.fn(),
      startOnboardingIllustration: jest.fn(),
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);

    const { getByTestId, queryByTestId } = renderScreen();

    expect(queryByTestId('onb-paywall-annual-plan')).toBeNull();
    expect(queryByTestId('onb-paywall-monthly-plan')).toBeNull();
    expect(getByTestId('onb-paywall-offerings-unavailable')).toBeTruthy();
    expect(getByTestId('onb-paywall-retry-options')).toBeTruthy();
  });

  it('persists the resubscribe variant so a relaunch cannot re-offer the trial', async () => {
    (useLocalSearchParams as jest.Mock).mockReturnValue({ mode: 'resubscribe' });
    const { patch } = mockDraft({ kidNames: ['Lila'] });
    mockedUseBilling.mockReturnValue({
      offerings: {
        offering: {} as never,
        annual: annualPackage,
        monthly: monthlyPackage,
        annualTrialEligibility: 'eligible',
        raw: {} as never,
      },
      status: {
        family_id: 'family-1',
        owner_user_id: 'user-1',
        has_write_access: false,
        has_ever_had_access: true,
        trial_eligible: false,
      } as never,
      isConfigured: true,
      isLoading: false,
      isOffline: false,
      purchase: jest.fn(),
      restore: jest.fn(),
      startOnboardingIllustration: jest.fn(),
      refresh: jest.fn().mockResolvedValue(undefined),
    } as never);

    renderScreen();

    await waitFor(() => expect(patch).toHaveBeenCalledWith({ step: 'paywall', paywallMode: 'resubscribe' }));
  });

  it('opens the close-confirm sheet from the quiet X and dismisses it via Stay', async () => {
    const { getByTestId, queryByTestId, getByText } = renderScreen();

    expect(queryByTestId('onb-paywall-sheet')).toBeNull();
    await waitFor(() => expect(getByTestId('onb-paywall-close-button').props.accessibilityState?.disabled).toBeFalsy());

    fireEvent.press(getByTestId('onb-paywall-close-button'));

    expect(getByText("Leave Lila's first page here for now?")).toBeTruthy();
    expect(getByText("It'll be waiting if you come back.")).toBeTruthy();

    fireEvent.press(getByTestId('onb-paywall-sheet-stay-button'));

    expect(queryByTestId('onb-paywall-sheet')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('signs out and returns to the welcome screen when the user leaves', async () => {
    const { getByTestId, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('onb-paywall-close-button').props.accessibilityState?.disabled).toBeFalsy());

    fireEvent.press(getByTestId('onb-paywall-close-button'));
    fireEvent.press(getByTestId('onb-paywall-sheet-leave-button'));

    await waitFor(() => {
      expect(queryByTestId('onb-paywall-sheet')).toBeNull();
      expect(mockedUseAuth().signOut).toHaveBeenCalledTimes(1);
      expect(router.push).not.toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith(onboardingWelcomeRoute);
    });
  });

  it('restores an active subscription and resumes onboarding', async () => {
    const { getByTestId } = renderScreen();

    await waitFor(() => expect(getByTestId('onb-paywall-restore-button').props.disabled).toBeFalsy());
    fireEvent.press(getByTestId('onb-paywall-restore-button'));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(onboardingPortraitRoute));
  });

  // docs/plans/analytics-implementation.md WP2.6's required test list.
  describe('analytics', () => {
    it('fires no paywall_viewed for an entitled pass-through (serverPaywallMode stays null)', async () => {
      const billing = {
        purchase: jest.fn(),
        startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
      };
      mockedUseBilling.mockReturnValue({
        offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
        status: {
          family_id: 'family-1',
          owner_user_id: 'user-1',
          has_write_access: true,
          has_ever_had_access: true,
          trial_eligible: false,
          access_reason: 'active',
        } as never,
        isConfigured: true,
        isLoading: false,
        isOffline: false,
        purchase: billing.purchase,
        restore: jest.fn(),
        startOnboardingIllustration: billing.startOnboardingIllustration,
        refresh: jest.fn().mockResolvedValue(undefined),
      } as never);

      renderScreen();

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(onboardingPortraitRoute));
      expect(mockedTrackEvent).not.toHaveBeenCalledWith('paywall_viewed', expect.anything());
    });

    it('fires exactly one paywall_viewed, with the settled mode, once the pending owner-status check resolves', async () => {
      let releaseRefresh!: () => void;
      const refresh = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          }),
      );
      mockedUseBilling.mockReturnValue({
        offerings: {
          offering: {} as never,
          annual: annualPackage,
          monthly: monthlyPackage,
          annualTrialEligibility: 'eligible',
          raw: {} as never,
        },
        status: pendingBillingStatus,
        isConfigured: true,
        isLoading: false,
        isOffline: false,
        purchase: jest.fn(),
        restore: jest.fn(),
        startOnboardingIllustration: jest.fn(),
        refresh,
      } as never);

      renderScreen();

      // Still checking -- serverPaywallMode is null while the refresh is
      // pending, so paywall_viewed must not have fired yet.
      expect(mockedTrackEvent).not.toHaveBeenCalledWith('paywall_viewed', expect.anything());

      releaseRefresh();
      await waitFor(() => {
        expect(mockedTrackEvent).toHaveBeenCalledWith('paywall_viewed', {
          mode: 'new-owner',
          trial_eligible: true,
          has_monthly: true,
          source: 'onboarding',
        });
      });
      expect(mockedTrackEvent.mock.calls.filter(([name]) => name === 'paywall_viewed')).toHaveLength(1);
    });

    it('withholds paywall_viewed until offerings settle too, even after the mode has already settled, then reports the offerings that actually arrived', async () => {
      let releaseRefresh!: () => void;
      const refresh = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          }),
      );
      const billingBase = {
        status: pendingBillingStatus,
        isConfigured: true,
        isLoading: false,
        isOffline: false,
        purchase: jest.fn(),
        restore: jest.fn(),
        startOnboardingIllustration: jest.fn(),
        refresh,
      };
      // Offerings (RevenueCat) have not loaded yet when the screen mounts --
      // status/mode and offerings settle independently.
      mockedUseBilling.mockReturnValue({ ...billingBase, offerings: null } as never);
      const { patch } = mockDraft({ kidNames: ['Lila'], capture: { text: 'Bath time giggles', taggedKidIndexes: [0] } });

      const utils = renderScreen();

      expect(mockedTrackEvent).not.toHaveBeenCalledWith('paywall_viewed', expect.anything());

      releaseRefresh();
      // `patch({..., paywallMode})` only ever fires once serverPaywallMode
      // has actually settled -- a reliable signal that the mode half of the
      // race is done, independent of the offerings-unavailable fallback UI
      // (which can render for other reasons while still checking).
      await waitFor(() => {
        expect(patch).toHaveBeenCalledWith({ step: 'paywall', paywallMode: 'new-owner' });
      });

      // The bug this test guards against: mode is settled, but offerings are
      // still null -- paywall_viewed must NOT have fired yet (it would have,
      // pre-fix, with has_monthly/trial_eligible wrongly false).
      expect(mockedTrackEvent).not.toHaveBeenCalledWith('paywall_viewed', expect.anything());

      // Offerings arrive later.
      mockedUseBilling.mockReturnValue({
        ...billingBase,
        offerings: {
          offering: {} as never,
          annual: annualPackage,
          monthly: monthlyPackage,
          annualTrialEligibility: 'eligible',
          raw: {} as never,
        },
      } as never);
      rerenderScreen(utils);

      await waitFor(() => {
        expect(mockedTrackEvent).toHaveBeenCalledWith('paywall_viewed', {
          mode: 'new-owner',
          trial_eligible: true,
          has_monthly: true,
          source: 'onboarding',
        });
      });
      expect(mockedTrackEvent.mock.calls.filter(([name]) => name === 'paywall_viewed')).toHaveLength(1);
    });

    it('never fires paywall_viewed when offerings fail to load -- only paywall_error_shown {code: offerings_unavailable}', async () => {
      mockedUseBilling.mockReturnValue({
        offerings: null,
        status: pendingBillingStatus,
        isConfigured: true,
        isLoading: false,
        isOffline: false,
        offeringsError: new Error('No active offering'),
        purchase: jest.fn(),
        restore: jest.fn(),
        startOnboardingIllustration: jest.fn(),
        refresh: jest.fn().mockResolvedValue(undefined),
      } as never);

      renderScreen();

      await waitFor(() => {
        expect(mockedTrackEvent).toHaveBeenCalledWith('paywall_error_shown', { code: 'offerings_unavailable' });
      });
      expect(mockedTrackEvent).not.toHaveBeenCalledWith('paywall_viewed', expect.anything());
    });

    it('reports a RevenueCat user-cancel as paywall_purchase_failed {code: store_cancel}, never purchase_completed', async () => {
      const purchase = jest.fn().mockRejectedValue({ userCancelled: true, message: 'cancelled' });
      mockedUseBilling.mockReturnValue({
        offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
        status: pendingBillingStatus,
        isConfigured: true,
        isLoading: false,
        isOffline: false,
        purchase,
        restore: jest.fn(),
        startOnboardingIllustration: jest.fn(),
        refresh: jest.fn().mockResolvedValue(undefined),
      } as never);
      const { getByTestId } = renderScreen();

      await waitFor(() => expect(getByTestId('onb-paywall-cta-button').props.accessibilityState?.disabled).toBeFalsy());
      fireEvent.press(getByTestId('onb-paywall-cta-button'));

      await waitFor(() => {
        expect(mockedTrackEvent).toHaveBeenCalledWith('paywall_purchase_failed', { code: 'store_cancel' });
      });
      expect(mockedTrackEvent).not.toHaveBeenCalledWith('paywall_purchase_completed', expect.anything());
    });

    it('still fires paywall_purchase_completed (and never purchase_failed) when finishPaidOnboarding fails after a confirmed purchase', async () => {
      mockDraft({
        kidNames: ['Lila'],
        committedFamilyId: 'family-1',
        captureCommitted: false,
        capture: { text: 'Bath time giggles', taggedKidIndexes: [0] },
      });
      mockedCommitOnboarding.mockResolvedValue({
        data: null,
        error: { message: 'Your capture could not be saved yet. Please try again.' },
      });
      const billing = {
        purchase: jest.fn().mockResolvedValue(activeCustomerInfo()),
        startOnboardingIllustration: jest.fn().mockResolvedValue(undefined),
      };
      mockedUseBilling.mockReturnValue({
        offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
        status: pendingBillingStatus,
        isConfigured: true,
        isLoading: false,
        isOffline: false,
        purchase: billing.purchase,
        restore: jest.fn(),
        startOnboardingIllustration: billing.startOnboardingIllustration,
        refresh: jest.fn().mockResolvedValue(undefined),
      } as never);

      const { getByTestId } = renderScreen();

      await waitFor(() => expect(getByTestId('onb-paywall-cta-button').props.accessibilityState?.disabled).toBeFalsy());
      fireEvent.press(getByTestId('onb-paywall-cta-button'));

      await waitFor(() => {
        expect(mockedTrackEvent).toHaveBeenCalledWith('paywall_purchase_completed', { plan: 'annual' });
      });
      expect(mockedTrackEvent).not.toHaveBeenCalledWith('paywall_purchase_failed', expect.anything());
    });

    it('refreshes the access_reason person property once billing settles', async () => {
      mockedUseBilling.mockReturnValue({
        offerings: { offering: {} as never, annual: annualPackage, monthly: monthlyPackage, annualTrialEligibility: 'eligible', raw: {} as never },
        status: {
          family_id: 'family-1',
          owner_user_id: 'user-1',
          has_write_access: false,
          has_ever_had_access: false,
          trial_eligible: true,
          access_reason: 'off',
        } as never,
        isConfigured: true,
        isLoading: false,
        isOffline: false,
        purchase: jest.fn(),
        restore: jest.fn(),
        startOnboardingIllustration: jest.fn(),
        refresh: jest.fn().mockResolvedValue(undefined),
      } as never);

      renderScreen();

      await waitFor(() => {
        expect(mockedSetPersonProperties).toHaveBeenCalledWith({ access_reason: 'off' });
      });
    });
  });
});
