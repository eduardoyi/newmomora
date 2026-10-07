// The slim "needs you" line at the top of the Keepsakes tab
// (docs/plans/keepsakes-redesign.md C4). One line, only when the user must
// act; not dismissable -- it clears itself once handled. The tab decides what
// a tap does (the shop for a card, the retry sheet for a failed book).
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';

export interface NeedsYouBannerProps {
  label: string;
  onPress: () => void;
}

export function NeedsYouBanner({ label, onPress }: NeedsYouBannerProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
      testID="keepsakes-needs-you"
    >
      <View style={styles.dot} />
      <Text ellipsizeMode="tail" numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      <SymbolView
        fallback={<Text style={styles.chevronFallback}>›</Text>}
        name={{ ios: 'chevron.right', android: 'chevron_right' }}
        size={14}
        tintColor={colors.primary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: 'center',
    backgroundColor: colors.primaryTint,
    borderColor: colors.primarySoft,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    height: 46,
    marginHorizontal: 20,
    marginTop: 16,
    paddingHorizontal: 14,
  },
  pressed: { opacity: 0.85 },
  dot: { backgroundColor: colors.primary, borderRadius: 4, height: 8, width: 8 },
  label: { color: colors.ink, flex: 1, fontFamily: fonts.sansBold, fontSize: 13.5 },
  chevronFallback: { color: colors.primary, fontSize: 20, lineHeight: 22 },
});
