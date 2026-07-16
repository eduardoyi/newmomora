import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';

export function ContentHiddenNotice({
  label = 'Reported content hidden',
  onShow,
  testID,
  style,
}: {
  label?: string;
  onShow: () => void;
  testID: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.notice, style]} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityLabel={`${label}. Show anyway`}
        accessibilityRole="button"
        onPress={onShow}
        style={styles.showButton}
        testID={`${testID}-show`}
      >
        <Text style={styles.show}>Show anyway</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.xs,
    justifyContent: 'center',
    minHeight: 96,
    padding: spacing.lg,
  },
  label: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 14 },
  show: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13 },
  showButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.md },
});
