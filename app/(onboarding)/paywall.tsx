// S15 -- RevenueCat paywall (docs/PRICING_STRATEGY.md and the subscription
// rollout plan).  Store prices come from the active RevenueCat offering; the
// annual package is selected by default and is the only package with the
// seven-day introductory trial.
import { Image } from 'expo-image';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { Check, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbBody, OnbDisplay, OnbTitle } from '@/components/onboarding/onb-typography';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, emotionColors, fonts, radius } from '@/constants/theme';
import { paywallBackdropMemories, type OnboardingSampleMemory } from '@/constants/onboarding-memories';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import { onboardingPortraitRoute, onboardingWelcomeRoute } from '@/lib/onboarding-routes';
import { resolveOwnerPaywallMode } from '@/lib/onboarding-routing';
import { timelineRoute } from '@/lib/routes';
import { MOMORA_ENTITLEMENT_ID, WrongAccountRestoreError } from '@/constants/billing';
import { commitOnboarding } from '@/services/onboarding';
import { patchOnboardingDraft } from '@/utils/onboarding-progress';

const NEW_OWNER_TRIAL_TRUST_BULLETS = [
  '$0.00 today',
  'Reminder before your trial ends',
  'Cancelling takes about 10 seconds',
  'Your memories export free, forever',
];

const NEW_OWNER_IMMEDIATE_TRUST_BULLETS = [
  'Your subscription starts immediately',
  'Cancelling takes about 10 seconds',
  'Your memories export free, forever',
];

const RETURNING_OWNER_TRUST_BULLETS = [
  'Your existing archive stays yours',
  'Capture and illustrations resume immediately',
  'Cancelling takes about 10 seconds',
  'Your memories export free, forever',
];

interface BackdropLayout {
  rotateDeg: number;
  offsetX: number;
  zIndex: number;
}

// Real memory pages (src/constants/onboarding-memories.ts's
// paywallBackdropMemories -- the same three yearMemories entries the design
// brief calls out for this backdrop) fill the same three fanned positions
// the old generic "paywall-page-1/3/4" illustration slots used to occupy.
const BACKDROP_LAYOUTS: readonly BackdropLayout[] = [
  { rotateDeg: -6, offsetX: -104, zIndex: 1 },
  { rotateDeg: 2, offsetX: 0, zIndex: 2 },
  { rotateDeg: 7, offsetX: 104, zIndex: 1 },
];

const PAGE_WIDTH = 132;
const PAGE_HEIGHT = 168;

