import { Link, router } from 'expo-router';
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

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignIn = async () => {
    setErrorMessage('');
    setIsSubmitting(true);

    const { error } = await signIn({ email: email.trim(), password });

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
          New here?{' '}
          <Link href="/(auth)/signup" style={styles.link}>
            Create an account
          </Link>
        </Text>
      }
      subtitle="Sign in to capture and revisit your family's moments."
      title="Welcome back"
    >
      <AuthField label="Email">
        <AuthInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="you@example.com"
          testID="login-email-input"
          textContentType="emailAddress"
          value={email}
        />
      </AuthField>

      <AuthField label="Password">
        <AuthInput
          autoComplete="password"
          onChangeText={setPassword}
          placeholder="Your password"
          secureTextEntry
          testID="login-password-input"
          textContentType="password"
          value={password}
        />
      </AuthField>

      <AuthButton
        label="Forgot password?"
        onPress={() => router.push('/(auth)/forgot-password')}
        testID="login-forgot-password-button"
        variant="ghost"
      />

      <AuthErrorMessage message={errorMessage} />

      <AuthButton
        disabled={isSubmitting || !email.trim() || !password}
        label={isSubmitting ? 'Signing in…' : 'Sign in'}
        onPress={handleSignIn}
        testID="login-submit-button"
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
