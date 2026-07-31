// J4 -- Account (email OTP), joiner framing (docs/plans/onboarding-design-brief.md,
// WP4). Same underlying mechanic as S12 (owner path): email in, 6-digit
// code back, no passwords -- reuses the hidden-input + boxes technique from
// app/(auth)/verify-otp.tsx rather than reinventing it. This single route
// covers both the 'email' and 'code' states (the plan gives the join path
// one file here, unlike the owner path's separate S12A/S12B screens).
//
// Post-verify, this screen is also where the join actually completes: apply
// the J3 display name to the profile, then redeem the invite code
// (src/services/invites.ts) -- the real confirmation J2 could only guess
// at pre-auth. discardAnonymousSession() runs before requesting the OTP so
// the real sign-in starts clean (plan WP0 decision 3).
//
// A real (non-anonymous) session already existing on mount skips straight
// to that finish step. This covers two edge cases without extra UI: a
// relaunch right after a successful verify but before the redeem call
// resolved, and a user who bounced back here (or to J1) after a definitive
// redeem failure to retry with a different code while already signed in.
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { discardAnonymousSession } from '@/lib/anonymous-session';
import { onboardingJoinCodeRoute, onboardingJoinWaitingRoute } from '@/lib/onboarding-routes';
import { redeemFamilyInvite } from '@/services/invites';
import { clearJoinDraft, getJoinDraft } from '@/services/onboarding-join';
import { updateUserProfile } from '@/services/user-profile';
import { clearPendingInviteCode, getPendingInviteCode } from '@/utils/pending-invite-code';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Definitive failures spend the stored invite code -- same convention as
 * app/(app)/sharing/redeem.tsx. A rate limit or network hiccup keeps it so
 * a retry (via "Try again" below) can still succeed.
 */
const DEFINITIVE_FAILURE_CODES = new Set(['invalid_code', 'already_member']);

type Step = 'checking' | 'email' | 'code' | 'finishing' | 'error';

