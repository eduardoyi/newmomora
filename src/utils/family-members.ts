import { buildFamilyPhotoKey } from '@/utils/storage-keys';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateFamilyMemberInput {
  userId: string;
  name: string;
  dateOfBirth: string;
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
  profilePictureKey?: string | null;
  illustratedProfileStatus?: string;
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

export function buildProfilePhotoKey(userId: string, familyMemberId: string): string {
  return buildFamilyPhotoKey(userId, familyMemberId);
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

export type IllustratedProfileStatus = 'pending' | 'generating' | 'ready' | 'failed';

export function isPortraitInProgress(status: IllustratedProfileStatus): boolean {
  return status === 'pending' || status === 'generating';
}

/** Photo used as the portrait source while generating; illustrated portrait when ready. */
export function getProfilePortraitPhotoKey(member: {
  illustrated_profile_key: string | null;
  illustrated_profile_status: string | null;
  profile_picture_key: string | null;
}): string | null {
  const status = (member.illustrated_profile_status ?? 'pending') as IllustratedProfileStatus;

  if (isPortraitInProgress(status)) {
    return member.profile_picture_key;
  }

  return member.illustrated_profile_key ?? member.profile_picture_key;
}

export function getMemberAvatarImageKey(member: {
  illustrated_profile_key: string | null;
  illustrated_profile_status: string | null;
  profile_picture_key: string | null;
}): string | null {
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
