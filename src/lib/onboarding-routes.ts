// Href constants for every onboarding route (docs/plans/onboarding-implementation.md
// WP0 §0.8), mirroring src/lib/routes.ts conventions. The screens
// themselves are built by WP1-WP4 under app/(onboarding)/ -- this file is
// the single source of truth other implementers navigate through, so a
// route path never gets hand-typed (and drifts) at more than one call site.
//
// Expo Router's generated Href union (.expo/types/router.d.ts) only knows
// about routes that already exist as files under app/ at typecheck time.
// Plain string literals stay comparable to that union regardless (same as
// every other entry in src/lib/routes.ts), but the object-pathname shape
// does not for a route that doesn't exist yet -- so the one parameterized
// route below uses the same double-cast (`as unknown as Href`) that
// `sharingWaitingRouteWithName` already establishes in src/lib/routes.ts.
import type { Href } from 'expo-router';

import type { AnalyticsEventMap } from '@/services/analytics';
import type { OnboardingPaywallMode, OnboardingStepId } from '@/utils/onboarding-progress';

const POST_AUTH_ONBOARDING_PATHNAMES = new Set([
  '/trial',
  '/included',
  '/paywall',
  '/portrait',
  '/reveal',
  '/join/email',
  '/join/waiting',
]);

/**
 * Returns whether an onboarding route can still be active after a real user
 * session exists. The owner-path screens before S12B are pre-auth and can be
 * left behind in the native stack when OTP verification replaces the code
 * screen. The one exception is S12B itself while its commit is retryable.
 */
export function isOnboardingRouteAllowedAfterAuth(pathname: string, draftStep: OnboardingStepId): boolean {
  return POST_AUTH_ONBOARDING_PATHNAMES.has(pathname) || (pathname === '/code' && draftStep === 'code');
}

// Owner-path story/capture/trust arc (S0, S4-S8, S9-S11, S13-S16). S1-S3
// share one screen (`story.tsx`) -- see `onboardingStoryRoute` below.
export const onboardingWelcomeRoute = '/(onboarding)/welcome' as Href;
export const onboardingFoundersRoute = '/(onboarding)/founders' as Href;
export const onboardingArtifactRoute = '/(onboarding)/artifact' as Href;
export const onboardingKidsRoute = '/(onboarding)/kids' as Href;
export const onboardingFamilyNameRoute = '/(onboarding)/family-name' as Href;
export const onboardingBridgeRoute = '/(onboarding)/bridge' as Href;
export const onboardingCaptureRoute = '/(onboarding)/capture' as Href;
export const onboardingAhaRoute = '/(onboarding)/aha' as Href;
export const onboardingYearRoute = '/(onboarding)/year' as Href;
export const onboardingNotificationsRoute = '/(onboarding)/notifications' as Href;
export const onboardingEmailRoute = '/(onboarding)/email' as Href;
export const onboardingCodeRoute = '/(onboarding)/code' as Href;
export const onboardingTrialRoute = '/(onboarding)/trial' as Href;
export const onboardingIncludedRoute = '/(onboarding)/included' as Href;
export const onboardingPaywallRoute = '/(onboarding)/paywall' as Href;
export const onboardingPortraitRoute = '/(onboarding)/portrait' as Href;

/** The resubscribe variant must retain its mode across a cold-launch resume. */
export const onboardingResubscribePaywallRoute = {
  pathname: '/(onboarding)/paywall',
  params: { mode: 'resubscribe' },
} as unknown as Href;

/**
 * `source` (docs/plans/analytics-implementation.md WP2.5) feeds
 * `paywall_viewed.source` once the screen mounts -- an optional param so
 * every existing caller keeps landing on the plain routes above (paywall.tsx
 * defaults an absent `source` search param to `'onboarding'` itself). Only
 * callers that need to attribute a specific bounce (e.g. app/index.tsx's
 * `resume-paywall` branch, passing `'resume'`) supply it.
 */
