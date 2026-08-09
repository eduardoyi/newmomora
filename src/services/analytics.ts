// PostHog analytics client (docs/plans/analytics-implementation.md WP1.3;
// event/privacy spec: docs/plans/analytics-tracking.md). This is the ONLY
// module that imports `posthog-react-native` -- screens must never call
// `posthog.capture` directly, they call `trackEvent` with a name from
// `AnalyticsEventMap` so every event's property shape is enforced at compile
// time.
//
// No `PostHogProvider` anywhere: autocapture, session replay, and screen
// auto-tracking are all off by design (tracking spec "Setup rules"), so the
// provider has no job -- a lazily-created singleton keeps the whole
// integration in this one file, out of `app-providers.tsx`.
//
// PRIVACY -- READ BEFORE ADDING AN EVENT: `AnalyticsEventMap` is the PII
// firewall. Every property value is restricted to
// `string | number | boolean | null` -- no free-form objects, so PII can't
// sneak in through a spread. Only closed string-literal unions, numbers,
// booleans, and UUID ids (e.g. `family_id`) are allowed. Never add a
// free-form string property. Never send memory content, transcripts, child/
// member/family names, emails, OTP codes, invite word-codes, media URIs,
// DOB/gender/notes, or comment bodies.
import PostHog from 'posthog-react-native';

import type { BillingAccessReason } from '@/constants/billing';
import type { PostAuthDestination } from '@/lib/onboarding-routing';
import type { IllustrationRequestIntent } from '@/services/ai';
import type { MemoryType } from '@/utils/memories';
import type { LookingBackPackageType } from '@/services/looking-back';
import type { OnboardingNotificationChoice, OnboardingPaywallMode, OnboardingStepId } from '@/utils/onboarding-progress';
import type { FamilyRole } from '@/utils/roles';
import type { PushRouteData } from '@/hooks/useNotifications';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/** Every value an analytics event or person property may carry. Deliberately
 * closed -- see the module doc comment above. */
type AnalyticsPropertyValue = string | number | boolean | null;
type AnalyticsEventProperties = Record<string, AnalyticsPropertyValue>;

/**
 * `onboarding_step_viewed.step` -- every `OnboardingStepId` plus `reveal`
 * (S17, deliberately not a member of `OnboardingStepId`; see the doc comment
 * above `onboardingStepRoute` in src/lib/onboarding-routes.ts) and the
 * joiner-only steps (J1-J5) that have no owner-flow `OnboardingStepId`
 * counterpart.
 */
type OnboardingAnalyticsStep =
  | OnboardingStepId
  | 'reveal'
  | 'join-code'
  | 'join-found'
  | 'join-name'
  | 'join-email'
  | 'join-waiting';

type PaywallSource = 'onboarding' | 'new_memory_bounce' | 'resume';

/**
 * Every event name and its exact property shape -- analytics-tracking.md
 * Tier 1 + Tier 2 tables, normative. Extend this map (never call
 * `posthog.capture` directly) when a future agent adds an event.
 */
export interface AnalyticsEventMap {
  // Tier 1 -- launch funnel
  onboarding_step_viewed: {
    step: OnboardingAnalyticsStep;
    flow: 'owner' | 'joiner';
  };
  onboarding_capture_completed: {
    method: 'voice' | 'typed';
    has_media: boolean;
    transcription_failed: boolean;
  };
  onboarding_committed: {
    kid_count: number;
    is_new_family: boolean;
  };
  paywall_viewed: {
    mode: OnboardingPaywallMode;
    trial_eligible: boolean;
    has_monthly: boolean;
    source: PaywallSource;
  };
  paywall_purchase_started: {
    plan: 'annual' | 'monthly';
  };
  paywall_purchase_completed: {
    plan: 'annual' | 'monthly';
  };
  paywall_purchase_failed: {
    code: 'store_cancel' | 'wrong_account_restore' | 'billing_confirmation_pending' | 'other';
  };
  paywall_error_shown: {
    code: 'unavailable' | 'offerings_unavailable' | 'generic';
  };
  paywall_abandoned: {
    mode: OnboardingPaywallMode;
  };
  post_auth_destination_resolved: {
    kind: PostAuthDestination['kind'];
    access_reason: BillingAccessReason | null;
  };

  // Tier 2 -- activation & retention
  memory_saved: {
    memory_type: MemoryType;
    used_voice: boolean;
    has_media: boolean;
    tagged_count: number;
    illustration_enabled: boolean;
    source: 'fab_timeline' | 'fab_calendar' | 'share_sheet' | 'notification' | 'other';
  };
  memory_save_failed: {
    code: 'validation_error' | 'media_upload_failed' | 'network_error' | 'other';
  };
  illustration_completed: {
    outcome: 'ready' | 'failed';
  };
  illustration_retry_requested: {
    intent: Extract<IllustrationRequestIntent, 'recovery' | 'manual_regenerate'>;
  };
  looking_back_package_opened: {
    package_type: LookingBackPackageType;
    memory_count: number;
    was_revisited: boolean;
  };
  looking_back_package_completed: {
    package_type: LookingBackPackageType;
    memory_count: number;
    frame_count: number;
  };
  looking_back_memory_opened: {
    package_type: LookingBackPackageType;
    memory_type: MemoryType;
  };
  looking_back_package_replayed: {
    package_type: LookingBackPackageType;
    memory_count: number;
  };
  invite_created: {
    role: 'manager' | 'viewer';
    family_id: string;
  };
  invite_redeemed: {
    family_id: string;
  };
  invite_resolved: {
    outcome: 'approved' | 'rejected';
    family_id: string;
  };
  notification_choice: {
    choice: OnboardingNotificationChoice;
    os_granted: boolean | null;
  };
  notification_opened: {
    target: NonNullable<PushRouteData['route']>;
  };
}

