import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';
import { formatArtworkMedium } from '@/utils/artwork-medium';

// Replaces the emotion chip on artwork memories (docs/plans/artwork-scanning.md
// decision 3): the AI-suggested medium when analysis has produced one, else a
// neutral "Artwork" badge (same look as the Photo/Video badge). Shared by the
// Timeline card footer and the detail meta footer.
export function ArtworkMediumTag({ medium }: { medium: string | null | undefined }) {
  const label = formatArtworkMedium(medium);
  if (label) {
    return (
      <View style={styles.chip} testID="artwork-medium-chip">
        <Text style={styles.chipLabel}>{label}</Text>
      </View>
    );
  }

  return (
    <View style={styles.badge} testID="artwork-badge">
      <Text style={styles.badgeText}>Artwork</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  chipLabel: {
    color: colors.ink2,
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 0.02 * 10.5,
  },
  // Mirrors memory-card.tsx's `mediaBadge` so the fallback matches the
  // Photo/Video badge it stands in for.
  badge: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  badgeText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 11,
  },
});
