import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';

export default function AppLayout() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
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
