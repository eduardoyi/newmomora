import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  onboardingJoinCodeRoute,
  onboardingJoinFoundRoute,
  onboardingStepRoute,
  onboardingWelcomeRoute,
} from '@/lib/onboarding-routes';
import { resolvePostAuthDestination } from '@/lib/onboarding-routing';
import { timelineRoute } from '@/lib/routes';
import { getOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';
import { getPendingInviteCode } from '@/utils/pending-invite-code';

/**
 * The app's front door (docs/plans/onboarding-implementation.md WP5, spec
 * decision 2: "the new flow is the front door"). No session -> S0
 * (unauthenticated launches always start there now, not the quiet login
 * screen). A session -> resolvePostAuthDestination (spec decision 17):
 * `intent: 'login'` because a cold launch/relaunch is never a fork-button
 * tap -- there is no UI hint to pass (see that function's rule 3 doc
 * comment). This covers the returning-owner edge case explicitly called out
 * in docs/features/onboarding.md: a reinstalling owner lands straight in
 * their existing journal, never a second family or the paywall.
 */
export default function IndexScreen() {
  const { session, isLoading: isAuthLoading } = useAuth();
  const { memberships, isLoading: isFamilyLoading } = useFamily();
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

  if (!session) {
    return <Redirect href={onboardingWelcomeRoute} />;
  }

  if (isFamilyLoading || !deviceState.isHydrated) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  const destination = resolvePostAuthDestination({
    memberships: memberships.map((membership) => ({ familyId: membership.familyId })),
    hasPendingInviteCode: deviceState.hasPendingInviteCode,
    draft: deviceState.draft,
    intent: 'login',
  });

  switch (destination.kind) {
    case 'journal':
      return <Redirect href={timelineRoute} />;
    case 'resume-onboarding':
      return <Redirect href={onboardingStepRoute(destination.step)} />;
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
