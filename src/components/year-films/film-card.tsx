// The in-feed Year Film card (docs/plans/year-film-p2.md Step 5.3): a 9:16
// cover with a play glyph on the left, the title and "1 minute · range"
// subtitle on the right, and a "New" pill until the film is watched. Same
// chrome as MemoryCard (white surface, hairline border, radius.lg) so it
// sits in the feed like any other card. Memoized with id-based callbacks --
// the Timeline re-renders its list on every page/refetch.
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FilmCover } from '@/components/year-films/film-cover';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { YearFilm } from '@/services/year-films';
import { filmSubtitle, filmTitle, type YearFilmMember } from '@/utils/year-films';

export const FILM_CARD_COVER_WIDTH = 88;

export interface FilmCardProps {
  film: YearFilm;
  members: readonly YearFilmMember[];
  /** Caller decides (`isNewFilm`, and only once the views query has loaded). */
  isNew: boolean;
  onPress: (filmId: string) => void;
}

export const FilmCard = memo(function FilmCard({ film, members, isNew, onPress }: FilmCardProps) {
  const title = useMemo(() => filmTitle(film, members), [film, members]);
  const subtitle = useMemo(() => filmSubtitle(film), [film]);

  return (
    <Pressable
      accessibilityLabel={`Play ${title}`}
      accessibilityRole="button"
      onPress={() => onPress(film.id)}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      testID={`timeline-film-${film.id}`}
    >
      <FilmCover
        film={film}
        radius={radius.md}
        showPlay
        testID={`timeline-film-${film.id}-cover`}
        width={FILM_CARD_COVER_WIDTH}
      />
      <View style={styles.text}>
        {isNew ? (
          <View style={styles.newPill} testID={`timeline-film-${film.id}-new`}>
            <Text style={styles.newPillText}>New</Text>
          </View>
        ) : null}
        <Text numberOfLines={2} style={styles.title} testID={`timeline-film-${film.id}-title`}>
          {title}
        </Text>
        <Text numberOfLines={2} style={styles.subtitle} testID={`timeline-film-${film.id}-subtitle`}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    padding: spacing.sm + 4,
  },
  cardPressed: { opacity: 0.94 },
  text: {
    alignItems: 'flex-start',
    flex: 1,
    gap: 4,
  },
  newPill: {
    backgroundColor: colors.primaryTint,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  newPillText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 0.02 * 10.5,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 22,
    lineHeight: 1.15 * 22,
  },
  subtitle: {
    color: colors.ink3,
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    lineHeight: 1.4 * 13,
  },
});
