// Post-auth onboarding commit (docs/plans/onboarding-implementation.md WP2,
// "src/services/onboarding.ts `commitOnboarding(draft)`"). The single place
// that turns a device-local OnboardingDraft (src/utils/onboarding-progress.ts)
// into real rows, once the OTP round trip has produced a real (non-anonymous)
// session -- decision 3's "no anonymous client/tenant writes" rule means
// nothing in this file may run before that.
//
// Called from app/(onboarding)/code.tsx right after a successful
// verifyOtp(). Idempotent across the OTP round trip and app kills: once the
// expensive, non-retryable-without-duplication part (family + kids + first
// memory) fully succeeds, `committedFamilyId` is persisted to the draft and
// every later call short-circuits straight to step 5 (notification prefs),
// never re-creating the family. A failure partway through that block instead
// rolls back the just-created family (best-effort) so a retry starts clean
// via step 2 rather than leaving an orphan family with no kids, or piling up
// duplicate families on repeated retries.
import { supabase } from '@/lib/supabase';
import { createFamily, deleteFamily, fetchMyFamilyMemberships, friendlyFamilyLimitError } from '@/services/family';
import { createFamilyMember, fetchFamilyMembers, type FamilyMember } from '@/services/family-members';
import { createMemory } from '@/services/memories';
import type { PostMediaMemoryInput } from '@/services/memory-posting';
import { fetchUserProfile, updateUserProfile } from '@/services/user-profile';
import { defaultFamilyName } from '@/utils/onboarding-copy';
import { patchOnboardingDraft, type OnboardingDraft, type OnboardingNotificationChoice } from '@/utils/onboarding-progress';
import { getLocalTodayIso } from '@/utils/portrait-versions';

export interface ServiceError {
  message: string;
  code?: string;
}

export interface CommitOnboardingResult {
  familyId: string;
  /** Null on the idempotent short-circuit path (step 1) -- the caller only
   * ever needs this for the fresh-create path; nothing downstream requires
   * re-deriving it from a prior commit. */
  memoryId: string | null;
  /**
   * False for the "returning owner who habit-tapped through onboarding
   * again" edge case (docs/features/onboarding.md decision 18 + the
   * Returning-users table's explicit test) -- the caller (S12B code.tsx)
   * uses this to decide whether to continue into S13 (a real new owner) or
   * route straight to the journal via resolvePostAuthDestination (an
   * existing owner whose captured memory just landed in their real family).
   * Also false on the idempotent short-circuit path -- a same-session
   * double-call never needs to re-decide this (see the layout-level
   * `committedFamilyId` backstop redirect for the cross-relaunch case).
   */
  isNewFamily: boolean;
}

export interface CommitOnboardingDeps {
  /**
   * The pending-upload queue (src/hooks/use-pending-memory-uploads.tsx) is a
   * React context, which this plain service module cannot call directly --
   * the caller screen supplies its `enqueue` here so the media path still
   * goes through the same queue every other media memory in the app uses,
   * instead of a bespoke onboarding-only upload path.
   */
  enqueueMediaUpload?: (input: PostMediaMemoryInput) => void;
}

function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function toServiceError(error: unknown, fallbackMessage: string): ServiceError {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return { message: error.message, code: 'code' in error ? (error.code as string | undefined) : undefined };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: fallbackMessage };
}

/**
 * S11's choice -> the profile fields `commitOnboarding` applies post-auth.
 * The three reminder options are distinguished by time-of-day only; 'none'
 * (and no choice made at all, defensively) leaves reminders off.
 */
export function notificationSettingsForChoice(
  choice: OnboardingNotificationChoice | null,
): { enableDailyReminder: boolean; notificationTime: string | null } {
  switch (choice) {
    case 'eve':
      return { enableDailyReminder: true, notificationTime: '20:00' };
    case 'late':
      return { enableDailyReminder: true, notificationTime: '22:00' };
    case 'morn':
      return { enableDailyReminder: true, notificationTime: '08:00' };
    case 'none':
    case null:
    default:
      return { enableDailyReminder: false, notificationTime: null };
  }
}

/**
 * Creates one name-only `family_members` row per kid name, in entry order.
 * Throws on the first failure -- the caller rolls the whole attempt back
 * rather than leaving a partial roster with no way to tell, on retry, which
 * names already exist (kid names are not unique, so re-deriving "what's
 * missing" from the DB is not reliable).
 */
async function createKidMembers(
  userId: string,
  familyId: string,
  kidNames: string[],
): Promise<FamilyMember[]> {
  const members: FamilyMember[] = [];

  for (const rawName of kidNames) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }

    const { data, error } = await createFamilyMember({
      userId,
      familyId,
      name,
      dateOfBirth: null,
    });

    if (error || !data) {
      throw new Error(error?.message ?? `Could not create a profile for ${name}`);
    }

    members.push(data);
  }

  return members;
}

