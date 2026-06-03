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

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignUp = async () => {
    setErrorMessage('');
    setSuccessMessage('');
    setIsSubmitting(true);

    const { error, needsEmailConfirmation } = await signUp({
      name: name.trim(),
      email: email.trim(),
      password,
    });

    setIsSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    if (needsEmailConfirmation) {
      setSuccessMessage(
        'Account created. Open the confirmation link in your email on this device — it will return you to Momora.',
      );
      return;
    }

    router.replace('/(app)/(tabs)/timeline');
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

      <AuthField label="Password">
        <AuthInput
          autoComplete="new-password"
          onChangeText={setPassword}
          placeholder="At least 8 characters"
          secureTextEntry
          testID="signup-password-input"
          textContentType="newPassword"
          value={password}
        />
      </AuthField>

      <AuthErrorMessage message={errorMessage} />

      {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}

      <AuthButton
        disabled={isSubmitting || !name.trim() || !email.trim() || password.length < 8}
        label={isSubmitting ? 'Creating account…' : 'Create account'}
        onPress={handleSignUp}
        testID="signup-submit-button"
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
