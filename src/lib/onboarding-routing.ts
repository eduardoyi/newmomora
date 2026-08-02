// Post-auth routing decision (docs/plans/onboarding-implementation.md WP0
// §0.7, spec decision 17 -- docs/features/onboarding.md "Returning users").
// Pure -- no React or Supabase imports -- so every branch unit-tests
// without a device. Consumed by WP2 (S12, post-OTP), WP4 (J4, post-OTP),
// and WP5 (the front door, for a launch that already has a session).
import type { OnboardingDraft, OnboardingPaywallMode, OnboardingStepId } from '@/utils/onboarding-progress';

export type PostAuthDestination =
  | { kind: 'journal' }
  | { kind: 'resume-onboarding'; step: OnboardingStepId }
  | { kind: 'resume-paywall'; mode: OnboardingPaywallMode }
  | { kind: 'finish-join' }
  | { kind: 'ask-invite-code' };

/**
 * The small billing slice needed by the front door. The full billing status
 * remains owned by the billing service; keeping this input narrow makes the
 * routing decision pure and prevents the router from depending on RevenueCat.
 */
export interface PostAuthBillingState {
  familyId: string;
  isOwner: boolean;
  hasWriteAccess: boolean;
  hasEverHadAccess: boolean;
  trialEligible: boolean;
}

/**
 * Selects the owner paywall variant from the server-owned billing history.
 * Store history takes precedence over the current access flag: once an owner
 * has had a store entitlement, the app must not present the introductory trial
 * again after that entitlement expires.
 */
export function resolveOwnerPaywallMode(
  billing: Pick<PostAuthBillingState, 'hasEverHadAccess' | 'trialEligible'>,
): OnboardingPaywallMode {
  return billing.trialEligible && !billing.hasEverHadAccess ? 'new-owner' : 'resubscribe';
}

export interface ResolvePostAuthDestinationInput {
  memberships: readonly { familyId: string; role?: string }[];
  hasPendingInviteCode: boolean;
  draft: OnboardingDraft | null;
  /** Billing state for the resolved active family, when it has loaded. */
  billing?: PostAuthBillingState | null;
  /** UI hint only (decision 17) -- which fork button/screen started this auth attempt. */
  intent: 'owner' | 'join' | 'login';
}

/**
 * Single source of truth for spec decision 17: routing after any successful
 * OTP auth, and on every app launch that already has a session, is decided
 * by server/device state -- never by which fork button (or screen) got the
 * user to auth.
 *
 * Priority order (each rule only applies once the ones above it don't):
 * 1. An authenticated owner with a resolved billing status is sent to the
 *    authoritative destination. This also corrects a stale device-local
 *    paywall mode after a previous interrupted attempt: server store history
 *    decides whether the first-time trial or resubscribe variant is valid.
 * 2. If billing has not loaded yet, an explicitly marked paywall resume wins
 *    over the membership shortcut. S15 has already created the family before
 *    showing the paywall, so membership alone cannot distinguish an unfinished
 *    new-owner purchase from an ordinary returning owner.
 * 3. A resolved owner with no write access is sent to the appropriate paywall:
 *    the first-time annual-trial variant when the server says the owner has
 *    no store history and is trial-eligible, or the no-trial resubscribe
 *    variant otherwise. Joiners are never routed by the owner's billing
 *    state.
 * 4. Any family membership wins over everything else, including an unmarked
 *    stale device-local draft or a habit-tapped "Start your family's journal"
 *    -- the spec's explicit edge case: a returning owner must land in their
 *    existing journal, never a second family or the paywall.
 * 5. No family, but a stored invite code (deep link or manually entered):
 *    a join needs finishing. This covers two distinct device states this
 *    function cannot tell apart from its inputs alone, and deliberately
 *    doesn't try to:
 *      - the common case -- app/invite.tsx (or J1) stored a code and
 *        *no redemption has been attempted yet*. The user must be sent to
 *        redeem it (J2 "found" onward), not to a waiting screen -- there is
 *        nothing to wait for yet.
 *      - the code was already redeemed and is sitting in
 *        pending-owner-approval state (J5).
 *    Only the consuming screen can distinguish these, by checking
 *    `useRedeemedInviteStatus` (or equivalent redemption-status state) once
 *    it lands here -- this resolver only asserts "no family yet + a stored
 *    code means finish the join before anything else," ahead of starting
 *    owner onboarding.
 * 6. No family, no stored code: the one case the intent hint drives UI --
 *    `intent: 'join'` means the user tapped "I have an invite" but nothing
 *    is stored to look up, so ask for the code.
 * 7. Otherwise, owner onboarding never completed (or never started):
 *    resume at the draft's stored step, or the very beginning if there is
 *    no draft at all.
 *
 * The paywall marker is a resume hint only when billing is unavailable. Once
 * billing has loaded, it is treated as staleable device state rather than an
 * authority, so a failed earlier route cannot permanently lock a trial-eligible
 * owner into the resubscribe copy.
 */
export function resolvePostAuthDestination(input: ResolvePostAuthDestinationInput): PostAuthDestination {
  const { memberships, hasPendingInviteCode, draft, billing, intent } = input;

  if (memberships.length > 0) {
    const billingMembership = billing
      ? memberships.find((membership) => membership.familyId === billing.familyId)
      : undefined;

    if (billing && billingMembership) {
      if (billing.isOwner && !billing.hasWriteAccess) {
        return { kind: 'resume-paywall', mode: resolveOwnerPaywallMode(billing) };
      }

      return { kind: 'journal' };
    }

    if (
      !hasPendingInviteCode &&
      intent !== 'join' &&
      draft?.step === 'paywall' &&
      draft.paywallMode
    ) {
      return { kind: 'resume-paywall', mode: draft.paywallMode };
    }

    return { kind: 'journal' };
  }

  if (hasPendingInviteCode) {
    return { kind: 'finish-join' };
  }

  if (intent === 'join') {
    return { kind: 'ask-invite-code' };
  }

  return { kind: 'resume-onboarding', step: draft?.step ?? 'welcome' };
}