/**
 * Creates the first memory from the draft's capture. Media path enqueues
 * through the existing pending-upload queue (same as every other media
 * memory in the app -- see use-pending-memory-uploads.tsx) instead of
 * uploading inline; the text-only path is created and awaited directly since
 * there's nothing to upload. `null` capture (defensive -- S9 always
 * completes before S12 in the real flow) skips memory creation entirely.
 */
async function createFirstMemory(
  userId: string,
  familyId: string,
  capture: OnboardingDraft['capture'],
  taggedMemberIds: string[],
  enqueueMediaUpload: CommitOnboardingDeps['enqueueMediaUpload'],
): Promise<string | null> {
  if (!capture) {
    return null;
  }

  const text = capture.text.trim();
  const memoryDate = getLocalTodayIso();

  if (capture.mediaUri) {
    if (!enqueueMediaUpload) {
      throw new Error('Could not save your photo. Please try again.');
    }

    const memoryId = createUuid();
    enqueueMediaUpload({
      memoryId,
      mediaAssets: [
        {
          fileUri: capture.mediaUri,
          contentType: capture.mediaContentType ?? 'image/jpeg',
        },
      ],
      content: text || undefined,
      memoryDate,
      taggedMemberIds,
    });

    return memoryId;
  }

  if (!text) {
    return null;
  }

  const { data, error } = await createMemory({
    userId,
    familyId,
    content: text,
    memoryDate,
    taggedMemberIds,
    memoryType: 'text_only',
  });

  if (error || !data) {
    throw new Error(error?.message ?? 'Could not save your first memory');
  }

  return data.id;
}

/**
 * Best-effort rollback for a fresh family that failed to reach a fully
 * committed state (kids and/or first memory). Soft-delete (`delete_family`)
 * is safe here even though the owner's membership row survives it --
 * fetchMyFamilyMemberships/FamilyProvider already filter out soft-deleted
 * families (see use-family.tsx), so a rolled-back attempt never resolves as
 * "existing family" for a later resolvePostAuthDestination check. Never
 * throws: a failed rollback must not mask the original error that triggered
 * it.
 */
async function rollbackFamily(familyId: string): Promise<void> {
  try {
    await deleteFamily(familyId);
  } catch {
    // Best-effort -- see doc comment above.
  }
}

/**
 * The "returning owner who habit-tapped through onboarding again" check
 * (docs/features/onboarding.md decision 18: "a returning user who taps
 * 'Start your family's journal' out of habit but already owns a family...
 * at step 9 routing must send them to their journal with the captured
 * memory saved to their existing family, never into a second onboarding/
 * family creation"). Mirrors FamilyProvider's own membership resolution
 * (use-family.tsx): skips RLS-invisible/soft-deleted rows, then prefers the
 * profile's `active_family_id` and falls back to the first membership.
 * Returns `null` for a genuinely new owner (no visible membership at all).
 */
async function resolveExistingFamilyId(userId: string): Promise<string | null> {
  const { data: memberships } = await fetchMyFamilyMemberships(userId);
  const visible = (memberships ?? []).filter((row) => row.family && !row.family.deleted_at);

  if (visible.length === 0) {
    return null;
  }

  const { data: profile } = await fetchUserProfile();
  const activeMatch = profile?.active_family_id
    ? visible.find((row) => row.family_id === profile.active_family_id)
    : undefined;

  return (activeMatch ?? visible[0]).family_id;
}

/**
 * Best-effort tag resolution for the returning-owner branch: this session's
 * kid names were typed again from scratch and are not new profiles (no
 * second family/child creation for this edge case), so they're matched by
 * trimmed, case-insensitive name against the existing family's real
 * `family_members` roster -- a name match, not a membership claim. Kids
 * typed this session that don't match anyone real are simply not tagged;
 * an untagged text-only memory is valid (validateTaggedMembers has no
 * minimum), and inventing a profile here would be exactly the "second...
 * family creation" the edge case forbids.
 */
async function resolveExistingTaggedMemberIds(
  existingFamilyId: string,
  draft: OnboardingDraft,
): Promise<string[]> {
  const { data: existingMembers } = await fetchFamilyMembers(existingFamilyId);
  if (!existingMembers || existingMembers.length === 0) {
    return [];
  }

  const byLowerName = new Map(existingMembers.map((member) => [member.name.trim().toLowerCase(), member.id]));

  const taggedIndexes = draft.capture?.taggedKidIndexes ?? [];
  const taggedIds = taggedIndexes
    .map((index) => draft.kidNames[index])
    .filter((name): name is string => Boolean(name))
    .map((name) => byLowerName.get(name.trim().toLowerCase()))
    .filter((id): id is string => Boolean(id));

  return Array.from(new Set(taggedIds));
}

