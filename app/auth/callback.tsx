import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useAuthUrlHandler } from '@/hooks/use-auth-url-handler';

/** Deep-link landing route: momora://auth/callback */
export default function AuthCallbackScreen() {
  useAuthUrlHandler();
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (session) {
    return <Redirect href="/(app)/(tabs)/timeline" />;
  }

  return <Redirect href="/(auth)/login" />;
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
});
