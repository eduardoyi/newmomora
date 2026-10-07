// The small status pill under a shelf object (docs/plans/keepsakes-redesign.md
// C1): raspberry (`needsYou`) means waiting on you, lavender (`progress`)
// means the family's keepsake is on its way. A dot, then the label.
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';
import type { KeepsakeBadgeData } from '@/utils/keepsakes';

export interface KeepsakeBadgeProps extends KeepsakeBadgeData {
  testID?: string;
}

export function KeepsakeBadge({ label, tone, testID }: KeepsakeBadgeProps) {
  const isNeedsYou = tone === 'needsYou';
  return (
    <View
      accessibilityLabel={label}
      style={[styles.pill, isNeedsYou ? styles.pillNeedsYou : styles.pillProgress]}
      testID={testID}
    >
      <View style={[styles.dot, isNeedsYou ? styles.dotNeedsYou : styles.dotProgress]} />
      <Text numberOfLines={1} style={[styles.label, isNeedsYou ? styles.labelNeedsYou : styles.labelProgress]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: 5,
    height: 22,
    maxWidth: '100%',
    paddingHorizontal: 8,
  },
  pillNeedsYou: { backgroundColor: colors.primaryTint },
  pillProgress: { backgroundColor: colors.surface2 },
  dot: { borderRadius: 3, height: 6, width: 6 },
  dotNeedsYou: { backgroundColor: colors.primary },
  dotProgress: { backgroundColor: colors.ink3 },
  label: { flexShrink: 1, fontFamily: fonts.sansBold, fontSize: 11 },
  labelNeedsYou: { color: colors.primaryDark },
  labelProgress: { color: colors.ink2 },
});
