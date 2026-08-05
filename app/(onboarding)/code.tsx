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
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';

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
  onboardingPaywallRouteForMode,
  onboardingPortraitRoute,
  onboardingStepRoute,
  onboardingTrialRoute,
} from '@/lib/onboarding-routes';
import { resolveOwnerPaywallMode, resolvePostAuthDestination } from '@/lib/onboarding-routing';
import { timelineRoute } from '@/lib/routes';
import {
  fetchFamilyBillingStatus,
  hasComplimentaryFamilyAccess,
  startPendingOnboardingIllustration,
} from '@/services/billing';
import type { PostMediaMemoryInput } from '@/services/memory-posting';
import { trackEvent } from '@/services/analytics';
import { commitOnboarding } from '@/services/onboarding';
import { getPendingInviteCode } from '@/utils/pending-invite-code';
import { focusOtpInput } from '@/utils/otp-input';
import { patchOnboardingDraft } from '@/utils/onboarding-progress';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;

const ENQUEUE_MEDIA_UPLOAD_ATTEMPTS = 5;
const ENQUEUE_MEDIA_UPLOAD_RETRY_DELAY_MS = 50;

/**
 * Hands a captured photo/video off to usePendingMemoryUploads().enqueue(),
 * tolerating the brief window where its own user/family guard hasn't
 * caught up to the membership invalidation the caller just awaited.
 * TanStack Query's notifyManager can take more than one setTimeout(0)
 * macrotask hop to turn that invalidation into a re-render (batched
 * notifications can reschedule themselves once more before actually
 * firing -- see @tanstack/query-core's notifyManager), so a single yield
 * is not reliably enough: running this screen's real-hooks regression test
 * concurrently with sibling suites (parallel jest workers, matching real
 * device contention better than a solo run) reproduced "You must have a
 * family to save a memory" for a fresh, correctly-authenticated returning
 * owner roughly 1 run in 5 with a single yield. A short, bounded retry
 * survives that without gambling on a fixed tick count, and without
 * reaching into usePendingMemoryUploads()'s internals (out of this file's
 * scope) -- see src/services/onboarding.ts's
 * CommitOnboardingResult.pendingMediaUpload doc comment for why this can't
 * just run immediately inside commitOnboarding instead.
 */
async function enqueuePendingMediaUpload(
  pendingMediaUpload: PostMediaMemoryInput,
  enqueueRef: { current: (input: PostMediaMemoryInput) => boolean },
): Promise<boolean> {
  let lastError: unknown;

  for (let attempt = 0; attempt < ENQUEUE_MEDIA_UPLOAD_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, ENQUEUE_MEDIA_UPLOAD_RETRY_DELAY_MS));
    }

    try {
      const accepted = enqueueRef.current(pendingMediaUpload);
      if (accepted === false) {
        throw new Error('upload_queue_rejected');
      }
      return true;
    } catch (error) {
      lastError = error;
    }
  }

  console.warn(
    'Failed to enqueue onboarding photo upload',
    lastError instanceof Error ? lastError.message : 'unknown',
  );
  return false;
}

