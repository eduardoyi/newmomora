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

export default function AppReviewAccessScreen() {
  const { signInWithPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignIn = async () => {
    setErrorMessage('');
    setIsSubmitting(true);

    const { error } = await signInWithPassword({
      email: email.trim(),
      password,
    });

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
            Back to email code sign-in
          </Link>
        </Text>
      }
      subtitle="For App Store and Google Play reviewers using credentials supplied in the review notes."
      title="App review access"
    >
      <AuthField label="Reviewer email">
        <AuthInput
          accessibilityLabel="Reviewer email"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="Reviewer email"
          testID="app-review-email-input"
          textContentType="emailAddress"
          value={email}
        />
      </AuthField>

      <AuthField label="Reviewer password">
        <AuthInput
          accessibilityLabel="Reviewer password"
          autoCapitalize="none"
          autoComplete="password"
          onChangeText={setPassword}
          placeholder="Reviewer password"
          secureTextEntry
          testID="app-review-password-input"
          textContentType="password"
          value={password}
        />
      </AuthField>

      <AuthErrorMessage message={errorMessage} />

      <AuthButton
        disabled={isSubmitting || !email.trim() || !password}
        label={isSubmitting ? 'Signing in…' : 'Sign in for review'}
        onPress={handleSignIn}
        testID="app-review-submit-button"
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
