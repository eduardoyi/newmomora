// A pressable Year Film tile for Keepsakes (docs/plans/year-film-p2.md
// Step 7): the 9:16 cover with a play glyph, the title beneath, and an
// optional subtitle. Used by the tab's year sections, the child page and the
// recaps grid; tapping opens the player with `source=keepsakes`.
// `filmDisplayState` adds two states: 'remaking' (a paper placeholder with
// "Remaking...", same tile size, NOT pressable -- the old video is blocked) and
// 'updating' (the normal, playable tile plus an "Updating..." badge).
//
// `variant="shelf"` (docs/plans/keepsakes-redesign.md C1) is the library's
// poster object: 110x162, 8px corners, the month (or year) in Newsreader and a
// play glyph with the duration over a dark bottom gradient. It renders only
// the object -- the caption lives under it in the shelf layout.
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FilmCover } from '@/components/year-films/film-cover';
import { RemakingPlaceholder } from '@/components/year-films/remaking-placeholder';
import { colors, fonts, radius } from '@/constants/theme';
import { yearFilmRoute } from '@/lib/routes';
import type { YearFilm } from '@/services/year-films';
import { ageYearLabel, parseDateParts } from '@/utils/memory-book-scope';
import { filmDisplayState, filmSubtitle, filmTitle, type YearFilmMember } from '@/utils/year-films';

export const SHELF_FILM_WIDTH = 110;
export const SHELF_FILM_HEIGHT = 162;
const SHELF_FILM_RADIUS = 8;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The big word on a shelf poster: the month, the year, or the age-year. */
export function shelfFilmOverlayTitle(film: Pick<YearFilm, 'kind' | 'age_year' | 'scope_start_date'>): string {
  const { year, month } = parseDateParts(film.scope_start_date);
  switch (film.kind) {
    case 'family_month':
      return MONTH_NAMES[month - 1] ?? '';
    case 'family_year':
      return String(year);
    case 'birthday':
      return film.age_year ? ageYearLabel(film.age_year) : 'Birthday';
  }
}

/** "1 min" from a duration; null when unknown. */
export function shelfFilmDurationLabel(durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;
  return `${Math.max(1, Math.round(durationMs / 60000))} min`;
}

export interface KeepsakeFilmTileProps {
  film: YearFilm;
  members: readonly YearFilmMember[];
  width: number;
  /** Show the duration · range line under the title. */
  showSubtitle?: boolean;
  /** `shelf`: the library poster (fixed 110x162, no caption). Defaults to the 9:16 tile with its title. */
  variant?: 'default' | 'shelf';
}

export function KeepsakeFilmTile({ film, members, width, showSubtitle = false, variant = 'default' }: KeepsakeFilmTileProps) {
  const title = filmTitle(film, members);
  const large = width >= 140;
  const displayState = filmDisplayState(film);

  // Filtered out upstream (`useFamilyYearFilms`); never draw one that slips through.
  if (displayState === 'hidden') return null;

  if (variant === 'shelf') {
    return <ShelfFilmPoster displayState={displayState} film={film} title={title} />;
  }

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

function ShelfFilmPoster({
  film,
  title,
  displayState,
}: {
  film: YearFilm;
  title: string;
  displayState: 'ready' | 'remaking' | 'updating';
}) {
  if (displayState === 'remaking') {
    return (
      <View
        accessibilityLabel={`${title}, film, remaking`}
        accessible
        style={{ width: SHELF_FILM_WIDTH }}
        testID={`keepsakes-film-${film.id}-remaking`}
      >
        <RemakingPlaceholder
          height={SHELF_FILM_HEIGHT}
          radius={SHELF_FILM_RADIUS}
          variant="tile"
          width={SHELF_FILM_WIDTH}
        />
      </View>
    );
  }

  const isUpdating = displayState === 'updating';
  const duration = shelfFilmDurationLabel(film.duration_ms);

  return (
    <Pressable
      accessibilityLabel={isUpdating ? `${title}, film, updating` : `${title}, film`}
      accessibilityRole="button"
      onPress={() => router.push(yearFilmRoute(film.id, 'keepsakes'))}
      style={({ pressed }) => [styles.shelfPoster, pressed && styles.pressed]}
      testID={`keepsakes-film-${film.id}`}
    >
      <FilmCover
        film={film}
        height={SHELF_FILM_HEIGHT}
        radius={SHELF_FILM_RADIUS}
        width={SHELF_FILM_WIDTH}
      />
      <LinearGradient
        colors={['rgba(20,14,8,0)', 'rgba(20,14,8,0.7)']}
        end={{ x: 0, y: 1 }}
        pointerEvents="none"
        start={{ x: 0, y: 0.35 }}
        style={[StyleSheet.absoluteFill, styles.shelfGradient]}
      />
      <View pointerEvents="none" style={styles.shelfOverlay}>
        <Text numberOfLines={2} style={styles.shelfOverlayTitle}>
          {shelfFilmOverlayTitle(film)}
        </Text>
        <View style={styles.shelfMetaRow}>
          <SymbolView
            fallback={<Text style={styles.shelfPlayFallback}>▶</Text>}
            name={{ ios: 'play.fill', android: 'play_arrow' }}
            size={9}
            tintColor={colors.white}
          />
          {duration ? <Text style={styles.shelfDuration}>{duration}</Text> : null}
        </View>
      </View>
      {isUpdating ? (
        <View style={styles.updatingBadge} testID={`keepsakes-film-${film.id}-updating`}>
          <Text style={styles.updatingBadgeText}>Updating…</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
  shelfPoster: {
    backgroundColor: colors.surface,
    borderRadius: SHELF_FILM_RADIUS,
    height: SHELF_FILM_HEIGHT,
    shadowColor: '#2C2418',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    width: SHELF_FILM_WIDTH,
  },
  shelfGradient: { borderRadius: SHELF_FILM_RADIUS },
  shelfOverlay: { bottom: 10, gap: 4, left: 10, position: 'absolute', right: 10 },
  shelfOverlayTitle: { color: colors.white, fontFamily: fonts.display, fontSize: 19, lineHeight: 21 },
  shelfMetaRow: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  shelfPlayFallback: { color: colors.white, fontSize: 8 },
  shelfDuration: { color: 'rgba(255,255,255,0.9)', fontFamily: fonts.sansMedium, fontSize: 10 },
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
