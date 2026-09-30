// Download progress + Cancel for a share started mid-film (the top-bar Share
// button). The film is already paused; this covers the picture while the MP4
// (25-65 MB) downloads. The end-of-film overlay renders the same testIDs in
// FilmCompletion, and the two never show together (the route renders this one
// only while the film is not complete).
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { shareProgressLabel } from '@/components/year-films/player/film-completion';
import { fonts } from '@/constants/theme';

const CREAM = '#F6F1E7';

interface FilmShareProgressProps {
  progress: number;
  onCancel: () => void;
}

export function FilmShareProgress({ progress, onCancel }: FilmShareProgressProps) {
  return (
    <View style={styles.overlay} testID="year-film-share-overlay">
      <ActivityIndicator color={CREAM} />
      <Text accessibilityLiveRegion="polite" style={styles.label} testID="year-film-share-progress">
        {shareProgressLabel(progress)}
      </Text>
      <Pressable
        accessibilityLabel="Cancel"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onCancel}
        style={styles.cancel}
        testID="year-film-share-cancel"
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(31,20,40,0.6)',
    gap: 14,
    justifyContent: 'center',
    paddingHorizontal: 34,
  },
  label: { color: CREAM, fontFamily: fonts.sansMedium, fontSize: 14 },
  cancel: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 18 },
  cancelText: { color: 'rgba(246,241,231,0.8)', fontFamily: fonts.sansBold, fontSize: 13 },
});
