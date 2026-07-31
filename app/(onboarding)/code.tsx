// S12B -- Account, code entry (docs/plans/onboarding-design-brief.md S12,
// docs/plans/onboarding-implementation.md WP2). Reuses the hidden-input +
// boxes technique from app/(auth)/verify-otp.tsx rather than reinventing
// auto-advance. On a successful verify: commitOnboarding turns the device-
// local draft into real rows, then routing branches on whether that was a
// genuinely new owner (continue into S13, the trust/paywall/portrait arc)
// or the "habit-tapped through onboarding again" returning owner (docs/
// features/onboarding.md decision 18) -- who is routed straight to their
// journal via resolvePostAuthDestination instead, with the captured memory
// already saved into their existing family.
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { colors, fonts, radius } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { familyMembershipsQueryKey, useFamily } from '@/hooks/use-family';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import {
  onboardingEmailRoute,
  onboardingJoinCodeRoute,
  onboardingJoinFoundRoute,
  onboardingStepRoute,
  onboardingTrialRoute,
} from '@/lib/onboarding-routes';
import { resolvePostAuthDestination } from '@/lib/onboarding-routing';
import { timelineRoute } from '@/lib/routes';
import { commitOnboarding } from '@/services/onboarding';
import { getPendingInviteCode } from '@/utils/pending-invite-code';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;

