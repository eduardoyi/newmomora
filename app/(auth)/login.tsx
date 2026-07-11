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
import { isE2eFixturesEnabled } from '@/utils/e2e-fixtures';

export default function LoginScreen() {
  const { requestSignInOtp, signInWithPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Dev/E2E only: password provider stays enabled server-side for Maestro, but the toggle
  // that exposes it never renders (and this branch is dead-code-eliminated) in production
  // builds — same __DEV__ gating pattern as the family-member photo fixture.
  const showDevPasswordToggle = isE2eFixturesEnabled();
  const [isDevPasswordVisible, setIsDevPasswordVisible] = useState(false);
  const [devPassword, setDevPassword] = useState('');
  const [isDevSubmitting, setIsDevSubmitting] = useState(false);

  const handleContinue = async () => {
    setErrorMessage('');
    setIsSubmitting(true);

    const trimmedEmail = email.trim();
    const { error, userNotFound } = await requestSignInOtp(trimmedEmail);

    setIsSubmitting(false);

    if (userNotFound) {
      router.push({ pathname: '/(auth)/signup', params: { email: trimmedEmail } });
      return;
    }

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    router.push({
      pathname: '/(auth)/verify-otp',
      params: { email: trimmedEmail, mode: 'signin' },
    });
  };

  const handleDevPasswordSignIn = async () => {
    setErrorMessage('');
    setIsDevSubmitting(true);

    const { error } = await signInWithPassword({ email: email.trim(), password: devPassword });

    setIsDevSubmitting(false);

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
      subtitle="Enter your email and we'll send you a sign-in code."
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

      <AuthErrorMessage message={errorMessage} />

      <AuthButton
        disabled={isSubmitting || !email.trim()}
        label={isSubmitting ? 'Sending code…' : 'Continue'}
        onPress={handleContinue}
        testID="login-submit-button"
      />

      {showDevPasswordToggle && (
        <>
          <AuthButton
            label={isDevPasswordVisible ? 'Hide dev sign-in' : 'Dev: password sign-in'}
            onPress={() => setIsDevPasswordVisible((visible) => !visible)}
            testID="login-dev-toggle-button"
            variant="ghost"
          />

          {isDevPasswordVisible && (
            <>
              <AuthField label="Password (dev only)">
                <AuthInput
                  autoComplete="password"
                  onChangeText={setDevPassword}
                  placeholder="Your password"
                  secureTextEntry
                  testID="login-password-input"
                  textContentType="password"
                  value={devPassword}
                />
              </AuthField>

              <AuthButton
                disabled={isDevSubmitting || !email.trim() || !devPassword}
                label={isDevSubmitting ? 'Signing in…' : 'Sign in with password'}
                onPress={handleDevPasswordSignIn}
                testID="login-dev-submit-button"
              />
            </>
          )}
        </>
      )}
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
