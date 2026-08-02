import { Redirect } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { BillingStatusGate } from '@/components/billing-status-gate';
import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import {
  onboardingJoinCodeRoute,
  onboardingJoinFoundRoute,
  onboardingPaywallRouteForMode,
  onboardingStepRoute,
  onboardingWelcomeRoute,
} from '@/lib/onboarding-routes';
import { resolvePostAuthDestination, type PostAuthDestination } from '@/lib/onboarding-routing';
import { timelineRoute } from '@/lib/routes';
import { setPersonProperties, trackEvent, type AnalyticsPersonProperties } from '@/services/analytics';
import { getOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';
import { getPendingInviteCode } from '@/utils/pending-invite-code';
import { type FamilyRole } from '@/utils/roles';

const KNOWN_FAMILY_ROLES: readonly FamilyRole[] = ['owner', 'manager', 'viewer'];

function toFamilyRole(role: string | null | undefined): FamilyRole | undefined {
  return role && (KNOWN_FAMILY_ROLES as readonly string[]).includes(role) ? (role as FamilyRole) : undefined;
}

/**
 * The app's front door (docs/plans/onboarding-implementation.md WP5, spec
 * decision 2: "the new flow is the front door"). No session -> S0
 * (unauthenticated launches always start there now, not the quiet login
 * screen). A session -> resolvePostAuthDestination (spec decision 17):
 * `intent: 'login'` because a cold launch/relaunch is never a fork-button
 * tap -- there is no UI hint to pass (see that function's rule 3 doc
 * comment). Paid or complimentary owners land in their existing journal;
 * owners with no purchase history resume the first-time trial paywall, and
 * lapsed owners resume the no-trial resubscribe paywall. An explicitly marked
 * unfinished S15 paywall is always resumed.
 */
export default function IndexScreen() {
  const { session, isLoading: isAuthLoading } = useAuth();
  const { memberships, isLoading: isFamilyLoading, role } = useFamily();
  const {
    status: billingStatus,
    billingStatusError,
    isLoading: isBillingLoading,
    refresh: refreshBilling,
  } = useBilling();
  const [deviceState, setDeviceState] = useState<{
    isHydrated: boolean;
    draft: OnboardingDraft | null;
    hasPendingInviteCode: boolean;
  }>({ isHydrated: false, draft: null, hasPendingInviteCode: false });

  useEffect(() => {
    if (!session) {
      return;
    }

    let isMounted = true;

    void Promise.all([getOnboardingDraft(), getPendingInviteCode()]).then(([draft, pendingCode]) => {
      if (!isMounted) {
        return;
      }
      setDeviceState({ isHydrated: true, draft, hasPendingInviteCode: Boolean(pendingCode) });
    });

    return () => {
      isMounted = false;
    };
  }, [session]);

  const isBillingBlocked = memberships.length > 0 && !billingStatus && isBillingLoading;
  const isBillingFailed = Boolean(memberships.length > 0 && !billingStatus && billingStatusError);
  // Mirrors the early-return loading/gate checks below exactly -- once none
  // of them fire, these are all the conditions that must already be false,
  // so `destination` is guaranteed non-null by the time the switch below
  // runs (the `if (!destination)` guard there is a defensive fallback, not
  // the expected path).
  const isReady = Boolean(
    session && !isAuthLoading && !isFamilyLoading && deviceState.isHydrated && !isBillingBlocked && !isBillingFailed,
  );

  const destination: PostAuthDestination | null = isReady
    ? resolvePostAuthDestination({
        memberships: memberships.map((membership) => ({ familyId: membership.familyId, role: membership.role })),
        hasPendingInviteCode: deviceState.hasPendingInviteCode,
        draft: deviceState.draft,
        billing: billingStatus
          ? {
              familyId: billingStatus.family_id,
              isOwner: memberships.some(
                (membership) => membership.familyId === billingStatus.family_id && membership.role === 'owner',
              ),
              hasWriteAccess: billingStatus.has_write_access,
              hasEverHadAccess: billingStatus.has_ever_had_access,
              trialEligible: billingStatus.trial_eligible,
            }
          : null,
        intent: 'login',
      })
    : null;

  // post_auth_destination_resolved (docs/plans/analytics-implementation.md
  // WP2.7) -- the destination above is computed synchronously in the render
  // body, so this fires from an effect keyed on the resolved `kind`, deduped
  // per mount; firing from the render path would double-count every
  // re-render while billing/memberships are still settling.
  const lastTrackedDestinationKindRef = useRef<PostAuthDestination['kind'] | null>(null);
  useEffect(() => {
    if (!destination || lastTrackedDestinationKindRef.current === destination.kind) {
      return;
    }
    lastTrackedDestinationKindRef.current = destination.kind;
    trackEvent('post_auth_destination_resolved', {
      kind: destination.kind,
      access_reason: billingStatus?.access_reason ?? null,
    });
  }, [billingStatus, destination]);

  // Person properties (WP1.6) -- {role, access_reason, membership_count}
  // set here, where billing status and memberships are already in hand.
  // `access_reason` is refreshed again on the paywall once billing settles
  // there (it isn't known here for a pre-purchase owner).
  const lastPersonPropertiesKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!destination) {
      return;
    }
    const personProperties: AnalyticsPersonProperties = { membership_count: memberships.length };
    const mappedRole = toFamilyRole(role);
    if (mappedRole) {
      personProperties.role = mappedRole;
    }
    if (billingStatus?.access_reason) {
      personProperties.access_reason = billingStatus.access_reason;
    }
    const key = JSON.stringify(personProperties);
    if (lastPersonPropertiesKeyRef.current === key) {
      return;
    }
    lastPersonPropertiesKeyRef.current = key;
    setPersonProperties(personProperties);
  }, [billingStatus, destination, memberships.length, role]);

  if (isAuthLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!session) {
    return <Redirect href={onboardingWelcomeRoute} />;
  }

  if (isFamilyLoading || !deviceState.isHydrated || isBillingBlocked) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (isBillingFailed) {
    return <BillingStatusGate onRetry={refreshBilling} />;
  }

  if (!destination) {
    // Unreachable in practice -- isReady mirrors every check above -- kept
    // as a defensive fallback instead of a non-null assertion.
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  switch (destination.kind) {
    case 'journal':
      return <Redirect href={timelineRoute} />;
    case 'resume-onboarding':
      return <Redirect href={onboardingStepRoute(destination.step)} />;
    case 'resume-paywall':
      return <Redirect href={onboardingPaywallRouteForMode(destination.mode, 'resume')} />;
    case 'finish-join':
      return <Redirect href={onboardingJoinFoundRoute} />;
    case 'ask-invite-code':
      return <Redirect href={onboardingJoinCodeRoute} />;
    default: {
      const exhaustive: never = destination;
      return exhaustive;
    }
  }
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
});
