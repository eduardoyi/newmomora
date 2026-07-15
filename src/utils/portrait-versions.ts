const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXIF_DATE_TIME_PATTERN = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const MIN_PHOTO_YEAR = 1900;

export const PORTRAIT_DATE_SOURCES = [
  'exif',
  'manual',
  'default_today',
  'legacy_unknown',
] as const;

export type PortraitDateSource = (typeof PORTRAIT_DATE_SOURCES)[number];
export type PortraitGenerationStatus = 'pending' | 'generating' | 'ready' | 'failed';

export interface FamilyMemberPortraitVersion {
  id: string;
  family_id: string;
  family_member_id: string;
  user_id: string | null;
  reference_date: string | null;
  date_source: PortraitDateSource;
  profile_picture_key: string;
  illustrated_profile_key: string | null;
  illustrated_profile_status: PortraitGenerationStatus;
  generation_token: string | null;
  generation_started_at: string | null;
  generation_output_key: string | null;
  deletion_token: string | null;
  deletion_started_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DateTuple {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function isValidDateTuple({ year, month, day }: DateTuple): boolean {
  return year >= MIN_PHOTO_YEAR && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function parseIsoDate(value: string): DateTuple | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;

  const tuple = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidDateTuple(tuple) ? tuple : null;
}

function formatDate({ year, month, day }: DateTuple): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseExifDate(value: string): string | null {
  const match = EXIF_DATE_TIME_PATTERN.exec(value.replace(/\0+/g, '').trim());
  if (!match) return null;

  const tuple = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidDateTuple(tuple) ? formatDate(tuple) : null;
}

export function getLocalTodayIso(now = new Date()): string {
  return formatDate({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

/** Portrait dates are intentionally stricter than memory-media capture dates:
 * only shutter/digitized EXIF fields are trusted and dates after local today
 * are discarded rather than receiving the media flow's +1 day tolerance. */
export function extractPortraitReferenceDateIso(exif: unknown, todayIso = getLocalTodayIso()): string | null {
  if (!exif || typeof exif !== 'object' || Array.isArray(exif) || !parseIsoDate(todayIso)) {
    return null;
  }

  const record = exif as Record<string, unknown>;
  for (const key of ['DateTimeOriginal', 'DateTimeDigitized'] as const) {
    const rawValue = record[key];
    if (typeof rawValue !== 'string') continue;
    const value = parseExifDate(rawValue);
    if (value && value <= todayIso) return value;
  }

  return null;
}

export function validatePortraitReferenceDate(
  referenceDate: string,
  options: { dateOfBirth?: string | null; todayIso?: string } = {},
): string | null {
  if (!parseIsoDate(referenceDate)) return 'Enter a valid portrait date';

  const todayIso = options.todayIso ?? getLocalTodayIso();
  if (!parseIsoDate(todayIso)) return 'Could not validate the portrait date';
  if (referenceDate > todayIso) return 'Portrait date cannot be in the future';

  if (options.dateOfBirth) {
    if (!parseIsoDate(options.dateOfBirth)) return 'Enter a valid date of birth first';
    if (referenceDate < options.dateOfBirth) return 'Portrait date cannot be before date of birth';
  }

  return null;
}

function compareNewest(a: FamilyMemberPortraitVersion, b: FamilyMemberPortraitVersion): number {
  const createdComparison = b.created_at.localeCompare(a.created_at);
  return createdComparison !== 0 ? createdComparison : b.id.localeCompare(a.id);
}

export function isUsablePortraitVersion(version: FamilyMemberPortraitVersion): boolean {
  return Boolean(
    version.illustrated_profile_status === 'ready' &&
      version.illustrated_profile_key &&
      !version.deletion_token,
  );
}

function resolveByDatePrecedence(
  candidates: readonly FamilyMemberPortraitVersion[],
  targetDate: string,
): FamilyMemberPortraitVersion | null {
  const dated = candidates.filter(
    (version): version is FamilyMemberPortraitVersion & { reference_date: string } =>
      Boolean(version.reference_date),
  );

  const before = dated
    .filter((version) => version.reference_date <= targetDate)
    .sort((a, b) => b.reference_date.localeCompare(a.reference_date) || compareNewest(a, b))[0];
  if (before) return before;

  const after = dated
    .filter((version) => version.reference_date > targetDate)
    .sort((a, b) => a.reference_date.localeCompare(b.reference_date) || compareNewest(a, b))[0];
  if (after) return after;

  return candidates.filter((version) => !version.reference_date).sort(compareNewest)[0] ?? null;
}

/** latest dated <= target, then earliest dated > target, then undated legacy. */
export function resolvePortraitVersion(
  versions: readonly FamilyMemberPortraitVersion[],
  targetDate: string,
): FamilyMemberPortraitVersion | null {
  return resolveByDatePrecedence(versions.filter(isUsablePortraitVersion), targetDate);
}

/** Age-matched non-deleting source photo while a member has no usable portrait. */
export function resolvePortraitSourceFallback(
  versions: readonly FamilyMemberPortraitVersion[],
  targetDate: string,
): FamilyMemberPortraitVersion | null {
  return resolveByDatePrecedence(
    versions.filter((version) => !version.deletion_token),
    targetDate,
  );
}

export function groupPortraitVersionsByMember(
  versions: readonly FamilyMemberPortraitVersion[],
): Map<string, FamilyMemberPortraitVersion[]> {
  const result = new Map<string, FamilyMemberPortraitVersion[]>();
  for (const version of versions) {
    const current = result.get(version.family_member_id) ?? [];
    current.push(version);
    result.set(version.family_member_id, current);
  }
  return result;
}

export interface PortraitResolvedMemberFields {
  portraitVersions: FamilyMemberPortraitVersion[];
  resolvedPortraitVersion: FamilyMemberPortraitVersion | null;
  avatarImageKey: string | null;
  avatarStatus: PortraitGenerationStatus | null;
  avatarUpdatedAt: string;
}

export function resolveMemberPortraitFields(
  versions: readonly FamilyMemberPortraitVersion[],
  targetDate: string,
  fallbackUpdatedAt: string,
): PortraitResolvedMemberFields {
  const resolved = resolvePortraitVersion(versions, targetDate);
  const sourceFallback = resolved ? null : resolvePortraitSourceFallback(versions, targetDate);

  return {
    portraitVersions: [...versions],
    resolvedPortraitVersion: resolved,
    avatarImageKey: resolved?.illustrated_profile_key ?? sourceFallback?.profile_picture_key ?? null,
    avatarStatus: resolved?.illustrated_profile_status ?? sourceFallback?.illustrated_profile_status ?? null,
    avatarUpdatedAt: resolved?.updated_at ?? sourceFallback?.updated_at ?? fallbackUpdatedAt,
  };
}
