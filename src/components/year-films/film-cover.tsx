// The 9:16 Year Film list thumbnail (docs/plans/year-film-p2.md Steps 3, 5, 7).
// Shared by the Timeline film card, the Keepsakes tiles and the drawer: it
// signs its own poster through `useYearFilmPosters` (one batched request per
// tick, one cache entry per film), shows a neutral tile while loading or when
// the server won't serve the poster, and re-signs on an image error.
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { colors } from '@/constants/theme';
import { invalidateYearFilmPoster, useYearFilmPosters } from '@/hooks/useYearFilms';
import type { YearFilm } from '@/services/year-films';

export interface FilmCoverProps {
  /** A blocked film is never signed (it is being remade), so no poster is requested for it. */
  film: Pick<YearFilm, 'id' | 'ready_at'> & { blocked?: boolean };
  width: number;
  /** Defaults to `width * 16 / 9`. */
  height?: number;
  /** Defaults to 12. */
  radius?: number;
  showPlay?: boolean;
  testID?: string;
}

export function FilmCover({ film, width, height, radius = 12, showPlay = false, testID }: FilmCoverProps) {
  const queryClient = useQueryClient();
  const posters = useYearFilmPosters(film.blocked ? [] : [film]);
  const poster = posters[film.id];
  const resolvedHeight = height ?? Math.round((width * 16) / 9);
  const playSize = Math.max(22, Math.min(44, Math.round(width * 0.3)));

  return (
    <View
      style={[styles.frame, { width, height: resolvedHeight, borderRadius: radius }]}
      testID={testID}
    >
      {poster ? (
        <Image
          cachePolicy="disk"
          contentFit="cover"
          onError={() => void invalidateYearFilmPoster(queryClient, film.id)}
          source={{ uri: poster.url, cacheKey: poster.cacheKey }}
          style={StyleSheet.absoluteFill}
          testID={testID ? `${testID}-image` : undefined}
        />
      ) : null}
      {showPlay ? (
        <View
          pointerEvents="none"
          style={[styles.playCircle, { width: playSize, height: playSize, borderRadius: playSize / 2 }]}
          testID={testID ? `${testID}-play` : undefined}
        >
          <SymbolView
            fallback={<Text style={styles.playFallback}>▶</Text>}
            name={{ ios: 'play.fill', android: 'play_arrow' }}
            size={Math.round(playSize * 0.42)}
            tintColor={colors.white}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  playCircle: {
    alignItems: 'center',
    backgroundColor: 'rgba(44,36,24,0.45)',
    justifyContent: 'center',
  },
  playFallback: {
    color: colors.white,
    fontSize: 14,
  },
});
