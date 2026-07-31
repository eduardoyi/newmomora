// Soft-editorial restyle (Claude Design handoff, src/screens/auth.jsx
// `LoginA`) adapted to Momora's real passwordless auth -- see
// `docs/plans/onboarding-design-brief.md` for copy rules (no em dashes) and
// `docs/reviewer-access.md` for why the password branch below must stay
// intact. This screen owns its own keyboard-aware container instead of
// `AuthScreen` (src/components/auth-screen.tsx, left unmodified -- signup,
// verify-otp and password still render through it) so the layout can match
// the mockup's tall, spacer-pinned composition; the bottomOffset math is
// copied from that file's KEYBOARD_BOTTOM_OFFSET rationale.
import { Link, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AuthButton, AuthErrorMessage, AuthField, AuthInput } from '@/components/auth-screen';
import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { Wordmark } from '@/components/wordmark';
import { colors, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { onboardingStoryRoute } from '@/lib/onboarding-routes';
import { isPasswordLoginEmail, normalizeEmail } from '@/services/reviewer-auth';
import { isE2eFixturesEnabled } from '@/utils/e2e-fixtures';

// The "Sign in" CTA sits directly under the last field once the flex spacer
// below collapses (keyboard open, short content) -- same clearance auth-
// screen.tsx reserves for its own directly-under-the-field submit button.
const KEYBOARD_BOTTOM_OFFSET = spacing.xxl * 2;

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

    router.replace('/(app)/(tabs)/timeline');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAwareScrollView
        bottomOffset={KEYBOARD_BOTTOM_OFFSET}
        contentContainerStyle={styles.content}
        disableScrollOnKeyboardHide
        keyboardShouldPersistTaps="handled"
        mode="insets"
        testID="login-screen-scroll"
      >
        <Wordmark size={26} testID="login-wordmark" />

        <View style={styles.headlineBlock}>
          <OnbDisplay size={44}>{'Welcome\nback.'}</OnbDisplay>
          <OnbBody muted size={15}>
            Pick up where you left off. Your moments are waiting.
          </OnbBody>
        </View>

        <View style={styles.form}>
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
        </View>

        <View style={styles.spacer} />

        <View style={styles.bottomBlock}>
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
        </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingBottom: 32,
    paddingHorizontal: 28,
    paddingTop: 88,
  },
  headlineBlock: {
    gap: 8,
    marginTop: 48,
  },
  form: {
    gap: spacing.md,
    marginTop: 36,
  },
  spacer: {
    flex: 1,
  },
  bottomBlock: {
    gap: 12,
    paddingBottom: 8,
  },
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
