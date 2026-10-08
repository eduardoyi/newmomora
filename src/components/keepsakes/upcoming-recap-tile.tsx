// The next-up monthly recap on the current year's shelf (docs/plans/
// keepsakes-redesign.md C1): the shared `UpcomingTile` fed with the recap's
// copy. The month and the dates come from the server's owner-local `recap`,
// never the device clock.
import { UPCOMING_TILE_HEIGHT, UPCOMING_TILE_WIDTH, UpcomingTile } from '@/components/keepsakes/upcoming-tile';
import type { KeepsakesRecap } from '@/services/keepsakes';
import { formatMonthDay, monthNameOf } from '@/utils/keepsakes';

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

/** The caption under the tile: progress while locked, the delivery date once unlocked. */
export function upcomingRecapCaptionMeta(recap: KeepsakesRecap): string {
  if (isUpcomingRecapLocked(recap)) return `${recap.moments} of ${recap.min_moments} moments`;
  return `arrives ${formatMonthDay(recap.delivers_on)} · ${recap.moments} ${recap.moments === 1 ? 'moment' : 'moments'} so far`;
}

export interface UpcomingRecapTileProps {
  recap: KeepsakesRecap;
  testID?: string;
}

export function UpcomingRecapTile({ recap, testID = 'keepsakes-upcoming-recap' }: UpcomingRecapTileProps) {
  const title = upcomingRecapTitle(recap);
  return (
    <UpcomingTile
      accessibilityLabel={`${title}, ${upcomingRecapCaptionMeta(recap)}`}
      arrivesOn={formatMonthDay(recap.delivers_on)}
      hint={upcomingRecapHint(recap)}
      locked={isUpcomingRecapLocked(recap)}
      pictureKey={recap.picture_key}
      progress={recap.min_moments > 0 ? Math.min(1, recap.moments / recap.min_moments) : 1}
      testID={testID}
      title={title}
    />
  );
}
