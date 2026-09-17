// Deterministic fallback cover washes for the Memory Books shelf redesign
// (owner-approved picker-redesign brief, 2026-09-17). Used whenever a book
// tile has no resolved cover photo yet (no `cover_asset_key`, or its signed
// URL hasn't loaded) -- picks one of five warm gradient washes by a stable
// hash of the book's id, so the same book always shows the same wash across
// re-renders/remounts instead of visibly flickering between colors.

export interface CoverWash {
  /** Top -> bottom gradient stops. */
  colors: readonly [string, string, string];
}

export const COVER_WASHES: readonly CoverWash[] = [
  { colors: ['#F7CE8E', '#E9A95E', '#D2814B'] }, // amber
  { colors: ['#F6C9B6', '#EDA18E', '#D2766A'] }, // blush
  { colors: ['#D6E5D4', '#9FC6A8', '#7BA68C'] }, // sage
  { colors: ['#CFDCEE', '#9FB7D7', '#7B93BA'] }, // slate
  { colors: ['#EBD8EE', '#C3A2D6', '#9D7CB8'] }, // lilac
];

/** Simple, deterministic string hash (Java's String.hashCode algorithm) --
 * not cryptographic, just stable across runs/platforms for bucketing. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function coverWashForId(id: string): CoverWash {
  return COVER_WASHES[hashString(id) % COVER_WASHES.length];
}
