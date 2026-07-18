import { Link, Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import {
  AuthButton,
  AuthErrorMessage,
  AuthField,
  AuthInput,
  AuthScreen,
} from '@/components/auth-screen';
import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { isPasswordLoginEmail, normalizeEmail } from '@/services/reviewer-auth';

export default function PasswordScreen() {
  const { email: routeEmail } = useLocalSearchParams<{ email?: string | string[] }>();
  const email = typeof routeEmail === 'string' ? normalizeEmail(routeEmail) : '';

  if (!isPasswordLoginEmail(email)) {
    return <Redirect href="/(auth)/login" />;
  }

  return <PasswordForm email={email} />;
}

function PasswordForm({ email }: { email: string }) {
  const { signInWithPassword } = useAuth();
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignIn = async () => {
    setErrorMessage('');
    setIsSubmitting(true);

    const { error } = await signInWithPassword({ email, password });

    setIsSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    router.replace('/(app)/(tabs)/timeline');
  };

  return (
    <AuthScreen
      footer={
        <Text style={styles.footerText}>
          <Link href="/(auth)/login" style={styles.link}>
            Use a different email
          </Link>
        </Text>
      }
      subtitle={`Sign in as ${email}.`}
      title="Enter your password"
    >
      <AuthField label="Password">
        <AuthInput
          accessibilityLabel="Password"
          autoComplete="current-password"
          onChangeText={setPassword}
          placeholder="Your password"
          secureTextEntry
          testID="password-input"
          textContentType="password"
          value={password}
        />
      </AuthField>

      <AuthErrorMessage message={errorMessage} />

      <AuthButton
        disabled={isSubmitting || !password}
        label={isSubmitting ? 'Signing in…' : 'Sign in'}
        onPress={handleSignIn}
        testID="password-submit-button"
      />
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  footerText: {
    color: colors.textMuted,
    fontSize: 15,
  },
  link: {
    color: colors.primary,
    fontWeight: '700',
  },
});