// Compile-time safety net: every event's properties must satisfy
// `AnalyticsEventProperties` (scalar values only, per the module doc
// comment). If this fails to compile, an event above smuggled in a
// non-scalar (object/array) property -- fix the event shape, not this check.
type AssertEventsAreScalarOnly = {
  [Event in keyof AnalyticsEventMap]: AnalyticsEventMap[Event] extends AnalyticsEventProperties ? true : never;
};
type EventsScalarCheck = AssertEventsAreScalarOnly[keyof AnalyticsEventMap] & true;
// Referenced so the type isn't reported unused; this line has no runtime effect.
export type _AnalyticsPrivacyCheck = EventsScalarCheck;

/**
 * Person properties set via `identifyUser`/`setPersonProperties` --
 * `{role, access_reason, membership_count}` per the tracking spec. Closed
 * for the same PII reasons as `AnalyticsEventMap`.
 */
export interface AnalyticsPersonProperties {
  role?: FamilyRole;
  access_reason?: BillingAccessReason;
  membership_count?: number;
}

// `undefined` = not yet created; `null` = created and found no API key (or
// creation failed) -- a stable no-op state so we don't retry construction on
// every call.
let client: PostHog | null | undefined;

// Every dashboard filters on `env = prod`; launch funnels are small-N and a
// few developer/simulator runs would otherwise skew them.
//
// `__DEV__` alone is NOT a safe discriminator: a dev-client launched without
// a Metro connection runs its embedded RELEASE bundle, so `__DEV__` is false
// and standalone test runs on a physical device self-report as prod
// (observed live: three device test runs landed as `env: prod`). The
// authoritative signal is `EXPO_PUBLIC_APP_ENV`, baked in per EAS
// environment ("production" only on the production environment); `__DEV__`
// is only the fallback for local runs without the var.
function resolveAnalyticsEnv(): 'dev' | 'prod' {
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV;
  if (appEnv) {
    return appEnv === 'production' ? 'prod' : 'dev';
  }
  return __DEV__ ? 'dev' : 'prod';
}

// Registered at client creation AND after every reset() -- reset clears
// registered super properties along with the distinct id (verified against a
// live project: post-sign-out events arrived without `env`, which would
// silently drop every post-sign-out user from the env-filtered dashboards).
function registerEnvSuperProperty(instance: PostHog): void {
  void instance.register({ env: resolveAnalyticsEnv() }).catch((error: unknown) => {
    console.warn('[analytics] failed to register super properties', error);
  });
}

function createClient(): PostHog | null {
  const apiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
    const instance = new PostHog(apiKey, {
      host,
      // NOTE: the installed posthog-react-native SDK (dist/posthog-rn.d.ts)
      // names this option `captureAppLifecycleEvents`, not
      // `captureNativeAppLifecycleEvents` as an earlier draft of the
      // implementation plan assumed. Using the SDK's actual name.
      captureAppLifecycleEvents: true,
    });
    registerEnvSuperProperty(instance);
    return instance;
  } catch (error) {
    console.warn('[analytics] failed to initialize PostHog client', error);
    return null;
  }
}

function getClient(): PostHog | null {
  if (client === undefined) {
    client = createClient();
  }
  return client;
}

/**
 * Fires a typed analytics event. Silent no-op when no API key is configured
 * (dev without env, all tests) and never throws -- a missing key or a
 * PostHog outage must never block or break a user flow. Fire-and-forget by
 * design: never `await` this in a UI path.
 */
export function trackEvent<EventName extends keyof AnalyticsEventMap>(
  event: EventName,
  properties: AnalyticsEventMap[EventName],
): void {
  try {
    const posthog = getClient();
    if (!posthog) return;
    posthog.capture(event, properties as AnalyticsEventProperties);
  } catch (error) {
    console.warn('[analytics] trackEvent failed', event, error);
  }
}

/**
 * Identifies the current distinct id as `userId` (the Supabase user id --
 * the same id RevenueCat uses as `appUserID`, so PostHog and RevenueCat
 * distinct ids match with zero aliasing). Callers: see the anonymous-session
 * guard in `use-auth.tsx` -- never call this for an anonymous Supabase
 * session.
 */
export function identifyUser(userId: string, properties?: AnalyticsPersonProperties): void {
  try {
    const posthog = getClient();
    if (!posthog) return;
    posthog.identify(userId, properties as AnalyticsEventProperties | undefined);
  } catch (error) {
    console.warn('[analytics] identifyUser failed', error);
  }
}

/** Sets/updates properties on the currently-identified person profile. */
export function setPersonProperties(properties: AnalyticsPersonProperties): void {
  try {
    const posthog = getClient();
    if (!posthog) return;
    posthog.setPersonProperties(properties as AnalyticsEventProperties);
  } catch (error) {
    console.warn('[analytics] setPersonProperties failed', error);
  }
}

/**
 * Resets the PostHog distinct id (a fresh anonymous id going forward).
 * Called on sign-out and on switching between two different non-anonymous
 * Supabase sessions -- never on an anonymous session appearing or
 * disappearing (see the identity effect in `use-auth.tsx`).
 */
export function resetAnalytics(): void {
  try {
    const posthog = getClient();
    if (!posthog) return;
    posthog.reset();
    // reset() wipes registered super properties -- without this, every
    // event after a sign-out loses `env` and drops out of the env-filtered
    // dashboards (see registerEnvSuperProperty's doc comment).
    registerEnvSuperProperty(posthog);
  } catch (error) {
    console.warn('[analytics] resetAnalytics failed', error);
  }
}
