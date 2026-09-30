// A pressable Year Film tile for Keepsakes (docs/plans/year-film-p2.md
// Step 7): the 9:16 cover with a play glyph, the title beneath, and an
// optional subtitle. Used by the tab's year sections, the child page and the
// recaps grid; tapping opens the player with `source=keepsakes`.
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { FilmCover } from '@/components/year-films/film-cover';
import { colors, fonts } from '@/constants/theme';
import { yearFilmRoute } from '@/lib/routes';
import type { YearFilm } from '@/services/year-films';
import { filmSubtitle, filmTitle, type YearFilmMember } from '@/utils/year-films';

export interface KeepsakeFilmTileProps {
  film: YearFilm;
  members: readonly YearFilmMember[];
  width: number;
  /** Show the duration · range line under the title. */
  showSubtitle?: boolean;
}

export function KeepsakeFilmTile({ film, members, width, showSubtitle = false }: KeepsakeFilmTileProps) {
  const title = filmTitle(film, members);
  const large = width >= 140;

  return (
    <Pressable
      accessibilityLabel={`${title}, film`}
      accessibilityRole="button"
      onPress={() => router.push(yearFilmRoute(film.id, 'keepsakes'))}
      style={({ pressed }) => [{ width }, pressed && styles.pressed]}
      testID={`keepsakes-film-${film.id}`}
    >
      <FilmCover film={film} radius={large ? 16 : 12} showPlay width={width} />
      <Text numberOfLines={2} style={[styles.title, large && styles.titleLarge]}>
        {title}
      </Text>
      {showSubtitle ? (
        <Text numberOfLines={2} style={styles.subtitle}>
          {filmSubtitle(film)}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
  title: {
    fontFamily: fonts.displayMedium,
    fontSize: 14,
    lineHeight: 18,
    color: colors.ink,
    marginTop: 8,
  },
  titleLarge: {
    fontSize: 17,
    lineHeight: 22,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 15,
    color: colors.ink3,
    marginTop: 2,
  },
});
