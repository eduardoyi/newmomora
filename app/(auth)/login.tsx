// Soft-editorial restyle (Claude Design handoff, src/screens/auth.jsx
// `LoginA`) adapted to Momora's real passwordless auth -- see
// `docs/plans/onboarding-design-brief.md` for copy rules (no em dashes) and
// `docs/reviewer-access.md` for why the password branch below must stay
// intact.
//
// This screen renders through `AuthScreen` (src/components/auth-screen.tsx)
// rather than duplicating its wordmark + headline + spacer-pinned-footer
// composition inline -- `AuthScreen` was rebuilt to match this exact layout
// so verify-otp/password/signup could share it (see that file's header),
// and there is exactly one implementation of the composition and of the
// keyboard-avoidance mechanism it's built on
// (`src/components/keyboard-sticky-shell.tsx`, extracted from
// `src/components/onboarding/onb-shell.tsx`; that file's header has the
// full keyboard-covers-the-CTA incident history). Previously this screen
// had its own `KeyboardAwareScrollView` with the footer *inside* the scroll
// view, which is exactly what let the "Sign in" button and "Create an
// account" link end up hidden under the open keyboard.
import { Link, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { AuthButton, AuthErrorMessage, AuthField, AuthInput, AuthScreen } from '@/components/auth-screen';
import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { onboardingStoryRoute } from '@/lib/onboarding-routes';
import { rootRoute } from '@/lib/routes';
import { isPasswordLoginEmail, normalizeEmail } from '@/services/reviewer-auth';
import { isE2eFixturesEnabled } from '@/utils/e2e-fixtures';

export default function LoginScreen() {
  const { requestSignInOtp, signInWithPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Dev/E2E only: password provider stays enabled server-side for Maestro, but the toggle
  // that exposes it never renders (and this branch is dead-code-eliminated) in production
  // builds -- same __DEV__ gating pattern as the family-member photo fixture.
  const showDevPasswordToggle = isE2eFixturesEnabled();
  const [isDevPasswordVisible, setIsDevPasswordVisible] = useState(false);
  const [devPassword, setDevPassword] = useState('');
  const [isDevSubmitting, setIsDevSubmitting] = useState(false);

  const handleContinue = async () => {
    setErrorMessage('');

    const normalizedEmail = normalizeEmail(email);

    if (isPasswordLoginEmail(normalizedEmail)) {
      router.push({
        pathname: '/(auth)/password',
        params: { email: normalizedEmail },
      });
      return;
    }

    setIsSubmitting(true);
    const { error, userNotFound } = await requestSignInOtp(normalizedEmail);

    setIsSubmitting(false);

    if (userNotFound) {
      router.push({ pathname: '/(auth)/signup', params: { email: normalizedEmail } });
      return;
    }

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    router.push({
      pathname: '/(auth)/verify-otp',
      params: { email: normalizedEmail, mode: 'signin' },
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

    router.replace(rootRoute);
  };

  return (
    <AuthScreen
      footer={
        <>
          <AuthButton
            disabled={isSubmitting || !email.trim()}
            label={isSubmitting ? 'Sending code…' : 'Sign in'}
            onPress={handleContinue}
            testID="login-submit-button"
          />

          <Text style={styles.footerText}>
            New here?{' '}
            <Link
              href={onboardingStoryRoute(0)}
              style={styles.link}
              testID="login-create-account-link"
            >
              Create an account
            </Link>
          </Text>
        </>
      }
      scrollTestID="login-screen-scroll"
      subtitle="Pick up where you left off. Your moments are waiting."
      title={'Welcome\nback.'}
      wordmarkTestID="login-wordmark"
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
    color: colors.ink2,
    fontSize: 14,
    textAlign: 'center',
  },
  link: {
    color: colors.primary,
    fontWeight: '700',
  },
});