export default function PaywallScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const requestedPaywallMode = mode === 'resubscribe' ? 'resubscribe' : 'new-owner';
  const [isCloseSheetVisible, setIsCloseSheetVisible] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<'annual' | 'monthly'>('annual');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [isRetryingOptions, setIsRetryingOptions] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Draft-first, real-server-data-once-cleared -- shared with included.tsx
  // (see src/hooks/use-onboarding-kid-possessive.ts for why this moved out
  // of a per-screen local resolver: S12B's code.tsx clears the draft before
  // routing into this screen, the same bug WP6 already fixed on S16).
  const resolvedPossessive = useOnboardingKidPossessive();
  const { draft, clear, patch } = useOnboardingFlow();
  const { enqueue } = usePendingMemoryUploads();
  const { user, signOut } = useAuth();
  const billingUserId = user?.id;
  const { familyId, role } = useFamily();
  const {
    offerings,
    status,
    isConfigured,
    isLoading: isBillingLoading,
    billingStatusError,
    offeringsError,
    purchase,
    restore,
    refresh,
    startOnboardingIllustration,
  } = useBilling();
  const [isCheckingAccess, setIsCheckingAccess] = useState(true);
  const [hasStartedAccessHandoff, setHasStartedAccessHandoff] = useState(false);
  const accessHandoffStartedRef = useRef(false);

  // A family membership already exists by the time a new owner reaches S15,
  // so membership alone cannot tell a normal returning launch from an
  // unfinished paywall. Persist the step immediately, but only persist the
  // paywall variant once the server has confirmed the owner billing state.
  // The URL/draft mode is a resume hint while that check is in flight, never
  // the authority for whether the introductory trial is allowed.
  useEffect(() => {
    patch({ step: 'paywall' });
    if (billingUserId) {
      void patchOnboardingDraft({ ownerUserId: billingUserId, step: 'paywall' });
    }
  }, [billingUserId, patch]);

  useEffect(() => {
    if (!familyId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- this screen can lose its family while auth/billing providers settle
      setIsCheckingAccess(false);
      return;
    }

    let cancelled = false;
    setIsCheckingAccess(true);
    void refresh()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsCheckingAccess(false);
      });
    return () => {
      cancelled = true;
    };
  }, [familyId, refresh]);

  const isBillingStatusReady = Boolean(
    familyId &&
      billingUserId &&
      role === 'owner' &&
      status &&
      !billingStatusError &&
      status.family_id === familyId &&
      status.owner_user_id === billingUserId,
  );
  const isConfirmedNonOwner = Boolean(
    !isCheckingAccess &&
      familyId &&
      billingUserId &&
      role &&
      status &&
      !billingStatusError &&
      status.family_id === familyId &&
      (role !== 'owner' || status.owner_user_id !== billingUserId),
  );
  const isBillingStatusLoading = isCheckingAccess || (!status && isBillingLoading);
  const serverPaywallMode =
    isBillingStatusReady && !isBillingStatusLoading && status && !status.has_write_access
      ? resolveOwnerPaywallMode({
          hasEverHadAccess: status.has_ever_had_access,
          trialEligible: status.trial_eligible,
        })
      : null;
  const isResubscribe = (serverPaywallMode ?? requestedPaywallMode) === 'resubscribe';
  const hasAuthoritativeBillingStatus = isBillingStatusReady && !isBillingStatusLoading;
  const hasConfirmedAccess = hasAuthoritativeBillingStatus && status?.has_write_access === true;
  const isAccessHandoff = hasConfirmedAccess || hasStartedAccessHandoff;
  const isPaywallStatusUnavailable =
    !isBillingStatusLoading && !isBillingStatusReady && !isConfirmedNonOwner && !isAccessHandoff;
  const canPurchase = hasAuthoritativeBillingStatus && !isAccessHandoff;
  const shouldRenderSubscriptionOptions = Boolean(
    offerings && hasAuthoritativeBillingStatus && !isPaywallStatusUnavailable && !isConfirmedNonOwner,
  );
  const isPaywallBusy = isSubmitting || isBillingStatusLoading || isAccessHandoff || isLeaving;

  // Correct a stale URL or device-local mode as soon as server billing is
  // available. This is what makes direct login, onboarding re-entry, and a
  // cold-launch resume converge on the same trial/resubscribe copy.
  useEffect(() => {
    if (!serverPaywallMode || !billingUserId) {
      return;
    }
    patch({ step: 'paywall', paywallMode: serverPaywallMode });
    void patchOnboardingDraft({
      ownerUserId: billingUserId,
      step: 'paywall',
      paywallMode: serverPaywallMode,
    });
  }, [billingUserId, patch, serverPaywallMode]);

  useEffect(() => {
    if (!isConfirmedNonOwner) {
      return;
    }
    void clear().then(() => router.replace(timelineRoute));
  }, [clear, isConfirmedNonOwner]);

  const hasAnnualTrial =
    hasAuthoritativeBillingStatus && !isResubscribe && offerings?.annualTrialEligibility === 'eligible';
  const showAnnualTrial = hasAnnualTrial && selectedPlan === 'annual';

  const selectedPackage = useMemo(
    () => (selectedPlan === 'annual' ? offerings?.annual : offerings?.monthly) ?? null,
    [offerings, selectedPlan],
  );

  const annualPrice = offerings?.annual.product.priceString ?? 'Annual plan';
  const monthlyPrice = offerings?.monthly?.product.priceString ?? 'Monthly plan';
  const annualMonthlyEquivalent = offerings?.annual.product.pricePerMonthString;

  const finishPaidOnboarding = useCallback(async () => {
    // A user can have a real family before paying: the account may have
    // reached S15, been closed, and later restarted onboarding. In that case
    // the first capture is still in the local draft and must be committed
    // after the purchase for both paywall variants. Previously this branch
    // only ran for resubscribe, so a first-time owner could pay successfully
    // while their capture remained stranded locally.
    const hasPendingCapture = Boolean(draft.committedFamilyId && draft.capture && draft.captureCommitted !== true);
    if (hasPendingCapture) {
      const committed = await commitOnboarding(draft);
      if (committed.error || !committed.data) {
        throw new Error(committed.error?.message ?? 'Your capture could not be saved yet. Please try again.');
      }
      if (committed.data.pendingMediaUpload) {
        const accepted = enqueue(committed.data.pendingMediaUpload);
        if (accepted === false) {
          await patchOnboardingDraft({
            committedFamilyId: committed.data.familyId,
            captureCommitted: false,
            pendingMediaMemoryId: committed.data.pendingMediaUpload.memoryId,
          });
          patch({
            committedFamilyId: committed.data.familyId,
            captureCommitted: false,
            pendingMediaMemoryId: committed.data.pendingMediaUpload.memoryId,
          });
          throw new Error('Your capture is safe, but the photo could not be attached yet. Please try again.');
        }
        // The queue has accepted the local attachment. Persist that durable
        // hand-off before clearing the draft/navigation; a debounced patch is
        // not sufficient across an app kill at this exact boundary.
        await patchOnboardingDraft({
          committedFamilyId: committed.data.familyId,
          captureCommitted: true,
          pendingMediaMemoryId: undefined,
        });
        patch({ committedFamilyId: committed.data.familyId, captureCommitted: true, pendingMediaMemoryId: undefined });
      }
      if (committed.data.memoryId && !committed.data.pendingMediaUpload) {
        await startOnboardingIllustration(committed.data.memoryId).catch(() => undefined);
      }
      await clear();
      router.replace(isResubscribe ? timelineRoute : onboardingPortraitRoute);
      return;
    }

    if (isResubscribe) {
      await clear();
      router.replace(timelineRoute);
      return;
    }

    if (!familyId) {
      await clear();
      router.replace(timelineRoute);
      return;
    }
    // Store purchase is already complete at this point.  Illustration
    // dispatch is a background hand-off and must not turn a successful paid
    // subscription into a false purchase failure if the app loses its
    // connection between the store callback and the Edge Function.
    await startOnboardingIllustration().catch(() => undefined);
    await clear();
    router.replace(onboardingPortraitRoute);
  }, [clear, draft, enqueue, familyId, isResubscribe, patch, startOnboardingIllustration]);

  useEffect(() => {
    if (
      !hasConfirmedAccess ||
      hasStartedAccessHandoff ||
      accessHandoffStartedRef.current ||
      isSubmitting
    ) return;

    accessHandoffStartedRef.current = true;
    setHasStartedAccessHandoff(true);
    void finishPaidOnboarding().catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : 'Could not finish setting up your Momora Plus access.');
    });
  }, [finishPaidOnboarding, hasConfirmedAccess, hasStartedAccessHandoff, isSubmitting]);

  const handleStartTrial = async () => {
    if (!selectedPackage || !user || !canPurchase || isSubmitting) return;
    setErrorMessage('');
    setIsSubmitting(true);
    try {
      const customerInfo = await purchase(selectedPackage);
      if (!customerInfo.entitlements.active[MOMORA_ENTITLEMENT_ID]) {
        throw new Error('Your purchase is still being confirmed. Please try again in a moment.');
      }
      await finishPaidOnboarding();
    } catch (error) {
      if (error instanceof WrongAccountRestoreError) {
        setErrorMessage(error.message);
      } else if (error instanceof Error && 'code' in error && error.code === 'billing_confirmation_pending') {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Could not start your subscription. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRestore = async () => {
    if (!user || !canPurchase || isSubmitting) return;
    setErrorMessage('');
    setIsSubmitting(true);
    try {
      const customerInfo = await restore();
      if (!customerInfo.entitlements.active[MOMORA_ENTITLEMENT_ID]) {
        setErrorMessage('No active Momora subscription was found for this account.');
        return;
      }
      await finishPaidOnboarding();
    } catch (error) {
      if (error instanceof WrongAccountRestoreError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Could not restore your subscription. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCloseSheet = () => {
    if (isPaywallBusy) return;
    setIsCloseSheetVisible(true);
  };

  const dismissCloseSheet = () => setIsCloseSheetVisible(false);
  const leavePaywall = async () => {
    if (isPaywallBusy) return;
    setIsLeaving(true);
    setIsCloseSheetVisible(false);
    try {
      await signOut();
      // Keep the paywall marker in device storage so signing back in can
      // resume the purchase step. Never expose the unpaid owner to the
      // journal as a side effect of leaving this screen.
      router.replace(onboardingWelcomeRoute);
    } catch {
      setIsLeaving(false);
      setErrorMessage('Could not log you out. Please try again.');
    }
  };

  const retryOptions = async () => {
    if (isRetryingOptions || isPaywallBusy) return;
    setIsRetryingOptions(true);
    setErrorMessage('');
    try {
      await refresh();
    } catch {
      setErrorMessage('Subscription options are temporarily unavailable. Please try again.');
    } finally {
      setIsRetryingOptions(false);
    }
  };

  return (
    <>
      <OnbShell
        contentContainerStyle={styles.scrollContent}
        footer={
          <View>
            {isAccessHandoff ? (
              <OnbBody muted size={13} style={styles.billingMessage} testID="onb-paywall-access-confirmed">
                {errorMessage ||
                  (status?.access_reason === 'complimentary'
                    ? 'Complimentary Momora Plus access confirmed. Setting up your journal…'
                    : 'Momora Plus access confirmed. Setting up your journal…')}
              </OnbBody>
            ) : (
              <>
                <OnbButton
                  label={isSubmitting ? 'Confirming subscription…' : isResubscribe ? 'Continue with Momora Plus' : showAnnualTrial ? 'Start my free week' : 'Start my subscription'}
                  onPress={handleStartTrial}
                  disabled={!selectedPackage || !canPurchase || isPaywallBusy}
                  style={styles.fullWidthButton}
                  testID="onb-paywall-cta-button"
                />
                <Text style={styles.legalDisclosure} testID="onb-paywall-renewal-disclosure">
                  {showAnnualTrial
                    ? `After your free week, ${annualPrice} will be charged to your store account unless you cancel at least 24 hours before the trial ends.`
                    : `Payment is charged to your store account at confirmation. Your subscription renews automatically unless you cancel at least 24 hours before the current period ends.`}
                </Text>
              </>
            )}
            <View style={styles.legalRow}>
              <Pressable
                accessibilityRole="button"
                disabled={isPaywallBusy}
                onPress={() => void handleRestore()}
                testID="onb-paywall-restore-button"
              >
                <Text style={styles.legalText}>Restore purchases</Text>
              </Pressable>
              <Link href="https://usemomora.com/terms-of-service/" style={styles.legalText} testID="onb-paywall-terms-link">
                Terms
              </Link>
              <Link href="https://usemomora.com/privacy-policy/" style={styles.legalText} testID="onb-paywall-privacy-link">
                Privacy
              </Link>
            </View>
          </View>
        }
        testID="onb-paywall-screen"
      >
        <View style={styles.root}>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            disabled={isPaywallBusy}
            hitSlop={10}
            onPress={openCloseSheet}
            style={styles.closeButton}
            testID="onb-paywall-close-button"
          >
            <X color={colors.ink3} size={15} strokeWidth={2} />
          </Pressable>

          <View style={styles.backdrop}>
            {paywallBackdropMemories.map((memory: OnboardingSampleMemory, index) => {
              const layout = BACKDROP_LAYOUTS[index];
              return (
                <View
                  key={memory.key}
                  style={[
                    styles.backdropPage,
                    {
                      marginLeft: layout.offsetX - PAGE_WIDTH / 2,
                      transform: [{ rotate: `${layout.rotateDeg}deg` }],
                      zIndex: layout.zIndex,
                    },
                  ]}
                >
                  <Image
                    accessibilityLabel={memory.text}
                    contentFit="cover"
                    source={memory.asset}
                    style={styles.backdropPageImage}
                    testID={`onb-paywall-page-${memory.key}`}
                  />
                </View>
              );
            })}
          </View>

          <OnbDisplay size={27} style={styles.headline}>
            {isResubscribe
              ? `Keep ${resolvedPossessive} story growing.`
              : `Turn ${resolvedPossessive} little moments into something you'll hold forever.`}
          </OnbDisplay>

          {shouldRenderSubscriptionOptions ? <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: selectedPlan === 'annual' }}
            onPress={() => setSelectedPlan('annual')}
            style={[styles.planCard, selectedPlan === 'annual' && styles.planCardSelected]}
            testID="onb-paywall-annual-plan"
          >
            <View style={styles.planCardText}>
              <OnbTitle size={17}>
                {hasAnnualTrial ? 'Try it FREE for 7 days' : `Momora Plus · ${annualPrice}/year`}
              </OnbTitle>
              <OnbBody muted size={13} style={styles.planCardSubtext}>
                {hasAnnualTrial
                  ? `Then ${annualPrice}/year (just ${annualMonthlyEquivalent ?? 'the annual rate'}/month)`
                  : annualMonthlyEquivalent
                    ? `${annualMonthlyEquivalent}/month equivalent`
                    : 'Annual subscription'}
              </OnbBody>
            </View>
            <View style={styles.planCardCheck}>
              {selectedPlan === 'annual' ? <Check color={colors.white} size={13} strokeWidth={3} /> : null}
            </View>
          </Pressable> : null}

          {shouldRenderSubscriptionOptions && offerings?.monthly ? (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: selectedPlan === 'monthly' }}
              onPress={() => setSelectedPlan('monthly')}
              style={[styles.planCard, styles.monthlyCard, selectedPlan === 'monthly' && styles.planCardSelected]}
              testID="onb-paywall-monthly-plan"
            >
              <View style={styles.planCardText}>
                <OnbTitle size={16}>{hasAnnualTrial ? 'Skip free trial' : 'Monthly'}</OnbTitle>
                <OnbBody muted size={13} style={styles.planCardSubtext}>{`${monthlyPrice}/month`}</OnbBody>
              </View>
              <View style={styles.planCardCheck}>
                {selectedPlan === 'monthly' ? <Check color={colors.white} size={13} strokeWidth={3} /> : null}
              </View>
            </Pressable>
          ) : null}

          {isPaywallStatusUnavailable ? (
            <View style={styles.optionsUnavailable} testID="onb-paywall-billing-unavailable">
              <OnbBody muted size={13} style={styles.billingMessage}>
                {billingStatusError
                  ? 'We could not verify your subscription access. Please try again.'
                  : 'Checking your subscription access…'}
              </OnbBody>
              <OnbButton
                label={isRetryingOptions ? 'Trying again…' : 'Try again'}
                onPress={() => void retryOptions()}
                disabled={isRetryingOptions || isPaywallBusy}
                size="sm"
                style={styles.retryOptionsButton}
                testID="onb-paywall-retry-billing"
                variant="secondary"
              />
            </View>
          ) : null}
          {isBillingLoading ? <OnbBody muted size={13} style={styles.billingMessage}>Loading subscription options…</OnbBody> : null}
          {!isBillingLoading && !isConfigured ? (
            <OnbBody muted size={13} style={styles.billingMessage} testID="onb-paywall-unavailable">
              Subscription options are unavailable on this device. Please use the Momora app on iOS or Android.
            </OnbBody>
          ) : null}
          {!isBillingLoading && isConfigured && !offerings && !isAccessHandoff && !isPaywallStatusUnavailable ? (
            <View style={styles.optionsUnavailable}>
              <OnbBody muted size={13} style={styles.billingMessage} testID="onb-paywall-offerings-unavailable">
                {offeringsError
                  ? 'Subscription options are temporarily unavailable. Please try again.'
                  : 'Subscription options are not available yet. Please try again.'}
              </OnbBody>
              <OnbButton
                label={isRetryingOptions ? 'Trying again…' : 'Try again'}
                onPress={() => void retryOptions()}
                disabled={isRetryingOptions || isPaywallBusy}
                size="sm"
                style={styles.retryOptionsButton}
                testID="onb-paywall-retry-options"
                variant="secondary"
              />
            </View>
          ) : null}
          {errorMessage ? <OnbBody style={styles.errorMessage} testID="onb-paywall-error">{errorMessage}</OnbBody> : null}
          {shouldRenderSubscriptionOptions ? <View style={styles.trustList}>
            {(isResubscribe
              ? RETURNING_OWNER_TRUST_BULLETS
              : showAnnualTrial
                ? NEW_OWNER_TRIAL_TRUST_BULLETS
                : NEW_OWNER_IMMEDIATE_TRUST_BULLETS
            ).map((bullet) => (
              <View key={bullet} style={styles.trustRow}>
                <Check color={emotionColors.calm.c} size={12} strokeWidth={2.5} />
                <OnbBody muted size={12.5}>
                  {bullet}
                </OnbBody>
              </View>
            ))}
          </View> : null}
        </View>
      </OnbShell>

      <Modal animationType="fade" onRequestClose={dismissCloseSheet} transparent visible={isCloseSheetVisible}>
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          onPress={dismissCloseSheet}
          style={styles.sheetBackdrop}
          testID="onb-paywall-sheet-backdrop"
        />
        <View pointerEvents="box-none" style={styles.sheetWrap}>
          <View style={styles.sheetCard} testID="onb-paywall-sheet">
            <View style={styles.sheetHandle} />
            <OnbTitle size={20}>{`Leave ${resolvedPossessive} first page here for now?`}</OnbTitle>
            <OnbBody muted size={14.5} style={styles.sheetBody}>
              {"It'll be waiting if you come back."}
            </OnbBody>
            <View style={styles.sheetButtons}>
              <OnbButton
                label="Leave"
                onPress={leavePaywall}
                disabled={isPaywallBusy}
                style={styles.sheetLeaveButton}
                testID="onb-paywall-sheet-leave-button"
                variant="secondary"
              />
              <OnbButton
                label="Stay"
                onPress={dismissCloseSheet}
                disabled={isLeaving}
                style={styles.sheetStayButton}
                testID="onb-paywall-sheet-stay-button"
              />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 0,
  },
  root: {
    flex: 1,
  },
  closeButton: {
    position: 'absolute',
    top: 8,
    right: 18,
    zIndex: 5,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(44,36,24,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: {
    height: 208,
    marginTop: 44,
  },
  backdropPage: {
    position: 'absolute',
    left: '50%',
    top: 20,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 5,
    shadowColor: colors.ink,
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
  },
  backdropPageImage: {
    width: '100%',
    height: '100%',
  },
  headline: {
    marginTop: 6,
    paddingHorizontal: 26,
    textAlign: 'center',
  },
  planCard: {
    marginTop: 18,
    marginHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: radius.xl,
    padding: 16,
  },
  planCardSelected: {
    borderColor: colors.primary,
  },
  monthlyCard: {
    marginTop: 8,
    paddingVertical: 13,
  },
  planCardText: {
    flex: 1,
  },
  planCardSubtext: {
    marginTop: 3,
  },
  planCardCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  billingMessage: {
    marginTop: 10,
    marginHorizontal: 26,
    textAlign: 'center',
  },
  optionsUnavailable: {
    alignItems: 'center',
  },
  retryOptionsButton: {
    marginTop: 8,
  },
  errorMessage: {
    color: colors.error,
    marginTop: 10,
    marginHorizontal: 26,
    textAlign: 'center',
  },
  trustList: {
    marginTop: 12,
    marginHorizontal: 24,
    gap: 5,
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fullWidthButton: {
    width: '100%',
  },
  legalRow: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
  },
  legalDisclosure: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 10,
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  legalText: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44, 36, 24, 0.32)',
  },
  sheetWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 40,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginBottom: 18,
  },
  sheetBody: {
    marginTop: 8,
  },
  sheetButtons: {
    marginTop: 20,
    flexDirection: 'row',
    gap: 10,
  },
  sheetLeaveButton: {
    flex: 1,
  },
  sheetStayButton: {
    flex: 2,
  },
});