export default function OnboardingCodeScreen() {
  const params = useLocalSearchParams<{ email?: string }>();
  const email = (params.email ?? '').trim();

  const { verifyOtp, requestSignUpOtp } = useAuth();
  const { draft, clear, patch } = useOnboardingFlow();
  const { enqueue } = usePendingMemoryUploads();
  const { refetchMemberships } = useFamily();
  const queryClient = useQueryClient();
  const codeInputRef = useRef<TextInput>(null);

  // finishAfterCommit's async chain starts on the render right before the
  // code is submitted -- necessarily pre-auth, since submitting is what
  // triggers verifyOtp. A plain destructured `enqueue` would stay bound to
  // that pre-auth snapshot (user: null) for the rest of THIS call no matter
  // how many renders happen afterward while awaiting verifyOtp/
  // commitOnboarding -- that stale closure is what threw "You must be
  // signed in to save a memory" for an already-verified returning owner
  // (docs/features/onboarding.md decision 18). Keeping the latest `enqueue`
  // in a ref (updated every render) and reading `.current` at call time
  // fixes that; see src/services/onboarding.ts's
  // CommitOnboardingResult.pendingMediaUpload doc comment for the other
  // half of this fix (also waiting for the membership invalidation below
  // before calling it, so its own user/family guard sees a family React
  // actually knows about).
  const enqueueRef = useRef(enqueue);
  useEffect(() => {
    enqueueRef.current = enqueue;
  }, [enqueue]);

  const [code, setCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLabel, setProcessingLabel] = useState('');
  const [isVerified, setIsVerified] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    patch({ step: 'code' });
  }, [patch]);

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

    const { data, error, existingFamilyId } = await commitOnboarding(draft);

    if (error || !data) {
      if (existingFamilyId) {
        // The family is real, but this may be either an owner who has never
        // subscribed (the first-time trial) or a genuinely lapsed owner. Ask
        // the same server-owned status RPC used by the front door instead of
        // guessing from the fact that the write failed. Keep the draft so the
        // paywall can commit the capture after a successful purchase.
        const billing = await fetchFamilyBillingStatus(existingFamilyId);
        if (billing.data && !billing.error && !billing.data.has_write_access) {
          // The billing RPC is callable by every family member, but the
          // paywall is an owner-only destination. Refresh membership state
          // before routing so a manager/viewer who accidentally entered the
          // owner onboarding fork lands in the journal instead of being asked
          // to buy the owner's subscription.
          await queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey });
          const freshMemberships = (await refetchMemberships()) ?? [];
          const membership = freshMemberships.find((item) => item.familyId === existingFamilyId);
          if (membership && membership.role !== 'owner') {
            await clear();
            setIsProcessing(false);
            router.replace(timelineRoute);
            return;
          }

          const mode = resolveOwnerPaywallMode({
            hasEverHadAccess: billing.data.has_ever_had_access,
            trialEligible: billing.data.trial_eligible,
          });
          await patchOnboardingDraft({
            committedFamilyId: existingFamilyId,
            captureCommitted: false,
            step: 'paywall',
            paywallMode: mode,
          });
          patch({ committedFamilyId: existingFamilyId, captureCommitted: false, step: 'paywall', paywallMode: mode });
          setIsProcessing(false);
          router.replace(onboardingPaywallRouteForMode(mode));
          return;
        }
      }

      setIsProcessing(false);
      setErrorMessage(error?.message ?? 'Could not finish setting up your journal. Please try again.');
      return;
    }

    // onboarding_committed (docs/plans/analytics-implementation.md WP2.3) --
    // fired here (the primary commit site) and again from paywall.tsx's own
    // pending-capture commit for owners whose code.tsx commit deferred.
    // `is_new_family` lets the funnel filter out returning owners who
    // re-enter onboarding (decision 18) and commit too.
    trackEvent('onboarding_committed', { kid_count: draft.kidNames.length, is_new_family: data.isNewFamily });

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

    // Only now -- after FamilyProvider's membership cache is guaranteed to
    // know about `data.familyId` -- is it safe to hand a media capture to
    // usePendingMemoryUploads().enqueue(): its own user/family guard reads
    // that same React state, which (for a brand-new family especially) has
    // no way to know about it any earlier. See
    // src/services/onboarding.ts's CommitOnboardingResult.pendingMediaUpload
    // doc comment.
    if (data.pendingMediaUpload) {
      const wasAccepted = await enqueuePendingMediaUpload(data.pendingMediaUpload, enqueueRef);
      if (!wasAccepted) {
        // The placeholder row and text are already durable, but the local
        // attachment has not been handed to the upload queue. Preserve the
        // draft and the capture marker so the verified user can retry instead
        // of silently losing the only local copy of the attachment.
        await patchOnboardingDraft({
          committedFamilyId: data.familyId,
          captureCommitted: false,
          pendingMediaMemoryId: data.pendingMediaUpload.memoryId,
        });
        patch({
          committedFamilyId: data.familyId,
          captureCommitted: false,
          pendingMediaMemoryId: data.pendingMediaUpload.memoryId,
        });
        setIsProcessing(false);
        setErrorMessage('Your capture is safe, but the photo could not be attached yet. Tap Try again.');
        return;
      }

      // `captureCommitted` is the durable hand-off marker. Do not let a
      // debounced provider write race navigation: persist it only after the
      // media queue has accepted the attachment. The memory id is stable so
      // a retry after a crash can repair/complete the same pending post.
      await patchOnboardingDraft({
        committedFamilyId: data.familyId,
        captureCommitted: true,
        pendingMediaMemoryId: undefined,
      });
      patch({ committedFamilyId: data.familyId, captureCommitted: true, pendingMediaMemoryId: undefined });
    }

    if (data.isNewFamily) {
      // A genuinely new owner continues the trust/paywall/portrait arc --
      // the routing gate (decision 17) only diverts an owner who already
      // had a family (see the `else` branch below).
      // Owner-wide complimentary grants are the one deliberate exception:
      // they skip the purchase screens, but still start the normal portrait
      // handoff and first-illustration pipeline.
      const hasComplimentaryAccess = await hasComplimentaryFamilyAccess(data.familyId);
      if (hasComplimentaryAccess && data.memoryId && !data.pendingMediaUpload) {
        await startPendingOnboardingIllustration(data.familyId, data.memoryId).catch(() => undefined);
      }
      await clear();
      router.replace(hasComplimentaryAccess ? onboardingPortraitRoute : onboardingTrialRoute);
      return;
    }

    // Returning owner who already had a family (decision 18): the captured
    // memory just landed there instead of a second family being created --
    // route on real post-auth state, same as any other returning user.
    const freshMemberships = (await refetchMemberships()) ?? [];
    const resolvedMembership = freshMemberships.find((membership) => membership.familyId === data.familyId);
    if (resolvedMembership && resolvedMembership.role !== 'owner') {
      await clear();
      router.replace(timelineRoute);
      return;
    }
    const billing = await fetchFamilyBillingStatus(data.familyId);
    const hasPendingInviteCode = Boolean(await getPendingInviteCode());
    const destination = resolvePostAuthDestination({
      memberships: freshMemberships.map((membership) => ({ familyId: membership.familyId })),
      hasPendingInviteCode,
      draft,
      billing:
        billing.data && !billing.error && resolvedMembership
          ? {
              familyId: billing.data.family_id,
              isOwner: resolvedMembership.role === 'owner',
              hasWriteAccess: billing.data.has_write_access,
              hasEverHadAccess: billing.data.has_ever_had_access,
              trialEligible: billing.data.trial_eligible,
            }
          : null,
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
      case 'resume-paywall':
        router.replace(onboardingPaywallRouteForMode(destination.mode));
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

  const handleCodeInputPress = () => {
    if (!isProcessing) {
      focusOtpInput(codeInputRef.current, KeyboardController.isVisible());
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
          <Pressable
            accessibilityHint="Enter the six digits from your email."
            accessibilityLabel="Verification code"
            disabled={isProcessing}
            onPress={handleCodeInputPress}
            style={styles.codeRow}
            testID="onboarding-code-input-target"
          >
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
          </Pressable>

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
            pointerEvents="none"
            ref={codeInputRef}
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
    opacity: 0,
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
