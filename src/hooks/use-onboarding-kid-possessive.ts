// Shared kid-name personalization for the post-capture trust/paywall
// screens (docs/plans/onboarding-implementation.md WP3, closed out by
// WP7-A). S14 (app/(onboarding)/included.tsx, "Everything {name}'s journal
// comes with:") and S15 (app/(onboarding)/paywall.tsx, "Turn {name}'s
// little moments into something you'll hold forever.") both used to carry
// an identical local `resolveKidPossessive(draft)` -- duplicated because
// src/utils/onboarding-copy.ts (WP0's frozen pure-copy surface) had no
// generic version of the rule. That resolver only ever read
// `draft.kidNames`/`draft.capture.taggedKidIndexes`.
//
// The bug: S12B's code.tsx (`finishAfterCommit`) calls `clear()` on the
// onboarding draft *before* routing into S13-S16, specifically so the
// layout's `committedFamilyId` backstop doesn't redirect that arc back to
// the journal (see app/(onboarding)/_layout.tsx and code.tsx). That means
// by the time S14/S15 render in the real app, `draft.kidNames` is already
// `[]` and `draft.capture` is `null` -- the draft-only resolver silently
// collapsed to the neutral "their" branch every single time, quietly
// de-personalizing the two screens whose entire job is persuasion on the
// kid's name (spec decision 8). This mirrors the exact bug WP6 already
// fixed on S16 (portrait.tsx's `resolveTargetMember`), which is why this
// hook follows the same "draft first, real data once the draft is empty"
// shape.
//
// This needs `useFamilyMembers()` (a hook, not a pure function), which is
// why it lives here rather than being folded into onboarding-copy.ts --
// that file is deliberately pure (no React/Supabase imports) so its copy
// rules unit-test without a device; a hook would break that contract for
// every consumer of the file, not just these two screens.
import { useMemo } from 'react';

import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { possessive } from '@/utils/onboarding-copy';
import type { OnboardingDraft } from '@/utils/onboarding-progress';

const NEUTRAL_POSSESSIVE = 'their';

/**
 * Draft-only resolution (identical to the two screens' original local
 * helper). Returns `null` when the draft has nothing to say -- distinct
 * from a real "their" answer -- so the caller knows to fall back to server
 * data instead of prematurely neutralizing the copy.
 */
function resolveDraftPossessive(draft: OnboardingDraft): string | null {
  const taggedNames = (draft.capture?.taggedKidIndexes ?? [])
    .map((index) => draft.kidNames[index])
    .filter((name): name is string => Boolean(name?.trim()));

  if (taggedNames.length === 1) {
    return possessive(taggedNames[0]);
  }

  if (taggedNames.length === 0 && draft.kidNames.length === 1) {
    return possessive(draft.kidNames[0]);
  }

  if (draft.kidNames.length === 0) {
    // Nothing here to resolve -- in practice this is the post-clear state
    // (draft.kidNames wiped by code.tsx's finishAfterCommit before routing
    // into S13-S16). Let the caller fall through to real server data.
    return null;
  }

  // Several kids known to the draft, and either several tagged or nothing
  // deterministic to single out -- "their" is a real, correct answer here
  // (spec: "several tagged" gets the neutral phrasing), not a fallback.
  return NEUTRAL_POSSESSIVE;
}

/**
 * Resolves the possessive kid-name phrase S14 and S15 personalize their
 * headline with -- "Lila's" / "their". Priority order:
 *
 * 1. The device-local draft (`resolveDraftPossessive` above) -- still
 *    populated in unit/integration tests that hand-populate it, and in the
 *    brief pre-clear window between S9's capture and S12B's commit. A
 *    single tagged kid, or a single-kid family with nothing tagged yet,
 *    resolves to that kid; several tagged kids resolve to the neutral
 *    "their" (a real answer, not a fallback).
 * 2. Real `useFamilyMembers()` data, once the draft has nothing left to say
 *    (the normal post-commit case): a single family member resolves
 *    unambiguously; multiple members use the first entry of
 *    `useFamilyMembers`' tag-count-sorted list, which -- because
 *    `fetchFamilyMembers` sorts by tag count -- surfaces the kid tagged on
 *    the first memory ahead of untagged siblings for free. This is the
 *    same reasoning WP6 used for portrait.tsx's `resolveTargetMember`
 *    fallback (`members[0]`), reused here rather than re-derived. Known
 *    simplification carried over from that fix: per-member tag counts
 *    aren't exposed past the service layer, so two kids tied at one tag
 *    each (both tagged on the first memory) can't be distinguished from a
 *    single tagged kid at this layer -- the top of the sort wins the name
 *    rather than falling back to "their". Personalizing on one of the two
 *    real kids is judged the better failure mode than losing
 *    personalization entirely for the overwhelmingly common single-tag
 *    case.
 * 3. Member data still loading, errored, or (defensively) empty -- the
 *    neutral "their" phrasing, the documented safe last resort.
 */
export function useOnboardingKidPossessive(): string {
  const { draft } = useOnboardingFlow();
  const { members } = useFamilyMembers();

  return useMemo(() => {
    const fromDraft = resolveDraftPossessive(draft);
    if (fromDraft !== null) {
      return fromDraft;
    }

    if (members.length === 0) {
      return NEUTRAL_POSSESSIVE;
    }

    return possessive(members[0].name);
  }, [draft, members]);
}