export function onboardingPaywallRouteForMode(
  mode: OnboardingPaywallMode,
  source?: AnalyticsEventMap['paywall_viewed']['source'],
): Href {
  if (!source) {
    return mode === 'resubscribe' ? onboardingResubscribePaywallRoute : onboardingPaywallRoute;
  }
  return mode === 'resubscribe'
    ? ({ pathname: '/(onboarding)/paywall', params: { mode: 'resubscribe', source } } as unknown as Href)
    : ({ pathname: '/(onboarding)/paywall', params: { source } } as unknown as Href);
}

/** S1-S3, distinguished by the `beat` search param. */
export function onboardingStoryRoute(beat: 0 | 1 | 2): Href {
  return { pathname: '/(onboarding)/story', params: { beat: String(beat) } } as unknown as Href;
}

// S17 -- portrait reveal + sibling chain (WP6). `reveal` always needs to
// know which member's portrait just finished, so unlike every other
// onboarding-routes entry above it has no plain-string form.
export function onboardingRevealRoute(memberId: string): Href {
  return { pathname: '/(onboarding)/reveal', params: { memberId } } as unknown as Href;
}

/** Re-enters S16 for a specific member -- the sibling-chain CTA on S17.
 * `onboardingPortraitRoute` (no param) stays the plain default for the
 * first-time, fresh-from-S15 entry into S16. */
export function onboardingPortraitRouteForMember(memberId: string): Href {
  return { pathname: '/(onboarding)/portrait', params: { memberId } } as unknown as Href;
}

// J1-J5, the unauthenticated invited path -- deliberately under its own
// `join/` folder (see app/(onboarding)/join/* in WP4).
export const onboardingJoinCodeRoute = '/(onboarding)/join/code' as Href;
export const onboardingJoinFoundRoute = '/(onboarding)/join/found' as Href;
export const onboardingJoinNameRoute = '/(onboarding)/join/name' as Href;
export const onboardingJoinEmailRoute = '/(onboarding)/join/email' as Href;
export const onboardingJoinWaitingRoute = '/(onboarding)/join/waiting' as Href;

/**
 * Maps a resume point (`OnboardingDraft.step`, or a `resolvePostAuthDestination`
 * `resume-onboarding` result's `step` -- src/lib/onboarding-routing.ts) to
 * its screen. `story-0|1|2` all resolve through the single param-based
 * route above.
 *
 * WP6 deliberately did not add `reveal` (S17) to `OnboardingStepId`/this
 * switch. Every other step here is a plain, parameterless screen that can
 * render from the draft alone; `reveal` cannot -- it always needs to know
 * *which* member's portrait just finished, information the (pre-auth-
 * oriented) `OnboardingDraft` has no field for and which isn't derivable
 * from a bare step id. It's also functionally unreachable via this resume
 * path in practice: `resolvePostAuthDestination` only returns
 * `resume-onboarding` when the caller has zero memberships, but S17 only
 * ever fires after `commitOnboarding` has already created one -- the same
 * reason `trial`/`included`/`portrait`'s own `patch({step: ...})` calls are
 * still moot post-commit (see code.tsx's `finishAfterCommit`: `clear()`
 * empties the draft, including `committedFamilyId`, before routing into
 * that arc, specifically so the layout's backstop redirect doesn't trap
 * it). S15 is the intentional exception: it writes an explicit paywall
 * marker after the family exists, and `resolvePostAuthDestination` handles
 * that marker separately so an app kill can return to the purchase screen.
 * Adding a step id that can never correctly resolve a
 * route would be actively worse than omitting it.
 */
