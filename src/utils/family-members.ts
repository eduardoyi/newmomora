const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateFamilyMemberInput {
  userId: string;
  familyId: string;
  name: string;
  // Widened for onboarding's name-only child profiles (WP0 §0.9,
  // docs/plans/onboarding-implementation.md) -- `date_of_birth` is
  // nullable in the DB already. Existing callers (add-family-member.tsx)
  // pass a validated string via `validateDateOfBirth`, which keeps its
  // current required-behavior; only this input type widened.
  dateOfBirth: string | null;
  gender?: string;
  additionalInfo?: string;
  nicknames?: string[] | null;
}

export interface UpdateFamilyMemberInput {
  name?: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  additionalInfo?: string | null;
  nicknames?: string[] | null;
}

export function validateFamilyMemberName(name: string): string | null {
  const trimmed = name.trim();

  if (!trimmed) {
    return 'Name is required';
  }

  if (trimmed.length > 100) {
    return 'Name must be 100 characters or fewer';
  }

  return null;
}

export function validateDateOfBirth(dateOfBirth: string): string | null {
  const trimmed = dateOfBirth.trim();

  if (!trimmed) {
    return 'Date of birth is required';
  }

  if (!ISO_DATE_PATTERN.test(trimmed)) {
    return 'Use YYYY-MM-DD format';
  }

  const parsed = new Date(`${trimmed}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return 'Enter a valid date of birth';
  }

  if (parsed > new Date()) {
    return 'Date of birth cannot be in the future';
  }

  return null;
}

/** Ages at or above this threshold show whole years only in UI (no months). */
export const AGE_YEARS_ONLY_THRESHOLD = 5;

export function getAgePartsFromDob(
  dateOfBirth: string,
  referenceDate = new Date(),
): { years: number; months: number } | null {
  const birthDate = new Date(`${dateOfBirth}T00:00:00`);

  if (Number.isNaN(birthDate.getTime())) {
    return null;
  }

  let years = referenceDate.getFullYear() - birthDate.getFullYear();
  let months = referenceDate.getMonth() - birthDate.getMonth();

  if (referenceDate.getDate() < birthDate.getDate()) {
    months -= 1;
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  return { years, months };
}

function shouldShowAgeMonths(years: number): boolean {
  return years < AGE_YEARS_ONLY_THRESHOLD;
}

export function formatAgeFromDob(dateOfBirth: string, referenceDate = new Date()): string {
  const age = getAgePartsFromDob(dateOfBirth, referenceDate);

  if (!age) {
    return '';
  }

  const { years, months } = age;

  if (years <= 0) {
    return months <= 0 ? 'Newborn' : `${months} month${months === 1 ? '' : 's'}`;
  }

  if (!shouldShowAgeMonths(years) || months === 0) {
    return `${years} year${years === 1 ? '' : 's'}`;
  }

  return `${years} year${years === 1 ? '' : 's'}, ${months} month${months === 1 ? '' : 's'}`;
}

/** Compact age for inline labels (e.g. memory detail member pills). */
export function formatAgeCompactFromDob(dateOfBirth: string, referenceDate = new Date()): string {
  const age = getAgePartsFromDob(dateOfBirth, referenceDate);

  if (!age) {
    return '';
  }

  const { years, months } = age;

  if (years <= 0) {
    return `${months}m`;
  }

  if (!shouldShowAgeMonths(years) || months === 0) {
    return `${years}y`;
  }

  return `${years}y ${months}m`;
}

/** Ages at or above this are hidden on memory member pills (adults show name only). */
export const AGE_PILL_MAX_YEARS = 18;

/** Compact age for memory member pills; null for adults so pills show just the name. */
export function formatTaggedMemberAge(dateOfBirth: string, referenceDate = new Date()): string | null {
  const age = getAgePartsFromDob(dateOfBirth, referenceDate);
  if (!age || age.years >= AGE_PILL_MAX_YEARS) {
    return null;
  }
  return formatAgeCompactFromDob(dateOfBirth, referenceDate);
}

export type IllustratedProfileStatus = 'pending' | 'generating' | 'ready' | 'failed';

export function isPortraitInProgress(status: IllustratedProfileStatus): boolean {
  return status === 'pending' || status === 'generating';
}

/** Photo used as the portrait source while generating; illustrated portrait when ready. */
export function getProfilePortraitPhotoKey(member: {
  avatarImageKey?: string | null;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string | null;
  profile_picture_key: string | null;
}): string | null {
  if ('avatarImageKey' in member) {
    return member.avatarImageKey ?? null;
  }
  const status = (member.illustrated_profile_status ?? 'pending') as IllustratedProfileStatus;

  if (isPortraitInProgress(status)) {
    return member.profile_picture_key;
  }

  return member.illustrated_profile_key ?? member.profile_picture_key;
}

export function getMemberAvatarImageKey(member: {
  avatarImageKey?: string | null;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string | null;
  profile_picture_key: string | null;
}): string | null {
  if ('avatarImageKey' in member) {
    return member.avatarImageKey ?? null;
  }
  const status = (member.illustrated_profile_status ?? 'pending') as IllustratedProfileStatus;

  if (isPortraitInProgress(status)) {
    return member.profile_picture_key;
  }

  return member.illustrated_profile_key ?? member.profile_picture_key;
}

export function getPortraitImageCacheKey(
  imageKey: string | null | undefined,
  updatedAt: string,
): string | undefined {
  return imageKey ? `${imageKey}-${updatedAt}` : undefined;
}

/**
 * A member with zero portrait versions ever created -- distinct from
 * `pending`/`generating` (which mean a photo WAS picked and a portrait is
 * already in flight). Onboarding's S16 (app/(onboarding)/portrait.tsx) and
 * S17 (app/(onboarding)/reveal.tsx) both need the exact same definition of
 * "still needs their photo picked" -- S16 to fall back to a target once the
 * pre-auth draft is empty, S17 to find the next kid in the sibling chain --
 * so it lives here once rather than risking the two screens drifting apart.
 * Duck-typed (not `FamilyMember`) to avoid a circular import: this file is
 * imported BY src/services/family-members.ts, not the other way around.
 */
export function hasNoPortraitYet(member: { portraitVersions?: unknown[] }): boolean {
  return (member.portraitVersions?.length ?? 0) === 0;
}

/**
 * A family member profile is "complete" once it has name + date of birth +
 * a photo. Name is already required at creation, so this checks the other
 * two. Onboarding creates children from name only (docs/features/onboarding.md
 * decision 8, `createKidMembers` in src/services/onboarding.ts), so a
 * freshly onboarded kid stays incomplete until someone fills in the rest
 * via the edit screen.
 *
 * This is the SINGLE definition of "incomplete" -- src/components/cast-card.tsx
 * (the family tab's card, rendered from app/(app)/(tabs)/family.tsx) and
 * src/components/memory-tag-picker.tsx's `MemberChip` both import this
 * rather than each deriving their own notion of incomplete, so the two
 * surfaces can't drift apart.
 *
 * "Has a photo" delegates entirely to `getProfilePortraitPhotoKey`, which
 * already reuses `isPortraitInProgress` to keep the *source* photo counted
 * while a portrait is `pending`/`generating` -- a member mid-generation has
 * a photo (the one that kicked off generation), so it is complete, not
 * incomplete. This function does not re-derive that from status on its own.
 *
 * `is_user_profile` (the signed-in owner's own row) is exempted -- nobody
 * "onboards" their own profile through the name-only kid flow. There is no
 * separate adult/child flag in this schema, but that is not a gap in
 * practice: the only path that ever creates a non-owner member without a
 * DOB is onboarding's name-only kid creation. The manual "Add someone"
 * modal (app/(app)/add-family-member.tsx) always requires DOB + photo up
 * front, so a manually-added adult (partner, grandparent) is never
 * incomplete by this definition either -- there is currently no path that
 * produces one.
 */
export function isFamilyMemberProfileIncomplete(member: {
  avatarImageKey?: string | null;
  date_of_birth: string | null;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string | null;
  is_user_profile: boolean;
  profile_picture_key: string | null;
}): boolean {
  if (member.is_user_profile) {
    return false;
  }

  return !member.date_of_birth || !getProfilePortraitPhotoKey(member);
}

export function getPortraitStatusLabel(status: IllustratedProfileStatus): string {
  switch (status) {
    case 'pending':
      return 'Portrait pending';
    case 'generating':
      return 'Generating portrait…';
    case 'ready':
      return 'Portrait ready';
    case 'failed':
      return 'Portrait failed';
    default:
      return 'Portrait pending';
  }
}
