// Unit tests for the two additions this file gained for analytics
// (docs/plans/analytics-implementation.md WP2): the pure bare-pathname ->
// onboarding_step_viewed mapping, and onboardingPaywallRouteForMode's
// optional `source` param. Every import in onboarding-routes.ts is
// type-only, so this file needs no native-module mocks.
import {
  onboardingAnalyticsStepFromPathname,
  onboardingPaywallRouteForMode,
  onboardingResubscribePaywallRoute,
  onboardingPaywallRoute,
} from '@/lib/onboarding-routes';

describe('onboardingAnalyticsStepFromPathname', () => {
  it('maps a plain grouped route (Expo Router strips the (onboarding) segment)', () => {
    expect(onboardingAnalyticsStepFromPathname('/welcome')).toEqual({ step: 'welcome', flow: 'owner' });
    expect(onboardingAnalyticsStepFromPathname('/capture')).toEqual({ step: 'capture', flow: 'owner' });
    expect(onboardingAnalyticsStepFromPathname('/paywall')).toEqual({ step: 'paywall', flow: 'owner' });
  });

  it('maps a nested joiner route to the joiner flow', () => {
    expect(onboardingAnalyticsStepFromPathname('/join/code')).toEqual({ step: 'join-code', flow: 'joiner' });
    expect(onboardingAnalyticsStepFromPathname('/join/waiting')).toEqual({ step: 'join-waiting', flow: 'joiner' });
  });

  it('resolves S1-S3 from the beat search param, defaulting to story-0', () => {
    expect(onboardingAnalyticsStepFromPathname('/story', '0')).toEqual({ step: 'story-0', flow: 'owner' });
    expect(onboardingAnalyticsStepFromPathname('/story', '1')).toEqual({ step: 'story-1', flow: 'owner' });
    expect(onboardingAnalyticsStepFromPathname('/story', '2')).toEqual({ step: 'story-2', flow: 'owner' });
    expect(onboardingAnalyticsStepFromPathname('/story')).toEqual({ step: 'story-0', flow: 'owner' });
    // useGlobalSearchParams can hand back an array for a repeated param --
    // take the first entry rather than dropping the event.
    expect(onboardingAnalyticsStepFromPathname('/story', ['1', '2'])).toEqual({ step: 'story-1', flow: 'owner' });
  });

  it('maps the S17 reveal route, which is deliberately not an OnboardingStepId', () => {
    expect(onboardingAnalyticsStepFromPathname('/reveal')).toEqual({ step: 'reveal', flow: 'owner' });
  });

  it('returns null for a pathname this layout does not own', () => {
    expect(onboardingAnalyticsStepFromPathname('/')).toBeNull();
    expect(onboardingAnalyticsStepFromPathname('/settings')).toBeNull();
  });
});

describe('onboardingPaywallRouteForMode', () => {
  it('returns the plain routes when no source is given (unchanged for every existing caller)', () => {
    expect(onboardingPaywallRouteForMode('new-owner')).toBe(onboardingPaywallRoute);
    expect(onboardingPaywallRouteForMode('resubscribe')).toBe(onboardingResubscribePaywallRoute);
  });

  it('threads an explicit source into the route params for both modes', () => {
    expect(onboardingPaywallRouteForMode('new-owner', 'resume')).toEqual({
      pathname: '/(onboarding)/paywall',
      params: { source: 'resume' },
    });
    expect(onboardingPaywallRouteForMode('resubscribe', 'resume')).toEqual({
      pathname: '/(onboarding)/paywall',
      params: { mode: 'resubscribe', source: 'resume' },
    });
  });
});
