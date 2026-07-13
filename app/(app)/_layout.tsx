import { Redirect, Stack, useSegments } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useNotificationResponseRouting } from '@/hooks/useNotifications';
import { noFamilyRoute } from '@/lib/routes';

export default function AppLayout() {
  const { session, isLoading: isAuthLoading } = useAuth();
  const { familyId, isLoading: isFamilyLoading } = useFamily();
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
  if (!familyId && !isOnNoFamilyRoute && !isOnSharingRoute) {
    return <Redirect href={noFamilyRoute} />;
  }

  return (
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
      <Stack.Screen
        name="memory/[id]/edit"
        options={{ presentation: 'modal' }}
      />
      <Stack.Screen name="family/[id]" />
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
