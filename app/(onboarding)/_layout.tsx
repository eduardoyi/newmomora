// Onboarding route group layout (docs/plans/onboarding-implementation.md
// WP1). Mounts OnboardingFlowProvider once for the whole S0-S16 + J1-J5 arc
// and holds rendering behind a spinner until the device-local draft has
// hydrated -- a screen reading `draft` before hydration would see the
// fresh-mount default and could clobber a real resume point (see
// src/hooks/use-onboarding-flow.tsx). One backstop redirect lives here: an
// already-authenticated user whose onboarding draft is already committed
// (see OnboardingDraft.committedFamilyId) goes straight to the journal
// instead of re-rendering a story screen. Front-door routing itself
// (unauthenticated -> welcome, session -> resolvePostAuthDestination) is
// WP5's job, not this layout's.
//
// Every onboarding route is registered below regardless of which package's
// file exists yet: WP1 (this package) owns welcome/story/founders/artifact/
// kids/family-name/bridge; WP2 owns capture/aha/year/notifications/email/
// code; WP3 owns trial/included/paywall/portrait; WP4 owns join/*; WP6 adds
// reveal (S17). A Stack.Screen naming a route with no matching file yet is
// harmless -- expo-router's useSortedScreens only logs a dev warning and
// renders nothing for it until the file lands -- so this list can be
// complete on day one instead of growing PR by PR.
import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { OnboardingFlowProvider, useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { timelineRoute } from '@/lib/routes';

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

  if (!isHydrated || isAuthLoading) {
    return (
      <View style={styles.loading} testID="onboarding-layout-spinner">
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  // Backstop only -- a normal flow never lands back on an onboarding route
  // once the family/kids/first memory are committed. This guards a stray
  // deep link or a stale nav-stack entry from re-running the story arc for
  // someone who is already fully set up.
  if (session && draft.committedFamilyId) {
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
