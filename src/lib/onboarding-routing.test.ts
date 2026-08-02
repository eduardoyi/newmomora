import { resolveOwnerPaywallMode, resolvePostAuthDestination } from '@/lib/onboarding-routing';
import { createEmptyOnboardingDraft } from '@/utils/onboarding-progress';

// onboarding-progress.ts imports AsyncStorage at module scope (for its
// read/write helpers) even though createEmptyOnboardingDraft never touches
// storage -- mock it the same way onboarding-progress.test.ts does so this
// otherwise-pure routing test doesn't need a native module.
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('resolvePostAuthDestination', () => {
  it('derives the first-time mode only when store history is absent and trial eligibility is true', () => {
    expect(resolveOwnerPaywallMode({ hasEverHadAccess: false, trialEligible: true })).toBe('new-owner');
    expect(resolveOwnerPaywallMode({ hasEverHadAccess: false, trialEligible: false })).toBe('resubscribe');
    expect(resolveOwnerPaywallMode({ hasEverHadAccess: true, trialEligible: true })).toBe('resubscribe');
  });

  it('routes a member of an existing family straight to the journal', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1' }],
        hasPendingInviteCode: false,
        draft: null,
        intent: 'login',
      }),
    ).toEqual({ kind: 'journal' });
  });

  it('routes an owner with no purchase history to the first-time trial paywall', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1', role: 'owner' }],
        hasPendingInviteCode: false,
        draft: null,
        billing: {
          familyId: 'fam-1',
          isOwner: true,
          hasWriteAccess: false,
          hasEverHadAccess: false,
          trialEligible: true,
        },
        intent: 'login',
      }),
    ).toEqual({ kind: 'resume-paywall', mode: 'new-owner' });
  });

  it('routes an owner with store history but no access to the no-trial resubscribe paywall', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1', role: 'owner' }],
        hasPendingInviteCode: false,
        draft: null,
        billing: {
          familyId: 'fam-1',
          isOwner: true,
          hasWriteAccess: false,
          hasEverHadAccess: true,
          trialEligible: false,
        },
        intent: 'login',
      }),
    ).toEqual({ kind: 'resume-paywall', mode: 'resubscribe' });
  });

  it('does not paywall a complimentary or active owner', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1', role: 'owner' }],
        hasPendingInviteCode: false,
        draft: null,
        billing: {
          familyId: 'fam-1',
          isOwner: true,
          hasWriteAccess: true,
          hasEverHadAccess: false,
          trialEligible: true,
        },
        intent: 'login',
      }),
    ).toEqual({ kind: 'journal' });
  });

  it('does not paywall a joiner when the owner has no access', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1', role: 'manager' }],
        hasPendingInviteCode: false,
        draft: null,
        billing: {
          familyId: 'fam-1',
          isOwner: false,
          hasWriteAccess: false,
          hasEverHadAccess: false,
          trialEligible: true,
        },
        intent: 'login',
      }),
    ).toEqual({ kind: 'journal' });
  });

  it('resumes an explicitly marked first-time paywall even though the family already exists', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1' }],
        hasPendingInviteCode: false,
        draft: { ...createEmptyOnboardingDraft('paywall'), paywallMode: 'new-owner' },
        intent: 'login',
      }),
    ).toEqual({ kind: 'resume-paywall', mode: 'new-owner' });
  });

  it('resumes a lapsed-owner paywall with its no-trial mode', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1' }],
        hasPendingInviteCode: false,
        draft: { ...createEmptyOnboardingDraft('paywall'), paywallMode: 'resubscribe' },
        intent: 'login',
      }),
    ).toEqual({ kind: 'resume-paywall', mode: 'resubscribe' });
  });

  it('lets loaded server billing correct a stale first-time paywall marker', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1', role: 'owner' }],
        hasPendingInviteCode: false,
        draft: { ...createEmptyOnboardingDraft('paywall'), paywallMode: 'new-owner' },
        billing: {
          familyId: 'fam-1',
          isOwner: true,
          hasWriteAccess: false,
          hasEverHadAccess: true,
          trialEligible: false,
        },
        intent: 'login',
      }),
    ).toEqual({ kind: 'resume-paywall', mode: 'resubscribe' });
  });

  it('lets loaded server billing correct a stale resubscribe marker for a trial-eligible owner', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1', role: 'owner' }],
        hasPendingInviteCode: false,
        draft: { ...createEmptyOnboardingDraft('paywall'), paywallMode: 'resubscribe' },
        billing: {
          familyId: 'fam-1',
          isOwner: true,
          hasWriteAccess: false,
          hasEverHadAccess: false,
          trialEligible: true,
        },
        intent: 'login',
      }),
    ).toEqual({ kind: 'resume-paywall', mode: 'new-owner' });
  });

  it('keeps an unmarked stale paywall draft behind the normal membership shortcut', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1' }],
        hasPendingInviteCode: false,
        draft: createEmptyOnboardingDraft('paywall'),
        intent: 'login',
      }),
    ).toEqual({ kind: 'journal' });
  });

  it('routes to the journal even with a second family draft/pending invite present', () => {
    // Edge case from docs/features/onboarding.md: a returning owner who
    // habit-tapped "Start your family's journal" and captured a memory
    // must land in their existing journal, never a second family.
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1' }],
        hasPendingInviteCode: true,
        draft: createEmptyOnboardingDraft('capture'),
        intent: 'owner',
      }),
    ).toEqual({ kind: 'journal' });
  });

  it('routes to journal when the user belongs to more than one family', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [{ familyId: 'fam-1' }, { familyId: 'fam-2' }],
        hasPendingInviteCode: false,
        draft: null,
        intent: 'login',
      }),
    ).toEqual({ kind: 'journal' });
  });

  it('routes to finish-join for a freshly stored code that has not been redeemed yet (app/invite.tsx or J1, before J2 "found" runs)', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [],
        hasPendingInviteCode: true,
        draft: null,
        intent: 'join',
      }),
    ).toEqual({ kind: 'finish-join' });
  });

  it('routes to finish-join for an already-redeemed invite still awaiting owner approval (relaunch after J4, before J5 resolves)', () => {
    // Same resolver output as the unredeemed case above -- this function
    // cannot distinguish "not redeemed yet" from "redeemed, pending
    // approval" from these inputs alone (see rule 2's doc comment); the
    // consuming screen tells them apart via useRedeemedInviteStatus. A
    // relaunch here plausibly arrives with `intent: 'login'` rather than
    // 'join', since the user isn't re-tapping the invite fork.
    expect(
      resolvePostAuthDestination({
        memberships: [],
        hasPendingInviteCode: true,
        draft: null,
        intent: 'login',
      }),
    ).toEqual({ kind: 'finish-join' });
  });

  it('prioritizes the pending invite code over intent', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [],
        hasPendingInviteCode: true,
        draft: null,
        intent: 'owner',
      }),
    ).toEqual({ kind: 'finish-join' });
  });

  it('asks for the invite code only when the intent is join and nothing is stored', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [],
        hasPendingInviteCode: false,
        draft: null,
        intent: 'join',
      }),
    ).toEqual({ kind: 'ask-invite-code' });
  });

  it('resumes owner onboarding at the draft step', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [],
        hasPendingInviteCode: false,
        draft: createEmptyOnboardingDraft('family-name'),
        intent: 'owner',
      }),
    ).toEqual({ kind: 'resume-onboarding', step: 'family-name' });
  });

  it('resumes owner onboarding at the start when there is no draft at all', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [],
        hasPendingInviteCode: false,
        draft: null,
        intent: 'owner',
      }),
    ).toEqual({ kind: 'resume-onboarding', step: 'welcome' });
  });

  it('falls back to resuming onboarding for a login intent with no state at all', () => {
    expect(
      resolvePostAuthDestination({
        memberships: [],
        hasPendingInviteCode: false,
        draft: null,
        intent: 'login',
      }),
    ).toEqual({ kind: 'resume-onboarding', step: 'welcome' });
  });

  // Front-door cases (docs/plans/onboarding-implementation.md WP5): both
  // app/index.tsx (cold launch) and app/(auth)/_layout.tsx (a stray
  // navigation back into the auth group while already signed in) always call
  // this resolver with `intent: 'login'` -- neither is a fork-button tap, so
  // there is no UI hint to pass (rule 3's doc comment). The branches below
  // were previously only exercised with 'owner'/'join' intents; these lock
  // in that the same outcomes hold for the front door's actual call shape.
  describe('front-door call shape (intent: "login")', () => {
    it('resumes owner onboarding at the draft step on a relaunch mid-flow, not just at "welcome"', () => {
      // Covers the app being killed and reopened while an anonymous session
      // is still mid S9-S11 (e.g. after ensureAnonymousSession) -- app/index.tsx
      // must send this device back into the story/capture arc where it left
      // off, not restart at S0.
      expect(
        resolvePostAuthDestination({
          memberships: [],
          hasPendingInviteCode: false,
          draft: createEmptyOnboardingDraft('capture'),
          intent: 'login',
        }),
      ).toEqual({ kind: 'resume-onboarding', step: 'capture' });
    });

    it('routes to finish-join for a freshly stored, not-yet-redeemed code on a relaunch', () => {
      // The unredeemed-code test above (WP0) only exercised `intent: 'join'`.
      // A device killed between J1 (code stored) and J2 actually attempting
      // the lookup relaunches with `intent: 'login'` (nothing re-taps the
      // welcome fork) -- app/index.tsx must still land this on finish-join,
      // not resume-onboarding.
      expect(
        resolvePostAuthDestination({
          memberships: [],
          hasPendingInviteCode: true,
          draft: null,
          intent: 'login',
        }),
      ).toEqual({ kind: 'finish-join' });
    });

    it('routes an authenticated relaunch with an existing family straight to the journal', () => {
      // The exact case app/(auth)/_layout.tsx guards against: a stray
      // navigation (or deep link) back into the auth group by a user who is
      // already fully set up must not show a login screen at all.
      expect(
        resolvePostAuthDestination({
          memberships: [{ familyId: 'fam-1' }],
          hasPendingInviteCode: false,
          draft: null,
          intent: 'login',
        }),
      ).toEqual({ kind: 'journal' });
    });
  });
});
