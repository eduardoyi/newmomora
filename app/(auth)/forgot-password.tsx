import { Link } from 'expo-router';
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

export default function ForgotPasswordScreen() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleReset = async () => {
    setErrorMessage('');
    setSuccessMessage('');
    setIsSubmitting(true);

    const { error } = await resetPassword(email);

    setIsSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setSuccessMessage('If an account exists for that email, reset instructions are on the way.');
  };

  return (
    <AuthScreen
      footer={
        <Text style={styles.footerText}>
          Remembered it?{' '}
          <Link href="/(auth)/login" style={styles.link}>
            Back to sign in
          </Link>
        </Text>
      }
      subtitle="We'll email you a link to reset your password."
      title="Reset password"
    >
      <AuthField label="Email">
        <AuthInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="you@example.com"
          testID="forgot-password-email-input"
          textContentType="emailAddress"
          value={email}
        />
      </AuthField>

      <AuthErrorMessage message={errorMessage} />

      {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}

      <AuthButton
        disabled={isSubmitting || !email.trim()}
        label={isSubmitting ? 'Sending…' : 'Send reset link'}
        onPress={handleReset}
        testID="forgot-password-submit-button"
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
  success: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
});
