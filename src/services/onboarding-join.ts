// Join-path client wrapper (docs/plans/onboarding-implementation.md WP4,
// "Join path (J1-J5)"). Two unrelated responsibilities share this file
// because the plan calls for "one home" for both:
//
//  1. `previewFamilyInvite` -- J2's pre-auth family-name lookup. The Edge
//     Function itself belongs to WP-SEC ("Invite-preview endpoint" in the
//     plan's WP-SEC section) and ships alongside the anonymous-authorization
//     lockdown; it is being built concurrently with this file. The function
//     name and response shape below are this implementer's best-effort
//     match to the plan's contract description ("family name + inviter
//     display name, nothing else"), not a confirmed API -- if WP-SEC's
//     actual name/shape differs, only `PREVIEW_FAMILY_INVITE_FUNCTION_NAME`
//     and `PreviewFamilyInviteResponse` need to change.
//  2. A tiny device-local "join draft" for J3's display name (and the
//     inviter name J2 looked up, needed again by J5's headline). It must
//     survive the OTP round trip through the mail app -- same requirement
//     as the owner-path draft -- but src/utils/onboarding-progress.ts (WP0,
//     frozen) has no field for it and no per-family display-name concept
//     (decision 6: display name is global, not per-family), so it gets its
//     own small AsyncStorage-backed store here rather than extending a
//     frozen file. Mirrors src/utils/pending-invite-code.ts's defensive
//     try/catch-to-null style.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { invokeEdgeFunction, type ServiceError } from '@/services/ai';

/**
 * Best-effort match to WP-SEC's endpoint name -- see the module doc above.
 * A one-line fix if the shipped function is named differently.
 */
const PREVIEW_FAMILY_INVITE_FUNCTION_NAME = 'preview-family-invite';

export interface PreviewFamilyInviteResponse {
  familyName: string;
  inviterName: string;
}

/**
 * J2's pre-auth family-name lookup. `code` must already be normalized
 * (`normalizeInviteCode`, src/utils/invites.ts) -- same contract as
 * `redeemFamilyInvite` (src/services/invites.ts). Requires a JWT; an
 * anonymous one is fine (`ensureAnonymousSession`, src/lib/anonymous-session.ts)
 * since the endpoint is WP-SEC's anonymous-facing carve-out, but any real
 * session also works. Never sends or expects anything beyond the code in,
 * family/inviter name out -- no membership list, emails, role, or family id
 * per the plan's contract.
 */
export async function previewFamilyInvite(
  code: string,
): Promise<{ data: PreviewFamilyInviteResponse | null; error: ServiceError | null }> {
  return invokeEdgeFunction<PreviewFamilyInviteResponse>(PREVIEW_FAMILY_INVITE_FUNCTION_NAME, {
    code,
  });
}

const JOIN_DRAFT_STORAGE_KEY = 'momora.joinDraft';

export interface JoinDraft {
  /** J3's answer to "What should the family call you?" -- applied to user_profiles.name post-auth (J4). */
  displayName?: string;
  /** J2's preview response, carried forward so J5 can personalize "One sec. {name} just needs to wave you in." without a second lookup. */
  inviterName?: string;
}

function isJoinDraftShape(value: unknown): value is JoinDraft {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<JoinDraft>;
  return (
    (candidate.displayName === undefined || typeof candidate.displayName === 'string') &&
    (candidate.inviterName === undefined || typeof candidate.inviterName === 'string')
  );
}

export async function getJoinDraft(): Promise<JoinDraft> {
  try {
    const stored = await AsyncStorage.getItem(JOIN_DRAFT_STORAGE_KEY);

    if (!stored) {
      return {};
    }

    const parsed: unknown = JSON.parse(stored);
    return isJoinDraftShape(parsed) ? parsed : {};
  } catch {
    // Storage hiccups or corrupt JSON degrade to "no draft" -- the relevant
    // screen just re-asks (J3) or falls back to generic copy (J5).
    return {};
  }
}

/** Merges `partial` onto the currently-stored join draft and persists the result. */
export async function patchJoinDraft(partial: JoinDraft): Promise<void> {
  const current = await getJoinDraft();
  const next: JoinDraft = { ...current, ...partial };

  try {
    await AsyncStorage.setItem(JOIN_DRAFT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort, matching onboarding-progress.ts's convention -- losing a
    // write means the next read falls back to whatever was last persisted.
  }
}

export async function clearJoinDraft(): Promise<void> {
  try {
    await AsyncStorage.removeItem(JOIN_DRAFT_STORAGE_KEY);
  } catch {
    // Best-effort; a stale draft is harmless (J4 clears it only after a
    // successful redeem, so a leftover draft just means a re-attempt
    // re-prefills the same name/inviter it already had).
  }
}