export default function OnboardingCodeScreen() {
  const params = useLocalSearchParams<{ email?: string }>();
  const email = (params.email ?? '').trim();

  const { verifyOtp, requestSignUpOtp } = useAuth();
  const { draft, clear } = useOnboardingFlow();
  const { enqueue } = usePendingMemoryUploads();
  const { refetchMemberships } = useFamily();
  const queryClient = useQueryClient();

  const [code, setCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLabel, setProcessingLabel] = useState('');
  const [isVerified, setIsVerified] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  // No email to verify (e.g. a stale/deep-linked entry) -- bounce back to
  // where a code can be requested.
  useEffect(() => {
    if (!email) {
      router.replace(onboardingEmailRoute);
    }
  }, [email]);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const finishAfterCommit = async () => {
    setProcessingLabel('Setting up your journal…');

    const { data, error } = await commitOnboarding(draft, { enqueueMediaUpload: enqueue });

    if (error || !data) {
      setIsProcessing(false);
      setErrorMessage(error?.message ?? 'Could not finish setting up your journal. Please try again.');
      return;
    }

    // commitOnboarding creates/resolves the family through direct service
    // calls, not a query-invalidating mutation -- FamilyProvider's cached
    // membership list (src/hooks/use-family.tsx) would otherwise still read
    // empty for a brand-new owner arriving at their own journal for the
    // first time. Invalidate on the base key (it's cached per-user-id) so
    // the very next read refetches, awaited here (not fire-and-forget)
    // because we're about to navigate into a layout that reads exactly this
    // state -- same pattern as app/(app)/sharing/waiting.tsx. Covers both
    // branches below: a new family and a resolved existing one both produce
    // a real `familyId` above.
    await queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey });

    if (data.isNewFamily) {
      // A genuinely new owner continues the trust/paywall/portrait arc --
      // the routing gate (decision 17) only diverts an owner who already
      // had a family (see the `else` branch below).
      await clear();
      router.replace(onboardingTrialRoute);
      return;
    }

    // Returning owner who already had a family (decision 18): the captured
    // memory just landed there instead of a second family being created --
    // route on real post-auth state, same as any other returning user.
    const freshMemberships = (await refetchMemberships()) ?? [];
    const hasPendingInviteCode = Boolean(await getPendingInviteCode());
    const destination = resolvePostAuthDestination({
      memberships: freshMemberships.map((membership) => ({ familyId: membership.familyId })),
      hasPendingInviteCode,
      draft,
      intent: 'owner',
    });

    await clear();

    switch (destination.kind) {
      case 'journal':
        router.replace(timelineRoute);
        break;
      case 'resume-onboarding':
        router.replace(onboardingStepRoute(destination.step));
        break;
      case 'finish-join':
        router.replace(onboardingJoinFoundRoute);
        break;
      case 'ask-invite-code':
        router.replace(onboardingJoinCodeRoute);
        break;
      default: {
        const exhaustive: never = destination;
        return exhaustive;
      }
    }
  };

  const handleVerify = async (candidate: string) => {
    if (candidate.length !== CODE_LENGTH || !email || isProcessing) {
      return;
    }

    setErrorMessage('');
    setIsProcessing(true);
    setProcessingLabel('Verifying…');

    const { error } = await verifyOtp({ email, token: candidate });

    if (error) {
      setIsProcessing(false);
      setErrorMessage(error.message);
      return;
    }

    setIsVerified(true);
    await finishAfterCommit();
  };

  const handleRetryCommit = async () => {
    if (isProcessing) {
      return;
    }
    setErrorMessage('');
    setIsProcessing(true);
    await finishAfterCommit();
  };

  const handleChangeCode = (text: string) => {
    const digitsOnly = text.replace(/[^0-9]/g, '').slice(0, CODE_LENGTH);
    setCode(digitsOnly);
    setErrorMessage('');

    if (digitsOnly.length === CODE_LENGTH) {
      void handleVerify(digitsOnly);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0 || !email) {
      return;
    }

    setErrorMessage('');
    setResendMessage('');
    setIsResending(true);

    const { error } = await requestSignUpOtp({ name: '', email });

    setIsResending(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setCode('');
    setResendMessage('New code sent.');
    setCooldown(RESEND_COOLDOWN_SECONDS);
  };

  const digits = Array.from({ length: CODE_LENGTH }, (_, index) => code[index] ?? '');

  return (
    <OnbShell>
      <View style={styles.body}>
        <OnbDisplay size={32}>Check your inbox.</OnbDisplay>
        <OnbBody muted size={15} style={styles.subhead}>
          We sent a 6-digit code to {email}.
        </OnbBody>

        <View style={styles.codeInputWrap}>
          <View pointerEvents="none" style={styles.codeRow}>
            {digits.map((digit, index) => (
              <View
                key={index}
                style={[
                  styles.codeBox,
                  digit ? styles.codeBoxFilled : null,
                  code.length === index && styles.codeBoxActive,
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
            editable={!isProcessing}
            keyboardType="number-pad"
            maxLength={CODE_LENGTH}
            onChangeText={handleChangeCode}
            selectionColor="transparent"
            style={styles.hiddenInput}
            testID="onboarding-code-input"
            textContentType="oneTimeCode"
            value={code}
          />
        </View>

        {errorMessage ? (
          <View style={styles.errorWrap}>
            <OnbBody size={13} style={styles.errorText} testID="onboarding-code-error">
              {errorMessage}
            </OnbBody>
            {isVerified ? (
              <Text onPress={() => void handleRetryCommit()} style={styles.retryLink} testID="onboarding-code-retry">
                Try again
              </Text>
            ) : null}
          </View>
        ) : null}

        {isProcessing ? (
          <OnbBody muted size={13} style={styles.processingLabel} testID="onboarding-code-processing">
            {processingLabel}
          </OnbBody>
        ) : null}

        {resendMessage ? <OnbBody size={14} style={styles.resendMessage}>{resendMessage}</OnbBody> : null}

        <Text
          onPress={() => void handleResend()}
          style={[styles.resendLink, (isResending || cooldown > 0) && styles.resendLinkDisabled]}
          testID="onboarding-code-resend"
        >
          {isResending ? 'Sending…' : cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
        </Text>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: 26,
    paddingTop: 32,
  },
  subhead: {
    marginBottom: 30,
    marginTop: 12,
  },
  codeInputWrap: {
    position: 'relative',
  },
  codeRow: {
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
  },
  codeBox: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1.5,
    height: 58,
    justifyContent: 'center',
    width: 46,
  },
  codeBoxFilled: {
    borderColor: colors.borderStrong,
  },
  codeBoxActive: {
    borderColor: colors.primary,
  },
  codeDigit: {
    color: colors.ink,
    fontFamily: fonts.displayMedium,
    fontSize: 27,
  },
  hiddenInput: {
    bottom: 0,
    color: 'transparent',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  errorWrap: {
    alignItems: 'center',
    gap: 8,
    marginTop: 18,
  },
  errorText: {
    color: colors.error,
    textAlign: 'center',
  },
  retryLink: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
  },
  processingLabel: {
    marginTop: 18,
    textAlign: 'center',
  },
  resendMessage: {
    marginTop: 18,
    textAlign: 'center',
  },
  resendLink: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
    marginTop: 22,
    textAlign: 'center',
  },
  resendLinkDisabled: {
    color: colors.ink3,
  },
});
