// The next-up monthly recap on the current year's shelf (docs/plans/
// keepsakes-redesign.md C1). Locked (below the film floors): a dashed tile
// with a progress bar and what is still missing. Unlocked: a solid tile with
// "arrives {Nov 1}" in handwriting. Both show the newest picture of the month
// faded behind the title (a flat surface when no moment has a picture yet).
// The month and the dates come from the server's owner-local `recap`, never
// the device clock.
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { KeepsakesRecap } from '@/services/keepsakes';
import { formatMonthDay, monthNameOf } from '@/utils/keepsakes';
import { mediaImageSource } from '@/utils/media-image-source';

export const UPCOMING_RECAP_WIDTH = 110;
export const UPCOMING_RECAP_HEIGHT = 162;

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
  const locked = isUpcomingRecapLocked(recap);
  const { url } = useMediaUrl(recap.picture_key);
  const title = upcomingRecapTitle(recap);
  const progress = recap.min_moments > 0 ? Math.min(1, recap.moments / recap.min_moments) : 1;

  return (
    <View
      accessibilityLabel={`${title}, ${upcomingRecapCaptionMeta(recap)}`}
      accessible
      style={[styles.tile, locked ? styles.tileLocked : styles.tileUnlocked]}
      testID={testID}
    >
      {url && recap.picture_key ? (
        <Image
          cachePolicy="disk"
          contentFit="cover"
          source={mediaImageSource(url, recap.picture_key)}
          style={[StyleSheet.absoluteFill, styles.picture]}
          testID={`${testID}-picture`}
        />
      ) : null}
      <Text numberOfLines={2} style={styles.title}>
        {title}
      </Text>
      <View style={styles.bottom}>
        {locked ? (
          <>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.max(progress, 0.04) * 100}%` }]} testID={`${testID}-progress`} />
            </View>
            <Text style={styles.hint}>{upcomingRecapHint(recap)}</Text>
          </>
        ) : (
          <>
            <Text style={styles.arrives}>arrives</Text>
            <Text style={styles.date}>{formatMonthDay(recap.delivers_on)}</Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    height: UPCOMING_RECAP_HEIGHT,
    justifyContent: 'space-between',
    overflow: 'hidden',
    padding: 10,
    width: UPCOMING_RECAP_WIDTH,
  },
  tileLocked: { borderColor: colors.borderStrong, borderStyle: 'dashed', borderWidth: 1.5 },
  tileUnlocked: { borderColor: colors.borderStrong, borderWidth: 1.5 },
  picture: { opacity: 0.3 },
  title: { color: colors.ink2, fontFamily: fonts.display, fontSize: 19, lineHeight: 22 },
  bottom: { gap: 6 },
  track: { backgroundColor: '#E2DCEF', borderRadius: radius.pill, height: 5, overflow: 'hidden' },
  fill: { backgroundColor: colors.primary, borderRadius: radius.pill, height: '100%' },
  hint: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 11, lineHeight: 14 },
  arrives: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 11 },
  date: { color: colors.primaryDark, fontFamily: fonts.script, fontSize: 24, lineHeight: 26 },
});
