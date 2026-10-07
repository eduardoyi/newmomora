// The last tile of a year's row when it holds more than three monthly recaps
// (docs/plans/keepsakes-redesign.md C1): a small text tile that opens the
// "{year} recaps" grid -- the tidy view of every month.
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';
import { keepsakeRecapsRoute } from '@/lib/routes';

export interface AllRecapsTileProps {
  year: number;
}

export function AllRecapsTile({ year }: AllRecapsTileProps) {
  return (
    <Pressable
      accessibilityLabel={`All ${year} recaps`}
      accessibilityRole="button"
      onPress={() => router.push(keepsakeRecapsRoute(year))}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
      testID={`keepsakes-recaps-${year}`}
    >
      <Text style={styles.label}>All {year} recaps</Text>
      <SymbolView
        fallback={<Text style={styles.arrowFallback}>→</Text>}
        name={{ ios: 'arrow.right', android: 'arrow_forward' }}
        size={14}
        tintColor={colors.primary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'flex-start',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: 8,
    height: 162,
    justifyContent: 'flex-end',
    padding: 12,
    width: 110,
  },
  pressed: { opacity: 0.85 },
  label: { color: colors.primary, fontFamily: fonts.display, fontSize: 18, lineHeight: 21 },
  arrowFallback: { color: colors.primary, fontSize: 14 },
});
