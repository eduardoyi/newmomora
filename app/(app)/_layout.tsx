import { Redirect, Stack, useSegments } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { noFamilyRoute } from '@/lib/routes';

export default function AppLayout() {
  const { session, isLoading: isAuthLoading } = useAuth();
  const { familyId, isLoading: isFamilyLoading } = useFamily();
  const segments = useSegments();
  // expo-router's typed useSegments() return type is a union of per-depth
  // literal tuples, which collapses .includes()'s element type to `never`
  // for an arbitrary string -- widen to string[] for this membership check.
  const isOnNoFamilyRoute = (segments as string[]).includes('no-family');

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
  // through the Stack below so the user can act on it (create a family, or
  // in Phase 5, redeem an invite code carried in AsyncStorage).
  if (!familyId && !isOnNoFamilyRoute) {
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
