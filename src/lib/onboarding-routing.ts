// Post-auth routing decision (docs/plans/onboarding-implementation.md WP0
// §0.7, spec decision 17 -- docs/features/onboarding.md "Returning users").
// Pure -- no React or Supabase imports -- so every branch unit-tests
// without a device. Consumed by WP2 (S12, post-OTP), WP4 (J4, post-OTP),
// and WP5 (the front door, for a launch that already has a session).
import type { OnboardingDraft, OnboardingStepId } from '@/utils/onboarding-progress';

export type PostAuthDestination =
  | { kind: 'journal' }
  | { kind: 'resume-onboarding'; step: OnboardingStepId }
  | { kind: 'finish-join' }
  | { kind: 'ask-invite-code' };

export interface ResolvePostAuthDestinationInput {
  memberships: readonly { familyId: string }[];
  hasPendingInviteCode: boolean;
  draft: OnboardingDraft | null;
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
 * 1. Any family membership wins over everything else, including a stale
 *    device-local draft or a habit-tapped "Start your family's journal" --
 *    the spec's explicit edge case: a returning owner must land in their
 *    existing journal, never a second family or the paywall.
 * 2. No family, but a stored invite code (deep link or manually entered):
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
 * 3. No family, no stored code: the one case the intent hint drives UI --
 *    `intent: 'join'` means the user tapped "I have an invite" but nothing
 *    is stored to look up, so ask for the code.
 * 4. Otherwise, owner onboarding never completed (or never started):
 *    resume at the draft's stored step, or the very beginning if there is
 *    no draft at all.
 *
 * Entitlement/lapsed-subscription state is not modeled here -- billing is
 * out of scope for this pass (see the plan's Scope table); a lapsed
 * owner's membership row still exists, so they currently resolve to
 * `journal` via rule 1, same as an active owner.
 */
export function resolvePostAuthDestination(input: ResolvePostAuthDestinationInput): PostAuthDestination {
  const { memberships, hasPendingInviteCode, draft, intent } = input;

  if (memberships.length > 0) {
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
