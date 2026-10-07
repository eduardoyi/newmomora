// The round 36px filter button (docs/plans/keepsakes-redesign.md C2/D2): in the
// "Your keepsakes" header for owners and managers, in the page header for
// viewers. A raspberry dot with a count shows how many of the sheet's fields
// (type + year) are set.
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';

export interface KeepsakesFilterButtonProps {
  /** How many of the sheet's fields are set; the dot shows at 1 or more. */
  activeCount: number;
  onPress: () => void;
}

export function KeepsakesFilterButton({ activeCount, onPress }: KeepsakesFilterButtonProps) {
  return (
    <Pressable
      accessibilityLabel={activeCount > 0 ? `Filter, ${activeCount} active` : 'Filter'}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      testID="keepsakes-filter-button"
    >
      <SymbolView
        fallback={<Text style={styles.fallback}>≡</Text>}
        name={{ ios: 'line.3.horizontal.decrease', android: 'filter_list' }}
        size={16}
        tintColor={colors.ink2}
      />
      {activeCount > 0 ? (
        <View style={styles.dot} testID="keepsakes-filter-dot">
          <Text style={styles.dotText}>{activeCount}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  pressed: { opacity: 0.8 },
  fallback: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 16 },
  dot: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderColor: colors.white,
    borderRadius: 8,
    borderWidth: 1.5,
    height: 16,
    justifyContent: 'center',
    minWidth: 16,
    position: 'absolute',
    right: -3,
    top: -3,
  },
  dotText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 9.5, lineHeight: 12 },
});
