import { Link, router, useLocalSearchParams } from 'expo-router';
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

export default function SignUpScreen() {
  const { requestSignUpOtp } = useAuth();
  const params = useLocalSearchParams<{ email?: string }>();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(params.email ?? '');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignUp = async () => {
    setErrorMessage('');
    setIsSubmitting(true);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    const { error } = await requestSignUpOtp({ name: trimmedName, email: trimmedEmail });

    setIsSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    router.push({
      pathname: '/(auth)/verify-otp',
      params: { email: trimmedEmail, mode: 'signup', name: trimmedName },
    });
  };

  return (
    <AuthScreen
      footer={
        <Text style={styles.footerText}>
          Already have an account?{' '}
          <Link href="/(auth)/login" style={styles.link}>
            Sign in
          </Link>
        </Text>
      }
      subtitle="Start your family memory journal in a private space."
      title="Create your account"
    >
      <AuthField label="Your name">
        <AuthInput
          autoComplete="name"
          onChangeText={setName}
          placeholder="How should we greet you?"
          testID="signup-name-input"
          textContentType="name"
          value={name}
        />
      </AuthField>

      <AuthField label="Email">
        <AuthInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="you@example.com"
          testID="signup-email-input"
          textContentType="emailAddress"
          value={email}
        />
      </AuthField>

      <AuthErrorMessage message={errorMessage} />

      <AuthButton
        disabled={isSubmitting || !name.trim() || !email.trim()}
        label={isSubmitting ? 'Sending code…' : 'Create account'}
        onPress={handleSignUp}
        testID="signup-submit-button"
      />

      <Text style={styles.legalText}>
        By creating an account, you agree to our{' '}
        <Link href="https://usemomora.com/terms-of-service/" style={styles.legalLink}>
          Terms of Service
        </Link>{' '}
        and acknowledge our{' '}
        <Link href="https://usemomora.com/privacy-policy/" style={styles.legalLink}>
          Privacy Policy
        </Link>
        .
      </Text>
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
  legalText: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  legalLink: {
    color: colors.primary,
    fontWeight: '700',
  },
});
