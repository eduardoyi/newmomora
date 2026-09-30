// A pressable Year Film tile for Keepsakes (docs/plans/year-film-p2.md
// Step 7): the 9:16 cover with a play glyph, the title beneath, and an
// optional subtitle. Used by the tab's year sections, the child page and the
// recaps grid; tapping opens the player with `source=keepsakes`.
// `filmDisplayState` adds two states: 'remaking' (a paper placeholder with
// "Remaking...", same tile size, NOT pressable -- the old video is blocked) and
// 'updating' (the normal, playable tile plus an "Updating..." badge).
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FilmCover } from '@/components/year-films/film-cover';
import { RemakingPlaceholder } from '@/components/year-films/remaking-placeholder';
import { colors, fonts, radius } from '@/constants/theme';
import { yearFilmRoute } from '@/lib/routes';
import type { YearFilm } from '@/services/year-films';
import { filmDisplayState, filmSubtitle, filmTitle, type YearFilmMember } from '@/utils/year-films';

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
  const displayState = filmDisplayState(film);

  // Filtered out upstream (`useFamilyYearFilms`); never draw one that slips through.
  if (displayState === 'hidden') return null;

  if (displayState === 'remaking') {
    return (
      <View
        accessibilityLabel={`${title}, film, remaking`}
        accessible
        style={{ width }}
        testID={`keepsakes-film-${film.id}-remaking`}
      >
        <RemakingPlaceholder radius={large ? 16 : 12} variant="tile" width={width} />
        <Text numberOfLines={2} style={[styles.title, large && styles.titleLarge]}>
          {title}
        </Text>
        {showSubtitle ? <Text style={styles.subtitle}>Remaking your film…</Text> : null}
      </View>
    );
  }

  const isUpdating = displayState === 'updating';

  return (
    <Pressable
      accessibilityLabel={isUpdating ? `${title}, film, updating` : `${title}, film`}
      accessibilityRole="button"
      onPress={() => router.push(yearFilmRoute(film.id, 'keepsakes'))}
      style={({ pressed }) => [{ width }, pressed && styles.pressed]}
      testID={`keepsakes-film-${film.id}`}
    >
      <FilmCover film={film} radius={large ? 16 : 12} showPlay width={width} />
      {isUpdating ? (
        <View style={styles.updatingBadge} testID={`keepsakes-film-${film.id}-updating`}>
          <Text style={styles.updatingBadgeText}>Updating…</Text>
        </View>
      ) : null}
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
  updatingBadge: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    left: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    position: 'absolute',
    top: 6,
  },
  updatingBadgeText: {
    color: colors.primaryDark,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.02 * 10,
  },
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
