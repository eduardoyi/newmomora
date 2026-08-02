import { Redirect, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
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
} from '@/lib/onboarding-routes';
import { resolvePostAuthDestination } from '@/lib/onboarding-routing';
import { timelineRoute } from '@/lib/routes';
import { getOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';
import { getPendingInviteCode } from '@/utils/pending-invite-code';

/**
 * (auth)/login, signup, and verify-otp stay as the quiet "Log in" branch
 * (spec decision 2) -- this layout only guards against a session landing
 * here at all. It used to hard-redirect any session straight to the
 * timeline, which would strand a user mid-onboarding (e.g. a stray nav back
 * to /(auth)/login while an anonymous or freshly-verified session already
 * has a resume point). Route through the same resolvePostAuthDestination
 * front door as app/index.tsx instead -- see that file's comment for why
 * `intent: 'login'` is correct here too (this is never a fork-button tap).
 */
export default function AuthLayout() {
  const { session, isLoading: isAuthLoading } = useAuth();
  const { memberships, isLoading: isFamilyLoading } = useFamily();
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

  if (isAuthLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (session) {
    if (
      isFamilyLoading ||
      !deviceState.isHydrated ||
      (memberships.length > 0 && !billingStatus && isBillingLoading)
    ) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      );
    }

    if (memberships.length > 0 && !billingStatus && billingStatusError) {
      return <BillingStatusGate onRetry={refreshBilling} />;
    }

    const destination = resolvePostAuthDestination({
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
    });

    switch (destination.kind) {
      case 'journal':
        return <Redirect href={timelineRoute} />;
      case 'resume-onboarding':
        return <Redirect href={onboardingStepRoute(destination.step)} />;
      case 'resume-paywall':
        return <Redirect href={onboardingPaywallRouteForMode(destination.mode)} />;
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

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="password" />
      <Stack.Screen name="signup" />
      <Stack.Screen name="verify-otp" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
});
