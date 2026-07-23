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

/** A pending row with no claim means the first client dispatch may never have run. */
export const PORTRAIT_PENDING_RECOVERY_MS = 3 * 60 * 1000;

/** Must stay aligned with the durable portrait Workflow lease plus publication margin. */
export const PORTRAIT_GENERATION_STALE_MS = 5.5 * 60 * 1000;

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

type PortraitGenerationRecoveryFields = Pick<
  FamilyMemberPortraitVersion,
  | 'illustrated_profile_status'
  | 'generation_token'
  | 'generation_started_at'
  | 'created_at'
>;

/** Active work is server-owned. A ready version can still be regenerating. */
export function isPortraitGenerationActive(
  version: Pick<FamilyMemberPortraitVersion, 'illustrated_profile_status' | 'generation_token'>,
): boolean {
  return Boolean(version.generation_token) || version.illustrated_profile_status === 'generating';
}

/**
 * `generation_started_at` is the public durable-attempt clock. A pending row
 * that never acquired a claim ages from immutable `created_at`; unrelated
 * profile/date writes must never postpone recovery by changing `updated_at`.
 */
export function getPortraitGenerationRecoveryStartedAt(
  version: PortraitGenerationRecoveryFields,
): string | null {
  if (version.generation_token || version.illustrated_profile_status === 'generating') {
    return version.generation_started_at;
  }
  return version.illustrated_profile_status === 'pending' ? version.created_at : null;
}

export function getPortraitGenerationRecoveryThreshold(
  version: Pick<FamilyMemberPortraitVersion, 'illustrated_profile_status' | 'generation_token'>,
): number | null {
  if (version.generation_token || version.illustrated_profile_status === 'generating') {
    return PORTRAIT_GENERATION_STALE_MS;
  }
  return version.illustrated_profile_status === 'pending' ? PORTRAIT_PENDING_RECOVERY_MS : null;
}

/**
 * One automatic recovery is allowed for a stable server attempt. A new
 * generation token, or a new pending-row clock, intentionally produces a new
 * key. Failed versions have no automatic recovery path.
 */
export function getPortraitGenerationRecoveryKey(
  version: Pick<
    FamilyMemberPortraitVersion,
    | 'id'
    | 'illustrated_profile_status'
    | 'generation_token'
    | 'generation_started_at'
    | 'created_at'
  >,
): string | null {
  const clock = getPortraitGenerationRecoveryStartedAt({
    illustrated_profile_status: version.illustrated_profile_status,
    generation_token: version.generation_token,
    generation_started_at: version.generation_started_at,
    created_at: version.created_at,
  });
  if (!clock) return null;
  return `${version.id}:${version.generation_token ?? clock}`;
}

export function shouldRecoverPortraitGeneration(
  version: PortraitGenerationRecoveryFields,
  nowMs = Date.now(),
): boolean {
  const threshold = getPortraitGenerationRecoveryThreshold(version);
  if (threshold === null) return false;

  const startedAt = getPortraitGenerationRecoveryStartedAt(version);
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(startedAtMs) && nowMs - startedAtMs >= threshold;
}

export function shouldPollPortraitVersions(
  versions: readonly Pick<
    FamilyMemberPortraitVersion,
    | 'illustrated_profile_status'
    | 'generation_token'
    | 'generation_started_at'
    | 'created_at'
    | 'deletion_token'
  >[],
  nowMs = Date.now(),
): boolean {
  return versions.some((version) => (
    (!shouldRecoverPortraitGeneration(version, nowMs) && (
      version.illustrated_profile_status === 'pending' ||
      isPortraitGenerationActive(version)
    )) ||
    Boolean(version.deletion_token)
  ));
}

export function isPortraitGenerationStalled(
  version: PortraitGenerationRecoveryFields,
  nowMs = Date.now(),
): boolean {
  return shouldRecoverPortraitGeneration(version, nowMs);
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
    // Versioned portrait objects are immutable. Use the selected object key as
    // the cache identity so metadata-only changes do not refetch the image.
    avatarUpdatedAt:
      resolved?.illustrated_profile_key ??
      sourceFallback?.profile_picture_key ??
      fallbackUpdatedAt,
  };
}
