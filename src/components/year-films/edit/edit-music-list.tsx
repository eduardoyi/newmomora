// "Music" section of the Year Film edit sheet: the beds that suit the film,
// current one checked, each with a play/stop button for its bundled ~5 s
// preview.
import { Play, Square } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { RadioDot } from '@/components/year-films/edit/edit-quote-list';
import { colors, fonts, radius } from '@/constants/theme';
import type { YearFilmBed } from '@/utils/year-film-beds';

interface EditMusicListProps {
  beds: readonly YearFilmBed[];
  selectedBedId: string | null;
  playingBedId: string | null;
  onSelect: (bedId: string) => void;
  onTogglePreview: (bed: YearFilmBed) => void;
}

export function EditMusicList({ beds, selectedBedId, playingBedId, onSelect, onTogglePreview }: EditMusicListProps) {
  return (
    <View style={styles.list} testID="film-edit-music-list">
      {beds.map((bed) => {
        const isSelected = bed.id === selectedBedId;
        const isPlaying = bed.id === playingBedId;
        return (
          <View key={bed.id} style={[styles.row, isSelected && styles.rowSelected]}>
            <Pressable
              accessibilityLabel={bed.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: isSelected }}
              onPress={() => onSelect(bed.id)}
              style={({ pressed }) => [styles.select, pressed && styles.pressed]}
              testID={`film-edit-bed-${bed.id}`}
            >
              <RadioDot selected={isSelected} />
              <Text style={styles.label}>{bed.label}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={isPlaying ? `Stop ${bed.label} preview` : `Play ${bed.label} preview`}
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => onTogglePreview(bed)}
              style={({ pressed }) => [styles.preview, pressed && styles.pressed]}
              testID={`film-edit-bed-preview-${bed.id}`}
            >
              {isPlaying ? (
                <Square color={colors.primary} fill={colors.primary} size={14} />
              ) : (
                <Play color={colors.primary} fill={colors.primary} size={15} />
              )}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: 'transparent',
    borderRadius: radius.md,
    borderWidth: 1.5,
    flexDirection: 'row',
    minHeight: 52,
  },
  rowSelected: { backgroundColor: colors.primaryTint, borderColor: colors.primary },
  select: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 12, minHeight: 52, paddingLeft: 12 },
  pressed: { opacity: 0.8 },
  label: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14.5 },
  preview: { alignItems: 'center', height: 48, justifyContent: 'center', width: 52 },
});
