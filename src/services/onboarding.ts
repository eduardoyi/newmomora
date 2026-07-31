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
  /**
   * Set only when the captured memory included a photo/video -- the caller
   * MUST hand this to the same pending-upload queue every other media
   * memory in the app uses (usePendingMemoryUploads().enqueue), but only
   * *after* the caller's own family-membership query invalidation has
   * resolved (code.tsx already awaits one post-commit). This function
   * deliberately does not call that queue itself: enqueue()'s own
   * user/family guard reads live React context (useAuth()/useFamily()),
   * not the user/family this function already validated server-side
   * directly. Calling it any earlier -- as an injected
   * `enqueueMediaUpload` dependency used to, from inside this function --
   * could see a family React hadn't learned about yet: guaranteed stale for
   * a brand-new family (nothing tells useFamily() about it until that
   * invalidation runs) and racy for a returning owner's already-existing
   * one, which is what produced "You must be signed in to save a memory"
   * for an already-verified returning owner (docs/features/onboarding.md
   * decision 18). Null whenever the capture was text-only, empty, or the
   * idempotent short-circuit path was taken.
   */
  pendingMediaUpload: PostMediaMemoryInput | null;
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

interface FirstMemoryResult {
  memoryId: string | null;
  /** See CommitOnboardingResult.pendingMediaUpload's doc comment -- the
   * caller, not this function, hands this to the pending-upload queue. */
  pendingMediaUpload: PostMediaMemoryInput | null;
}

/**
 * Creates the first memory from the draft's capture. The media path builds
 * (but deliberately does not enqueue -- see CommitOnboardingResult's doc
 * comment) the same payload the pending-upload queue every other media
 * memory in the app uses expects; the text-only path is created and awaited
 * directly since there's nothing to upload. `null` capture (defensive -- S9
 * always completes before S12 in the real flow) skips memory creation
 * entirely.
 */
