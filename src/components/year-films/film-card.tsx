// The in-feed Year Film card: the film's 9:16 cover pasted onto the page like a
// taped polaroid print (no text outside the image -- the cover already carries
// the title). Each film leans left or right, and its tape colour, both derived
// from a hash of film.id so a film never flips when list pages load. No card
// chrome: it should read as a keepsake pasted between memories. Memoized with
// an id-based callback -- the Timeline re-renders its list on every
// page/refetch; nothing here animates per frame.
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { FilmCover } from '@/components/year-films/film-cover';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { YearFilm } from '@/services/year-films';
import { filmTitle, type YearFilmMember } from '@/utils/year-films';

/** Horizontal padding of the Timeline's card column (`cardItem` in timeline.tsx). */
const COLUMN_PADDING = spacing.md;
/** Polaroid outer width as a share of the card column. */
const POLAROID_WIDTH_RATIO = 0.58;
/** Even white border around the cover. */
const POLAROID_PADDING = 8;
/** Absorbs the rotated bounding box + tape overhang so nothing clips at the list edges. */
const SIDE_MARGIN = 20;
const PLAY_SIZE = 40;
const TAPE_OPACITY_HEX = '8C'; // ~55%

const TAPE_COLORS = [
  colors.sunSoft + TAPE_OPACITY_HEX,
  colors.primarySoft + TAPE_OPACITY_HEX,
  colors.seaSoft + TAPE_OPACITY_HEX,
] as const;

export interface FilmCardLook {
  side: 'left' | 'right';
  /** Degrees; negative leans left. */
  tilt: number;
  tape: string;
}

/** FNV-1a 32-bit -- stable across runs/devices, no dependencies. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Side, tilt and tape colour for a film, purely a function of its id. */
export function filmCardLook(id: string): FilmCardLook {
  const h = hashId(id);
  const left = h % 2 === 0;
  return {
    side: left ? 'left' : 'right',
    tilt: left ? -3.5 : 3,
    tape: TAPE_COLORS[Math.floor(h / 2) % TAPE_COLORS.length],
  };
}

export interface FilmCardProps {
  film: YearFilm;
  members: readonly YearFilmMember[];
  /** Caller decides (`isNewFilm`, and only once the views query has loaded). */
  isNew: boolean;
  onPress: (filmId: string) => void;
}

export const FilmCard = memo(function FilmCard({ film, members, isNew, onPress }: FilmCardProps) {
  // Title is for the screen reader only; the cover art carries it visually.
  const title = useMemo(() => filmTitle(film, members), [film, members]);
  const look = useMemo(() => filmCardLook(film.id), [film.id]);
  const { width: windowWidth } = useWindowDimensions();

  const polaroidWidth = Math.round((windowWidth - COLUMN_PADDING * 2) * POLAROID_WIDTH_RATIO);
  const coverWidth = polaroidWidth - POLAROID_PADDING * 2;
  const isLeft = look.side === 'left';

  return (
    <Pressable
      accessibilityLabel={`Play ${title}`}
      accessibilityRole="button"
      onPress={() => onPress(film.id)}
      style={({ pressed }) => [
        styles.wrap,
        {
          alignSelf: isLeft ? 'flex-start' : 'flex-end',
          marginLeft: isLeft ? SIDE_MARGIN : 0,
          marginRight: isLeft ? 0 : SIDE_MARGIN,
          width: polaroidWidth,
        },
        pressed && styles.wrapPressed,
      ]}
      testID={`timeline-film-${film.id}`}
    >
      <View style={[styles.polaroid, { transform: [{ rotate: `${look.tilt}deg` }] }]}>
        <FilmCover
          film={film}
          radius={2}
          testID={`timeline-film-${film.id}-cover`}
          width={coverWidth}
        />
        <View
          pointerEvents="none"
          style={[styles.tape, styles.tapeLeft, { backgroundColor: look.tape }]}
        />
        <View
          pointerEvents="none"
          style={[styles.tape, styles.tapeRight, { backgroundColor: look.tape }]}
        />
        <View
          pointerEvents="none"
          style={styles.play}
          testID={`timeline-film-${film.id}-play`}
        >
          <SymbolView
            fallback={<Text style={styles.playFallback}>▶</Text>}
            name={{ ios: 'play.fill', android: 'play_arrow' }}
            size={17}
            tintColor={colors.white}
          />
        </View>
        {isNew ? (
          <View style={styles.newSticker} testID={`timeline-film-${film.id}-new`}>
            <Text style={styles.newStickerText}>New</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // Room for the tape overhang above and the tilt below; the Timeline's
  // cardItem adds the usual gap between rows.
  wrap: {
    paddingBottom: spacing.xs,
    paddingTop: spacing.md,
  },
  wrapPressed: { transform: [{ scale: 0.98 }] },
  polaroid: {
    backgroundColor: colors.white,
    borderRadius: 4,
    elevation: 3,
    padding: POLAROID_PADDING,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
  },
  tape: {
    borderRadius: 1,
    height: 18,
    position: 'absolute',
    top: -8,
    width: 54,
  },
  tapeLeft: {
    left: -16,
    transform: [{ rotate: '-38deg' }],
  },
  tapeRight: {
    right: -16,
    transform: [{ rotate: '38deg' }],
  },
  play: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: PLAY_SIZE / 2,
    bottom: POLAROID_PADDING + 10,
    height: PLAY_SIZE,
    justifyContent: 'center',
    position: 'absolute',
    right: POLAROID_PADDING + 10,
    width: PLAY_SIZE,
  },
  playFallback: {
    color: colors.white,
    fontSize: 14,
  },
  newSticker: {
    backgroundColor: colors.sun,
    borderRadius: radius.pill,
    left: -10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    position: 'absolute',
    top: -6,
    transform: [{ rotate: '-8deg' }],
  },
  newStickerText: {
    color: colors.sunInk,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.02 * 11,
  },
});