export default function JoinEmailScreen() {
  const { session, isLoading: isAuthLoading, requestSignUpOtp, verifyOtp } = useAuth();

  const [step, setStep] = useState<Step>('checking');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [canReenterCode, setCanReenterCode] = useState(false);
  const [isSubmittingEmail, setIsSubmittingEmail] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  // Guards the mount-time "already authenticated" effect from double-firing
  // finishJoin when handleVerify already started it -- verifyOtp's success
  // also flips `session` via the auth listener, which would otherwise
  // re-trigger the same effect a beat later. redeemFamilyInvite's atomic
  // claim only succeeds once, so a second concurrent call would read back
  // as a false "invalid code" for a join that actually already worked.
  const hasStartedFinishRef = useRef(false);

  const finishJoin = useCallback(async () => {
    setStep('finishing');
    setErrorMessage('');

    const code = await getPendingInviteCode();

    if (!code) {
      setCanReenterCode(true);
      setErrorMessage("We lost track of your invite code. Let's find it again.");
      setStep('error');
      return;
    }

    const draft = await getJoinDraft();

    if (draft.displayName) {
      // Best-effort: a failed name update shouldn't block the more
      // important step of actually joining the family.
      await updateUserProfile({ name: draft.displayName });
    }

    const { error } = await redeemFamilyInvite(code);

    if (error) {
      const isDefinitive = Boolean(error.code && DEFINITIVE_FAILURE_CODES.has(error.code));

      if (isDefinitive) {
        await clearPendingInviteCode();
      }

      setCanReenterCode(isDefinitive);
      setErrorMessage(error.message);
      setStep('error');
      return;
    }

    await clearPendingInviteCode();
    await clearJoinDraft();
    router.replace(onboardingJoinWaitingRoute);
  }, []);

  useEffect(() => {
    if (isAuthLoading || hasStartedFinishRef.current) {
      return;
    }

    if (session && !session.user.is_anonymous) {
      hasStartedFinishRef.current = true;
      void finishJoin();
      return;
    }

    setStep('email');
  }, [isAuthLoading, session, finishJoin]);

  useEffect(() => {
    if (step !== 'code' || cooldown <= 0) {
      return;
    }

    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [step, cooldown]);

  const handleSendCode = async () => {
    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      return;
    }

    setErrorMessage('');
    setIsSubmittingEmail(true);

    await discardAnonymousSession();

    const draft = await getJoinDraft();
    const { error } = await requestSignUpOtp({
      name: draft.displayName ?? '',
      email: trimmedEmail,
    });

    setIsSubmittingEmail(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setOtp('');
    setCooldown(RESEND_COOLDOWN_SECONDS);
    setStep('code');
  };

  const handleVerify = useCallback(
    async (candidate: string) => {
      if (candidate.length !== CODE_LENGTH) {
        return;
      }

      setErrorMessage('');
      setIsVerifying(true);

      const { error } = await verifyOtp({ email: email.trim(), token: candidate });

      setIsVerifying(false);

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      hasStartedFinishRef.current = true;
      void finishJoin();
    },
    [email, verifyOtp, finishJoin],
  );

  const handleChangeCode = (text: string) => {
    const digitsOnly = text.replace(/[^0-9]/g, '').slice(0, CODE_LENGTH);
    setOtp(digitsOnly);
    setErrorMessage('');

    if (digitsOnly.length === CODE_LENGTH) {
      void handleVerify(digitsOnly);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0) {
      return;
    }

    setErrorMessage('');
    setResendMessage('');
    setIsResending(true);

    const draft = await getJoinDraft();
    const { error } = await requestSignUpOtp({
      name: draft.displayName ?? '',
      email: email.trim(),
    });

    setIsResending(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setOtp('');
    setResendMessage('New code sent.');
    setCooldown(RESEND_COOLDOWN_SECONDS);
  };

  const handleReenterCode = () => {
    router.replace(onboardingJoinCodeRoute);
  };

  const handleRetryFinish = () => {
    void finishJoin();
  };

  if (step === 'checking' || step === 'finishing') {
    return (
      <OnbShell testID="onb-join-email-screen">
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} size="large" testID="onb-join-email-loading" />
        </View>
      </OnbShell>
    );
  }

  if (step === 'error') {
    return (
      <OnbShell
        footer={
          canReenterCode ? (
            <OnbButton
              label="Enter a different code"
              onPress={handleReenterCode}
              style={styles.fullWidthButton}
              testID="onb-join-email-reenter-code-button"
            />
          ) : (
            <OnbButton
              label="Try again"
              onPress={handleRetryFinish}
              style={styles.fullWidthButton}
              testID="onb-join-email-retry-button"
            />
          )
        }
        testID="onb-join-email-screen"
      >
        <View style={styles.centered}>
          <OnbDisplay size={28} style={styles.centerText}>
            Something didn&apos;t go through.
          </OnbDisplay>
          <Text style={styles.error}>{errorMessage}</Text>
        </View>
      </OnbShell>
    );
  }

  if (step === 'code') {
    const digits = Array.from({ length: CODE_LENGTH }, (_, index) => otp[index] ?? '');

    return (
      <OnbShell
        footer={
          <OnbButton
            disabled={isResending || cooldown > 0}
            label={
              isResending ? 'Sending…' : cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'
            }
            onPress={() => void handleResend()}
            testID="onb-join-email-resend-button"
            variant="ghost"
          />
        }
        testID="onb-join-email-screen"
      >
        <View style={styles.container}>
          <OnbDisplay size={33}>Check your inbox.</OnbDisplay>
          <OnbBody muted style={styles.body}>
            Enter the 6-digit code we sent to {email.trim()}.
          </OnbBody>

          <View style={styles.codeInputWrap}>
            <View pointerEvents="none" style={styles.codeRow}>
              {digits.map((digit, index) => (
                <View
                  key={index}
                  style={[
                    styles.codeBox,
                    digit ? styles.codeBoxFilled : null,
                    otp.length === index && styles.codeBoxActive,
                  ]}
                >
                  <Text style={styles.codeDigit}>{digit}</Text>
                </View>
              ))}
            </View>

            <TextInput
              accessibilityHint="Enter the six digits from your email."
              accessibilityLabel="Verification code"
              autoFocus
              caretHidden
              cursorColor="transparent"
              keyboardType="number-pad"
              maxLength={CODE_LENGTH}
              onChangeText={handleChangeCode}
              selectionColor="transparent"
              style={styles.hiddenInput}
              testID="onb-join-email-code-input"
              textContentType="oneTimeCode"
              value={otp}
            />
          </View>

          {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
          {resendMessage ? <Text style={styles.resendMessage}>{resendMessage}</Text> : null}
          {isVerifying ? <Text style={styles.hint}>Verifying…</Text> : null}
        </View>
      </OnbShell>
    );
  }

  return (
    <OnbShell
      footer={
        <OnbButton
          disabled={isSubmittingEmail || !email.trim()}
          label={isSubmittingEmail ? 'Sending…' : 'Send my code'}
          onPress={() => void handleSendCode()}
          style={styles.fullWidthButton}
          testID="onb-join-email-send-button"
        />
      }
      testID="onb-join-email-screen"
    >
      <View style={styles.container}>
        <OnbDisplay size={33}>Last step, promise.</OnbDisplay>
        <OnbBody muted style={styles.body}>
          Email in, code back. No passwords, ever.
        </OnbBody>

        <TextInput
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          autoFocus
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="you@email.com"
          placeholderTextColor={colors.ink3}
          style={styles.emailInput}
          testID="onb-join-email-input"
          textContentType="emailAddress"
          value={email}
        />

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 26,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  centerText: {
    textAlign: 'center',
    marginTop: 12,
  },
  body: {
    marginTop: 12,
  },
  emailInput: {
    marginTop: spacing.lg,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 16,
    fontFamily: fonts.sans,
    fontSize: 17,
    color: colors.ink,
  },
  codeInputWrap: {
    marginTop: spacing.lg,
    position: 'relative',
  },
  codeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  codeBox: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    height: 52,
    justifyContent: 'center',
    width: 44,
  },
  codeBoxFilled: {
    borderColor: colors.borderStrong,
  },
  codeBoxActive: {
    borderColor: colors.primary,
  },
  codeDigit: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 22,
  },
  hiddenInput: {
    bottom: 0,
    color: 'transparent',
    left: 0,
    opacity: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  hint: {
    marginTop: 12,
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 13,
    textAlign: 'center',
  },
  resendMessage: {
    marginTop: 12,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    textAlign: 'center',
  },
  error: {
    marginTop: 12,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.error,
    textAlign: 'center',
  },
  fullWidthButton: {
    width: '100%',
  },
});
