import type { FamilyMemberPortraitVersion } from '@/utils/portrait-versions';

export interface PortraitMotion {
  /** R2 object key of the frame sheet (CHARACTER_PORTRAITS). */
  key: string;
  columns: number;
  rows: number;
}

const MAX_GRID_SIDE = 4;

function isGridSide(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_GRID_SIDE;
}

type PortraitMotionFields = Pick<
  FamilyMemberPortraitVersion,
  'illustrated_profile_key' | 'motion_status' | 'motion_key' | 'motion_source_key' | 'motion_columns' | 'motion_rows'
>;

/**
 * The living-portrait sheet to overlay on this version's still, or null.
 * Only a `ready` sheet made from the CURRENTLY published still counts -- a
 * regenerated still hides the old loop until a new one is published. Fields
 * are optional on the type (older persisted caches lack them), so everything
 * is checked rather than trusted.
 */
export function getPortraitMotion(
  version: Partial<PortraitMotionFields> | null | undefined,
): PortraitMotion | null {
  if (!version) return null;
  const { illustrated_profile_key, motion_status, motion_key, motion_source_key, motion_columns, motion_rows } = version;
  if (motion_status !== 'ready') return null;
  if (!motion_key || !illustrated_profile_key) return null;
  if (motion_source_key !== illustrated_profile_key) return null;
  if (!isGridSide(motion_columns) || !isGridSide(motion_rows)) return null;
  return { key: motion_key, columns: motion_columns, rows: motion_rows };
}
