// "Moments" section of the Year Film edit sheet: a grid of the moments the
// film shows (plus ones already removed, so they can be restored). Tap
// toggles hidden: dimmed with an eye-off badge.
import { Image } from 'expo-image';
import { EyeOff } from 'lucide-react-native';
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { MemoryFallbackTile } from '@/components/memory-fallback-tile';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { YearFilmEditThumbnail } from '@/hooks/useYearFilmEditFrames';
import type { YearFilmEditFrame } from '@/services/year-films';
import { formatIsoDateForDisplay } from '@/utils/dates';
import { mediaImageSource } from '@/utils/media-image-source';

const COLUMNS = 4;
const GAP = 8;
const SHEET_HORIZONTAL_PADDING = spacing.lg;

interface MomentTileProps {
  frame: YearFilmEditFrame;
  isHidden: boolean;
  size: number;
  thumbnail: YearFilmEditThumbnail;
  onToggle: (memoryId: string) => void;
}

const MomentTile = memo(function MomentTile({ frame, isHidden, size, thumbnail, onToggle }: MomentTileProps) {
  const date = frame.date ? formatIsoDateForDisplay(frame.date) : 'undated';
  return (
    <Pressable
      accessibilityLabel={`Moment from ${date}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: !isHidden }}
      accessibilityHint={isHidden ? 'Hidden from the film. Tap to show it again.' : 'Tap to hide it from the film.'}
      onPress={() => onToggle(frame.memoryId)}
      style={({ pressed }) => [styles.tile, { height: size, width: size }, pressed && styles.tilePressed]}
      testID={`film-edit-moment-${frame.memoryId}`}
    >
      <View style={[StyleSheet.absoluteFill, isHidden && styles.dimmed]}>
        {thumbnail.key ? (
          thumbnail.url ? (
            <Image
              contentFit="cover"
              source={mediaImageSource(thumbnail.url, thumbnail.key)}
              style={StyleSheet.absoluteFill}
            />
          ) : null
        ) : (
          <MemoryFallbackTile
            emotion={thumbnail.emotion}
            kind={thumbnail.fallback}
            memoryId={frame.memoryId}
            size={size}
          />
        )}
      </View>
      {isHidden ? (
        <View style={styles.hiddenBadge} testID={`film-edit-moment-${frame.memoryId}-hidden`}>
          <EyeOff color={colors.white} size={14} />
        </View>
      ) : null}
    </Pressable>
  );
});

interface EditMomentsGridProps {
  frames: readonly YearFilmEditFrame[];
  hiddenIds: ReadonlySet<string>;
  resolveThumbnail: (memoryId: string) => YearFilmEditThumbnail;
  onToggle: (memoryId: string) => void;
}

export function EditMomentsGrid({ frames, hiddenIds, resolveThumbnail, onToggle }: EditMomentsGridProps) {
  const { width } = useWindowDimensions();
  const size = useMemo(
    () => Math.floor((width - SHEET_HORIZONTAL_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS),
    [width],
  );

  if (frames.length === 0) {
    return (
      <Text style={styles.empty} testID="film-edit-moments-empty">
        No individual moments to choose from in this film.
      </Text>
    );
  }

  return (
    <View style={styles.grid} testID="film-edit-moments-grid">
      {frames.map((frame) => (
        <MomentTile
          frame={frame}
          isHidden={hiddenIds.has(frame.memoryId)}
          key={frame.memoryId}
          onToggle={onToggle}
          size={size}
          thumbnail={resolveThumbnail(frame.memoryId)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  tilePressed: { opacity: 0.85 },
  dimmed: { opacity: 0.3 },
  hiddenBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(44,36,24,0.72)',
    borderRadius: radius.pill,
    bottom: 5,
    height: 24,
    justifyContent: 'center',
    position: 'absolute',
    right: 5,
    width: 24,
  },
  empty: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
});
