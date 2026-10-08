// The next-up monthly recap on the current year's shelf (docs/plans/
// keepsakes-redesign.md C1): the shared `UpcomingTile` fed with the recap's
// copy. The month and the dates come from the server's owner-local `recap`,
// never the device clock.
import { UPCOMING_TILE_HEIGHT, UPCOMING_TILE_WIDTH, UpcomingTile } from '@/components/keepsakes/upcoming-tile';
import type { KeepsakesRecap } from '@/services/keepsakes';
import { formatArrival, monthNameOf } from '@/utils/keepsakes';

export const UPCOMING_RECAP_WIDTH = UPCOMING_TILE_WIDTH;
export const UPCOMING_RECAP_HEIGHT = UPCOMING_TILE_HEIGHT;

/** Locked until the month has enough moments AND enough of them are pictures. */
export function isUpcomingRecapLocked(recap: Pick<KeepsakesRecap, 'moments' | 'visuals' | 'min_moments' | 'min_visuals'>): boolean {
  return recap.moments < recap.min_moments || recap.visuals < recap.min_visuals;
}

/** Text inside a locked tile: what is still missing. */
export function upcomingRecapHint(recap: KeepsakesRecap): string {
  if (recap.moments < recap.min_moments) {
    const missing = recap.min_moments - recap.moments;
    return `${missing} more ${missing === 1 ? 'moment' : 'moments'} this month`;
  }
  const missing = Math.max(0, recap.min_visuals - recap.visuals);
  return `${missing} more with a picture`;
}

export function upcomingRecapTitle(recap: KeepsakesRecap): string {
  return `${monthNameOf(recap.month_start)} recap`;
}

/**
 * The caption under the tile: progress while locked, the arrival once unlocked
 * ("arrives Nov 1 · 23 moments so far"). A `previous` recap (last month's, kept
 * on the 1st) is complete and always "arrives today · 23 moments"; the
 * server's `delivers_on` is not consulted for it (the owner's day may differ
 * from the device's).
 */
export function upcomingRecapCaptionMeta(recap: KeepsakesRecap, todayIso: string, previous = false): string {
  const count = `${recap.moments} ${recap.moments === 1 ? 'moment' : 'moments'}`;
  if (previous) return `arrives today · ${count}`;
  if (isUpcomingRecapLocked(recap)) return `${recap.moments} of ${recap.min_moments} moments`;
  // The current recap arrives on a future 1st, so it is still collecting ("so far").
  return recap.delivers_on === todayIso
    ? `arrives today · ${count}`
    : `arrives ${formatArrival(recap.delivers_on, todayIso)} · ${count} so far`;
}

export interface UpcomingRecapTileProps {
  recap: KeepsakesRecap;
  /** The shelf's today, for "arrives today". */
  todayIso: string;
  /** Last month's recap kept on the 1st: unlocked, "arrives today". */
  previous?: boolean;
  testID?: string;
}

export function UpcomingRecapTile({
  recap,
  todayIso,
  previous = false,
  testID = previous ? 'keepsakes-upcoming-previous-recap' : 'keepsakes-upcoming-recap',
}: UpcomingRecapTileProps) {
  const title = upcomingRecapTitle(recap);
  return (
    <UpcomingTile
      accessibilityLabel={`${title}, ${upcomingRecapCaptionMeta(recap, todayIso, previous)}`}
      arrivesOn={previous ? 'today' : formatArrival(recap.delivers_on, todayIso)}
      hint={upcomingRecapHint(recap)}
      locked={!previous && isUpcomingRecapLocked(recap)}
      pictureKey={recap.picture_key}
      progress={recap.min_moments > 0 ? Math.min(1, recap.moments / recap.min_moments) : 1}
      testID={testID}
      title={title}
    />
  );
}