async function createFirstMemory(
  userId: string,
  familyId: string,
  capture: OnboardingDraft['capture'],
  taggedMemberIds: string[],
): Promise<FirstMemoryResult> {
  if (!capture) {
    return { memoryId: null, pendingMediaUpload: null };
  }

  const text = capture.text.trim();
  const memoryDate = getLocalTodayIso();

  if (capture.mediaUri) {
    const memoryId = createUuid();

    return {
      memoryId,
      pendingMediaUpload: {
        memoryId,
        mediaAssets: [
          {
            fileUri: capture.mediaUri,
            contentType: capture.mediaContentType ?? 'image/jpeg',
            // Same fields new-memory.tsx passes from MediaAttachment -- an
            // undefined aspectRatio here reproduces the bug where onboarding
            // media renders pillarboxed at DEFAULT_MEDIA_ASPECT_RATIO instead
            // of sized to the photo (see OnboardingDraftCapture's doc
            // comment in src/utils/onboarding-progress.ts).
            durationMs: capture.mediaDurationMs,
            aspectRatio: capture.mediaAspectRatio,
          },
        ],
        content: text || undefined,
        memoryDate,
        taggedMemberIds,
      },
    };
  }

  if (!text) {
    return { memoryId: null, pendingMediaUpload: null };
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

  return { memoryId: data.id, pendingMediaUpload: null };
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
 * `resolveExistingFamilyId`'s result. Three states, deliberately not
 * collapsed to `string | null`: a lookup failure must never be treated the
 * same as "definitely no existing family" -- see that function's doc
 * comment and commitOnboarding's handling of `unknown` below.
 */
type ExistingFamilyLookup =
  | { kind: 'found'; familyId: string }
  | { kind: 'none' }
  | { kind: 'unknown'; error: ServiceError };

/**
 * The "returning owner who habit-tapped through onboarding again" check
 * (docs/features/onboarding.md decision 18: "a returning user who taps
 * 'Start your family's journal' out of habit but already owns a family...
 * at step 9 routing must send them to their journal with the captured
 * memory saved to their existing family, never into a second onboarding/
 * family creation"). Mirrors FamilyProvider's own membership resolution
 * (use-family.tsx): skips RLS-invisible/soft-deleted rows, then prefers the
 * profile's `active_family_id` and falls back to the first membership.
 *
 * Both underlying calls return a `{ data, error }` pair, and a transient
 * network failure surfaces as `data: null` -- indistinguishable from a
 * genuine "no rows" result unless `error` is checked explicitly. Silently
 * treating a failed lookup as "no existing family" is worse than the
 * original bug this file fixed: it would make commitOnboarding create a
 * *second* family for a real returning owner, exactly what decision 18
 * forbids, with nothing surfaced to notice it happened. So a failure on
 * either call reports `unknown`, never `none` -- only a lookup that
 * genuinely completed and found zero visible rows is safe to report as
 * "this is a new owner."
 */
async function resolveExistingFamilyId(userId: string): Promise<ExistingFamilyLookup> {
  const { data: memberships, error: membershipsError } = await fetchMyFamilyMemberships(userId);

  if (membershipsError) {
    return { kind: 'unknown', error: membershipsError };
  }

  const visible = (memberships ?? []).filter((row) => row.family && !row.family.deleted_at);

  if (visible.length === 0) {
    return { kind: 'none' };
  }

  const { data: profile, error: profileError } = await fetchUserProfile();

  if (profileError) {
    // We already know >=1 family exists (visible.length > 0) -- what's
    // uncertain here is only *which* one is active, not whether one
    // exists. Reporting `unknown` rather than guessing (e.g. falling back
    // to visible[0]) keeps this function's contract simple and matches the
    // same "surface it, don't guess" rule as the membership-fetch failure
    // above; the caller's retry path (existingFamilyId-less error) is the
    // same safe fallback either way.
    return { kind: 'unknown', error: profileError };
  }

  const activeMatch = profile?.active_family_id
    ? visible.find((row) => row.family_id === profile.active_family_id)
    : undefined;

  return { kind: 'found', familyId: (activeMatch ?? visible[0]).family_id };
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
 *    case) via resolveExistingFamilyId. Three outcomes: `found` -- never
 *    create a second family, save the captured memory into the existing
 *    one instead (best-effort name-matched tags) and report
 *    `isNewFamily: false` so the caller routes via
 *    resolvePostAuthDestination instead of continuing the trust/paywall
 *    arc; `none` -- proceed to 3, a genuinely new owner; `unknown` -- the
 *    lookup itself failed (network error on the membership or profile
 *    fetch), so this returns a plain retryable error instead of guessing
 *    either way. Guessing `none` on a failed lookup would silently create
 *    a second family for a real returning owner -- worse than the error it
 *    replaces, because nothing would surface it happening.
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
): Promise<{
  data: CommitOnboardingResult | null;
  error: ServiceError | null;
  /**
   * Set only on a failure that happened *after* this call had already
   * confirmed the authenticated user owns a real, existing family (the
   * returning-owner branch below). The account and family are real even
   * though this attempt's memory failed to save -- the caller must not
   * treat this like "no account yet" and strand the user on a dead-end
   * retry; it should route them into their real journal instead
   * (docs/features/onboarding.md decision 18: never strand a returning
   * owner mid-onboarding). Absent for every other failure, where there is
   * genuinely nothing yet to route the user into.
   */
  existingFamilyId?: string;
}> {
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
  let pendingMediaUpload: PostMediaMemoryInput | null = null;

  if (!familyId) {
    const lookup = await resolveExistingFamilyId(user.id);

    if (lookup.kind === 'unknown') {
      // Could not determine whether this user already has a family --
      // never guess. No `existingFamilyId` here (unlike the try/catch
      // below): we don't actually know one exists, so the caller must not
      // route this like a confirmed returning owner either. This is a
      // plain, retryable error -- the same "Try again" path a genuinely
      // new owner sees, which is exactly right: we simply don't know yet
      // which of the two they are.
      return {
        data: null,
        error: { message: 'Could not check your existing family. Please try again.', code: lookup.error.code },
      };
    }

    if (lookup.kind === 'found') {
      const existingFamilyId = lookup.familyId;
      try {
        const taggedMemberIds = await resolveExistingTaggedMemberIds(existingFamilyId, draft);
        const firstMemory = await createFirstMemory(user.id, existingFamilyId, draft.capture, taggedMemberIds);
        memoryId = firstMemory.memoryId;
        pendingMediaUpload = firstMemory.pendingMediaUpload;
      } catch (error) {
        return {
          data: null,
          error: toServiceError(error, 'Could not save your memory. Please try again.'),
          existingFamilyId,
        };
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

        const firstMemory = await createFirstMemory(user.id, newFamilyId, draft.capture, taggedMemberIds);
        memoryId = firstMemory.memoryId;
        pendingMediaUpload = firstMemory.pendingMediaUpload;
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

  return { data: { familyId, memoryId, isNewFamily, pendingMediaUpload }, error: null };
}
