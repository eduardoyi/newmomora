export interface PortraitVersionCandidate {
  id: string;
  family_member_id: string;
  reference_date: string | null;
  profile_picture_key: string;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string;
  deletion_token?: string | null;
  created_at: string;
}

function newestFirst(left: PortraitVersionCandidate, right: PortraitVersionCandidate): number {
  const created = right.created_at.localeCompare(left.created_at);
  return created !== 0 ? created : right.id.localeCompare(left.id);
}

/**
 * Resolves the age-appropriate usable portrait for a civil target date:
 * latest dated <= target, earliest dated > target, then undated legacy.
 */
export function resolvePortraitVersionAtDate<T extends PortraitVersionCandidate>(
  versions: T[],
  targetDate: string,
): T | null {
  const usable = versions.filter(
    (version) =>
      version.illustrated_profile_status === 'ready' &&
      version.illustrated_profile_key &&
      !version.deletion_token,
  );

  const before = usable
    .filter((version) => version.reference_date !== null && version.reference_date <= targetDate)
    .sort((left, right) => {
      const date = (right.reference_date as string).localeCompare(left.reference_date as string);
      return date !== 0 ? date : newestFirst(left, right);
    });
  if (before[0]) return before[0];

  const after = usable
    .filter((version) => version.reference_date !== null && version.reference_date > targetDate)
    .sort((left, right) => {
      const date = (left.reference_date as string).localeCompare(right.reference_date as string);
      return date !== 0 ? date : newestFirst(left, right);
    });
  if (after[0]) return after[0];

  return usable.filter((version) => version.reference_date === null).sort(newestFirst)[0] ?? null;
}
