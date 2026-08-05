// Mirrors the month-abbreviation table in
// supabase/functions/compose-share-card/index.ts's `buildShareCardFilename`
// (Deno Edge Functions can't import from src/, and this client util can't
// import Deno code, so the table is duplicated -- keep both in sync by hand
// if the format ever changes; see
// docs/plans/offline-awareness-and-share-cards.md S3/S4).
//
// The two filenames are deliberately DIFFERENT shapes, not drift:
//   - The server's `Content-Disposition` header carries the pretty
//     `momora-<mon>-<d>-<yyyy>.png` name (what a share target/Files app
//     shows).
//   - This client-side TEMP filename (written to `cacheDirectory` before
//     handing off to `Sharing.shareAsync`) appends a short memory-id
//     fragment so two same-date shares in flight at once can't clobber each
//     other's file mid-share.
const MONTH_ABBREVIATIONS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const ID_FRAGMENT_LENGTH = 6;
const FALLBACK_ID_FRAGMENT = 'share';

function buildIdFragment(memoryId: string): string {
  const stripped = memoryId.replace(/-/g, '').slice(0, ID_FRAGMENT_LENGTH);
  return stripped || FALLBACK_ID_FRAGMENT;
}

/**
 * `momora-<mon>-<d>-<yyyy>-<id6>.png`, e.g. `momora-jun-8-2026-a1b2c3.png`.
 * Parses `memoryDateIso` as local midnight (matching
 * `src/utils/memories.ts`'s `formatDisplayDate` `${date}T00:00:00`
 * convention) so a `YYYY-MM-DD` memory_date never shifts a day across
 * timezones.
 */
export function buildShareCardTempFilename(memoryDateIso: string, memoryId: string): string {
  const idFragment = buildIdFragment(memoryId);
  const parsed = new Date(`${memoryDateIso}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return `momora-memory-${idFragment}.png`;
  }

  const month = MONTH_ABBREVIATIONS[parsed.getMonth()];
  return `momora-${month}-${parsed.getDate()}-${parsed.getFullYear()}-${idFragment}.png`;
}
