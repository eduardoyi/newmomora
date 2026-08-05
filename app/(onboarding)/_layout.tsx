// Onboarding route group layout (docs/plans/onboarding-implementation.md
// WP1). Mounts OnboardingFlowProvider once for the whole S0-S16 + J1-J5 arc
// and holds rendering behind a spinner until the device-local draft has
// hydrated -- a screen reading `draft` before hydration would see the
// fresh-mount default and could clobber a real resume point (see
// src/hooks/use-onboarding-flow.tsx). Authenticated-history backstops live
// here so stale pre-auth entries do not re-render for a family member.
// Front-door destination resolution itself
// (unauthenticated -> welcome, session -> resolvePostAuthDestination) remains
// owned by app/index.tsx and the auth layout.
//
// Every onboarding route is registered below regardless of which package's
// file exists yet: WP1 (this package) owns welcome/story/founders/artifact/
// kids/family-name/bridge; WP2 owns capture/aha/year/notifications/email/
// code; WP3 owns trial/included/paywall/portrait; WP4 owns join/*; WP6 adds
// reveal (S17). A Stack.Screen naming a route with no matching file yet is
// harmless -- expo-router's useSortedScreens only logs a dev warning and
// renders nothing for it until the file lands -- so this list can be
// complete on day one instead of growing PR by PR.
import { Redirect, Stack, useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { OnboardingFlowProvider, useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { isOnboardingRouteAllowedAfterAuth, onboardingAnalyticsStepFromPathname } from '@/lib/onboarding-routes';
import { rootRoute, timelineRoute } from '@/lib/routes';
import { trackEvent } from '@/services/analytics';

export default function OnboardingLayout() {
  return (
    <OnboardingFlowProvider>
      <OnboardingLayoutContent />
    </OnboardingFlowProvider>
  );
}

function OnboardingLayoutContent() {
  const { draft, isHydrated } = useOnboardingFlow();
  const { isLoading: isAuthLoading, session } = useAuth();
  const { memberships } = useFamily();

  // onboarding_step_viewed (docs/plans/analytics-implementation.md WP2.1) --
  // the single hook for the whole S0-S17 + J1-J5 arc. usePathname() returns
  // the BARE pathname (`/welcome`, `/join/code`) -- Expo Router strips the
  // `(onboarding)` group segment -- so the mapping switches on that shape
  // (see onboardingAnalyticsStepFromPathname's doc comment). `beat` rides
  // useGlobalSearchParams(), not useLocalSearchParams(), which at this
  // layout level may not surface a leaf screen's params. Dedupe consecutive
  // repeats only: a portrait <-> reveal sibling-chain re-entry changes the
  // pathname each hop, so it naturally clears the dedupe key and fires again
  // (a genuinely new view, not a re-render of the same one).
  const pathname = usePathname();
  const { beat } = useGlobalSearchParams<{ beat?: string }>();
  const lastTrackedStepKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const view = onboardingAnalyticsStepFromPathname(pathname, beat);
    if (!view) {
      return;
    }
    const key = `${view.flow}:${view.step}`;
    if (lastTrackedStepKeyRef.current === key) {
      return;
    }
    lastTrackedStepKeyRef.current = key;
    trackEvent('onboarding_step_viewed', view);
  }, [pathname, beat]);

  if (!isHydrated || isAuthLoading) {
    return (
      <View style={styles.loading} testID="onboarding-layout-spinner">
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  // OTP verification replaces the current onboarding screen, but the native
  // stack can still retain the earlier pre-auth story/capture routes. If a
  // signed-in user walks back into one of those stale entries, send them
  // through the authenticated front door so billing-aware routing decides
  // between the journal and the appropriate paywall. Keep the real post-auth
  // trial/paywall/portrait arc mounted, and let an in-progress S12B commit
  // recover from its own retryable state.
  if (
    session &&
    memberships.length > 0 &&
    !isOnboardingRouteAllowedAfterAuth(pathname, draft.step)
  ) {
    return <Redirect href={rootRoute} />;
  }

  // Backstop only -- a normal flow never lands back on an onboarding route
  // once the family/kids/first memory are committed. This guards a stray
  // deep link or a stale nav-stack entry from re-running the story arc for
  // someone who is already fully set up.
  // A returning lapsed owner may have a confirmed family but an unsaved
  // capture. That draft must be allowed to reach the resubscribe paywall;
  // only a fully handed-off capture gets the journal backstop.
  if (session && draft.committedFamilyId && draft.captureCommitted !== false) {
    return <Redirect href={timelineRoute} />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="story" />
      <Stack.Screen name="founders" />
      <Stack.Screen name="artifact" />
      <Stack.Screen name="kids" />
      <Stack.Screen name="family-name" />
      <Stack.Screen name="bridge" />
      {/* WP2 */}
      <Stack.Screen name="capture" />
      <Stack.Screen name="aha" />
      <Stack.Screen name="year" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="email" />
      <Stack.Screen name="code" />
      {/* WP3 */}
      <Stack.Screen name="trial" />
      <Stack.Screen name="included" />
      <Stack.Screen name="paywall" />
      <Stack.Screen name="portrait" />
      <Stack.Screen name="reveal" />
      {/* WP4 */}
      <Stack.Screen name="join/code" />
      <Stack.Screen name="join/found" />
      <Stack.Screen name="join/name" />
      <Stack.Screen name="join/email" />
      <Stack.Screen name="join/waiting" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    flex: 1,
    justifyContent: 'center',
  },
});