export function onboardingStepRoute(step: OnboardingStepId): Href {
  switch (step) {
    case 'welcome':
      return onboardingWelcomeRoute;
    case 'story-0':
      return onboardingStoryRoute(0);
    case 'story-1':
      return onboardingStoryRoute(1);
    case 'story-2':
      return onboardingStoryRoute(2);
    case 'founders':
      return onboardingFoundersRoute;
    case 'artifact':
      return onboardingArtifactRoute;
    case 'kids':
      return onboardingKidsRoute;
    case 'family-name':
      return onboardingFamilyNameRoute;
    case 'bridge':
      return onboardingBridgeRoute;
    case 'capture':
      return onboardingCaptureRoute;
    case 'aha':
      return onboardingAhaRoute;
    case 'year':
      return onboardingYearRoute;
    case 'notifications':
      return onboardingNotificationsRoute;
    case 'email':
      return onboardingEmailRoute;
    case 'code':
      return onboardingCodeRoute;
    case 'trial':
      return onboardingTrialRoute;
    case 'included':
      return onboardingIncludedRoute;
    case 'paywall':
      return onboardingPaywallRoute;
    case 'portrait':
      return onboardingPortraitRoute;
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}

type OnboardingAnalyticsStepView = AnalyticsEventMap['onboarding_step_viewed'];

/**
 * Pure mapping from `usePathname()`'s bare pathname (docs/plans/
 * analytics-implementation.md WP2.1) to the `onboarding_step_viewed` event's
 * `{step, flow}`. Expo Router strips the `(onboarding)` group segment, so
 * `usePathname()` returns `/welcome`, `/story`, `/join/code` -- NEVER
 * `/(onboarding)/welcome` -- which is why this switches on bare pathnames
 * instead of reusing the Href constants above. Returns `null` for any
 * pathname this layout doesn't own (defensive -- every route this layout
 * renders is listed below).
 *
 * `/story` is the one route this can't resolve from the pathname alone --
 * S1-S3 share a single screen distinguished by the `beat` search param
 * (`onboardingStoryRoute` above). The caller supplies it via
 * `useGlobalSearchParams()`, not `useLocalSearchParams()`, which at layout
 * level may not surface a leaf screen's params (see the `_layout.tsx` hook).
 * A missing/unparseable beat falls back to `story-0` rather than dropping
 * the event -- the same "beat 0 is the default" behavior `onboardingStoryRoute`
 * assumes.
 */
export function onboardingAnalyticsStepFromPathname(
  pathname: string,
  beatParam?: string | string[],
): OnboardingAnalyticsStepView | null {
  if (pathname === '/story') {
    const beat = Array.isArray(beatParam) ? beatParam[0] : beatParam;
    const step: OnboardingStepId = beat === '1' ? 'story-1' : beat === '2' ? 'story-2' : 'story-0';
    return { step, flow: 'owner' };
  }

  switch (pathname) {
    case '/welcome':
      return { step: 'welcome', flow: 'owner' };
    case '/founders':
      return { step: 'founders', flow: 'owner' };
    case '/artifact':
      return { step: 'artifact', flow: 'owner' };
    case '/kids':
      return { step: 'kids', flow: 'owner' };
    case '/family-name':
      return { step: 'family-name', flow: 'owner' };
    case '/bridge':
      return { step: 'bridge', flow: 'owner' };
    case '/capture':
      return { step: 'capture', flow: 'owner' };
    case '/aha':
      return { step: 'aha', flow: 'owner' };
    case '/year':
      return { step: 'year', flow: 'owner' };
    case '/notifications':
      return { step: 'notifications', flow: 'owner' };
    case '/email':
      return { step: 'email', flow: 'owner' };
    case '/code':
      return { step: 'code', flow: 'owner' };
    case '/trial':
      return { step: 'trial', flow: 'owner' };
    case '/included':
      return { step: 'included', flow: 'owner' };
    case '/paywall':
      return { step: 'paywall', flow: 'owner' };
    case '/portrait':
      return { step: 'portrait', flow: 'owner' };
    case '/reveal':
      return { step: 'reveal', flow: 'owner' };
    case '/join/code':
      return { step: 'join-code', flow: 'joiner' };
    case '/join/found':
      return { step: 'join-found', flow: 'joiner' };
    case '/join/name':
      return { step: 'join-name', flow: 'joiner' };
    case '/join/email':
      return { step: 'join-email', flow: 'joiner' };
    case '/join/waiting':
      return { step: 'join-waiting', flow: 'joiner' };
    default:
      return null;
  }
}
