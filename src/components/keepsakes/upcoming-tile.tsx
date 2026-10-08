// The shared look of an "upcoming" shelf object (docs/plans/keepsakes-redesign.md
// C1): the next monthly recap, a coming birthday film and the year-end film all
// use it. Locked (below the film floors): a dashed tile with a progress bar and
// what is still missing. Unlocked: a solid tile with "arrives {Nov 1}" in
// handwriting. Both show a picture from the window faded behind the title (a
// flat surface when there is none). Presentational only; the callers decide
// the numbers, the copy and the dates (always the server's owner-local ones,
// never the device clock).
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { mediaImageSource } from '@/utils/media-image-source';

export const UPCOMING_TILE_WIDTH = 110;
export const UPCOMING_TILE_HEIGHT = 162;

export interface UpcomingTileProps {
  title: string;
  /** Read aloud for the whole tile. */
  accessibilityLabel: string;
  pictureKey: string | null;
  locked: boolean;
  /** 0..1, the bar's fill while locked. */
  progress: number;
  /** What is still missing (locked tiles). */
  hint: string;
  /** "Nov 1" (unlocked tiles). */
  arrivesOn: string;
  testID: string;
}

export function UpcomingTile({
  title,
  accessibilityLabel,
  pictureKey,
  locked,
  progress,
  hint,
  arrivesOn,
  testID,
}: UpcomingTileProps) {
  const { url } = useMediaUrl(pictureKey);

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessible
      style={[styles.tile, locked ? styles.tileLocked : styles.tileUnlocked]}
      testID={testID}
    >
      {url && pictureKey ? (
        <Image
          cachePolicy="disk"
          contentFit="cover"
          source={mediaImageSource(url, pictureKey)}
          style={[StyleSheet.absoluteFill, styles.picture]}
          testID={`${testID}-picture`}
        />
      ) : null}
      <Text numberOfLines={3} style={styles.title}>
        {title}
      </Text>
      <View style={styles.bottom}>
        {locked ? (
          <>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.max(progress, 0.04) * 100}%` }]} testID={`${testID}-progress`} />
            </View>
            <Text style={styles.hint}>{hint}</Text>
          </>
        ) : (
          <>
            <Text style={styles.arrives}>arrives</Text>
            <Text style={styles.date}>{arrivesOn}</Text>
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
    height: UPCOMING_TILE_HEIGHT,
    justifyContent: 'space-between',
    overflow: 'hidden',
    padding: 10,
    width: UPCOMING_TILE_WIDTH,
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