/**
 * Turns a device-local onboarding draft into real rows, exactly once.
 *
 * 1. `draft.committedFamilyId` already set -> a previous call already fully
 *    committed; skip straight to 5. (`isNewFamily` is reported `false` on
 *    this path -- see CommitOnboardingResult's doc comment.)
 * 2. Check whether the now-authenticated user already owns/belongs to a
 *    family (docs/features/onboarding.md decision 18's habit-tap edge
 *    case). If so: never create a second family -- save the captured
 *    memory into the existing one (best-effort name-matched tags) and
 *    report `isNewFamily: false` so the caller routes via
 *    resolvePostAuthDestination instead of continuing the trust/paywall arc.
 * 3. Otherwise, a genuinely new owner: `createFamily(draft.familyName)`,
 *    one name-only `family_members` row per kid name in entry order, then
 *    the first memory (text and/or enqueued media) tagged to the kids
 *    selected on S9. `isNewFamily: true`.
 * 4. Once family/kids/memory all succeed (either branch), `committedFamilyId`
 *    is persisted immediately -- before step 5 -- so a crash between here
 *    and the caller's next render still skips straight here on retry.
 * 5. Apply `notificationChoice` to the profile.
 *
 * A failure creating a brand-new family's kids/memory rolls that family back
 * and returns a retryable error; nothing from a failed attempt is left
 * behind for the next call to trip over.
 */
export async function commitOnboarding(
  draft: OnboardingDraft,
  deps: CommitOnboardingDeps = {},
): Promise<{ data: CommitOnboardingResult | null; error: ServiceError | null }> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      data: null,
      error: { message: userError?.message ?? 'You must be signed in to finish setting up your journal' },
    };
  }

  let familyId = draft.committedFamilyId ?? null;
  let memoryId: string | null = null;
  let isNewFamily = false;

  if (!familyId) {
    const existingFamilyId = await resolveExistingFamilyId(user.id);

    if (existingFamilyId) {
      try {
        const taggedMemberIds = await resolveExistingTaggedMemberIds(existingFamilyId, draft);
        memoryId = await createFirstMemory(
          user.id,
          existingFamilyId,
          draft.capture,
          taggedMemberIds,
          deps.enqueueMediaUpload,
        );
      } catch (error) {
        return { data: null, error: toServiceError(error, 'Could not save your memory. Please try again.') };
      }

      familyId = existingFamilyId;
      await patchOnboardingDraft({ committedFamilyId: familyId });
    } else {
      const familyName = draft.familyName.trim() || defaultFamilyName(draft.kidNames) || 'Our Family';
      const { data: family, error: familyError } = await createFamily(familyName);

      if (familyError || !family) {
        return {
          data: null,
          error: familyError
            ? { ...familyError, message: friendlyFamilyLimitError(familyError.message, familyError.code) }
            : { message: 'Could not create your family' },
        };
      }

      const newFamilyId = family.id;

      try {
        const members = await createKidMembers(user.id, newFamilyId, draft.kidNames);

        const taggedMemberIds = (() => {
          const fromSelection = (draft.capture?.taggedKidIndexes ?? [])
            .map((index) => members[index]?.id)
            .filter((id): id is string => Boolean(id));

          // Defensive fallback so the first memory is never saved untagged --
          // mirrors new-memory.tsx's own single-member auto-tag safety net.
          if (fromSelection.length > 0) {
            return fromSelection;
          }

          return members[0] ? [members[0].id] : [];
        })();

        memoryId = await createFirstMemory(
          user.id,
          newFamilyId,
          draft.capture,
          taggedMemberIds,
          deps.enqueueMediaUpload,
        );
      } catch (error) {
        await rollbackFamily(newFamilyId);
        return { data: null, error: toServiceError(error, 'Could not finish setting up your journal') };
      }

      familyId = newFamilyId;
      isNewFamily = true;
      // Persisted before step 5: the expensive, non-retryable-without-
      // duplication part is done, so every later call (including one
      // triggered by this same screen re-rendering) must skip straight here.
      await patchOnboardingDraft({ committedFamilyId: familyId });
    }
  }

  const { enableDailyReminder, notificationTime } = notificationSettingsForChoice(draft.notificationChoice);
  const { error: profileError } = await updateUserProfile({ enableDailyReminder, notificationTime });

  if (profileError) {
    // The family/kids/memory are already safely committed at this point --
    // a failed preference write is not worth surfacing as a hard onboarding
    // error (the user can change it any time in Settings), so this
    // deliberately does not fail the whole commit.
    console.warn('Failed to apply onboarding notification preference', profileError.message);
  }

  return { data: { familyId, memoryId, isNewFamily }, error: null };
}
