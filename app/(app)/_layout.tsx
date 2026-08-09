import { Redirect, Stack, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { OfflineBanner, OfflineBannerProvider } from '@/components/offline-banner';
import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useNotificationResponseRouting } from '@/hooks/useNotifications';
import { useAiUsageLimitNotices } from '@/hooks/useAiUsageLimitNotices';
import { LookingBackSessionProvider } from '@/hooks/useLookingBackSession';
import { noFamilyRoute } from '@/lib/routes';

export default function AppLayout() {
  const { session, isLoading: isAuthLoading } = useAuth();
  const { familyId, isLoading: isFamilyLoading, refetchMemberships } = useFamily();
  useAiUsageLimitNotices();
  // Deep-link routing for tapped push notifications (plan §10) -- lives at
  // the app root so it's active for the whole authenticated session
  // regardless of which screen is focused. `ready` gates the cold-start
  // (getLastNotificationResponseAsync) check until this layout is about to
  // render its actual Stack below -- while auth/family are still loading it
  // renders only a spinner, so navigating any earlier would target routes
  // that aren't mounted yet.
  useNotificationResponseRouting(!isAuthLoading && Boolean(session) && !isFamilyLoading);
  const segments = useSegments();
  // expo-router's typed useSegments() return type is a union of per-depth
  // literal tuples, which collapses .includes()'s element type to `never`
  // for an arbitrary string -- widen to string[] for this membership check.
  const isOnNoFamilyRoute = (segments as string[]).includes('no-family');
  // The redeem/waiting screens must stay reachable for users with zero
  // memberships (that's exactly who redeems invites), so the whole sharing
  // group is exempt from the no-family redirect. Manager-only sharing
  // screens guard themselves on role.
  const isOnSharingRoute = (segments as string[]).includes('sharing');

  // Onboarding's commit step (commitOnboarding, src/services/onboarding.ts,
  // run from app/(onboarding)/code.tsx) creates a brand-new family through
  // direct service calls, not a query-invalidating mutation, and the
  // screens between there and here (S13-S16, e.g.
  // app/(onboarding)/portrait.tsx's "Take me to the journal") never
  // explicitly refetch memberships before handing off to the journal.
  // FamilyProvider's cached membership list (use-family.tsx) can therefore
  // still read empty for a session even though a family now genuinely
  // exists -- nothing else refetches it (no AppState/focus event fires
  // during a single continuous foreground session). Confirm with one fresh
  // refetch before trusting an empty result enough to bounce the user to
  // the create-a-family screen: this keeps the guard from fighting a user
  // who just finished onboarding, without weakening it for a real
  // zero-family account (which still lands on no-family once this refetch
  // also comes back empty).
  const hasStartedNoFamilyConfirmationRef = useRef(false);
  const [isConfirmingNoFamily, setIsConfirmingNoFamily] = useState(false);

  useEffect(() => {
    if (
      isAuthLoading ||
      isFamilyLoading ||
      !session ||
      familyId ||
      isOnNoFamilyRoute ||
      isOnSharingRoute ||
      hasStartedNoFamilyConfirmationRef.current
    ) {
      return;
    }

    hasStartedNoFamilyConfirmationRef.current = true;
    setIsConfirmingNoFamily(true);
    void refetchMemberships().finally(() => setIsConfirmingNoFamily(false));
  }, [
    isAuthLoading,
    isFamilyLoading,
    session,
    familyId,
    isOnNoFamilyRoute,
    isOnSharingRoute,
    refetchMemberships,
  ]);

  useEffect(() => {
    // Reset the one-shot guard once a family is present (e.g. sign-out and
    // back in as someone else later) so a later legitimate no-family state
    // still gets its own confirming refetch.
    if (familyId) {
      hasStartedNoFamilyConfirmationRef.current = false;
    }
  }, [familyId]);

  if (isAuthLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  if (isFamilyLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  // Guard precedence (docs/plans/family-sharing.md §9): this only redirects
  // away from OTHER routes -- the no-family route itself must still render
  // through the Stack below so the user can act on it (create a family or
  // redeem an invite code carried in AsyncStorage), and the sharing group
  // (redeem/waiting) must not be clobbered while a redemption is in flight.
  // `isConfirmingNoFamily` (see the effect above) holds this redirect one
  // beat for the one-shot confirming refetch -- a real zero-family account
  // still lands here the moment that refetch also comes back empty.
  if (!familyId && !isOnNoFamilyRoute && !isOnSharingRoute) {
    if (isConfirmingNoFamily) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      );
    }
    return <Redirect href={noFamilyRoute} />;
  }

  return (
    // OfflineBanner is a sibling ABOVE the Stack (not inside (tabs)) so it
    // overlays every screen this layout owns, including the pushed
    // memory-detail screen -- see the component's own comment for why it's
    // an absolute overlay rather than a layout-flow element.
    <LookingBackSessionProvider>
    <OfflineBannerProvider>
    <View style={styles.stackWrap}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="no-family" />
        <Stack.Screen
          name="add-family-member"
          options={{
            presentation: 'modal',
          }}
        />
        <Stack.Screen
          name="new-memory"
          options={{
            presentation: 'modal',
          }}
        />
        <Stack.Screen name="memory/[id]" />
        <Stack.Screen name="looking-back/[id]" options={{ animation: 'none' }} />
        <Stack.Screen
          name="memory/[id]/edit"
          options={{ presentation: 'modal' }}
        />
        <Stack.Screen name="family/[id]" />
        <Stack.Screen name="family/[id]/portraits" />
        <Stack.Screen
          name="family/[id]/edit"
          options={{ presentation: 'modal' }}
        />
        <Stack.Screen name="sharing/members" />
        <Stack.Screen
          name="sharing/invite"
          options={{ presentation: 'modal' }}
        />
        <Stack.Screen name="sharing/pending-invites" />
        <Stack.Screen name="sharing/approvals" />
        <Stack.Screen name="sharing/redeem" />
        <Stack.Screen name="sharing/waiting" />
      </Stack>
      <OfflineBanner />
    </View>
    </OfflineBannerProvider>
    </LookingBackSessionProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
  stackWrap: {
    flex: 1,
  },
});
