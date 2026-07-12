import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';

/**
 * Shared row/block chrome for Settings-style lists -- originally local to
 * `app/(app)/(tabs)/settings.tsx`, extracted so `app/(app)/sharing/members.tsx`
 * (the Family members screen) can render the exact same row look for the
 * member list it took over from Settings' FamilySection. See
 * docs/features/family-sharing.md's member-management section.
 */
export function SettingsBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <Text style={styles.blockTitle}>{title}</Text>
      <View style={styles.block}>{children}</View>
    </View>
  );
}

export interface SettingsRowProps {
  label: string;
  caption?: string;
  value?: string;
  chevron?: boolean;
  right?: ReactNode;
  first?: boolean;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}

export function SettingsRow({
  label,
  caption,
  value,
  chevron,
  right,
  first,
  onPress,
  testID,
  accessibilityLabel,
}: SettingsRowProps) {
  const content = (
    <>
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{label}</Text>
        {caption && <Text style={styles.rowCaption}>{caption}</Text>}
      </View>
      {value && <Text style={styles.rowValue}>{value}</Text>}
      {right}
      {chevron && <Text style={styles.chevron}>›</Text>}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.row, !first && styles.rowBorder, pressed && styles.rowPressed]}
        testID={testID}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View style={[styles.row, !first && styles.rowBorder]} testID={testID}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  blockTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
    marginBottom: 10,
  },
  block: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowPressed: {
    backgroundColor: colors.surface,
  },
  rowContent: {
    flex: 1,
  },
  rowLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 14.5,
    color: colors.ink,
  },
  rowCaption: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.ink3,
    marginTop: 3,
  },
  rowValue: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  chevron: {
    fontSize: 18,
    color: colors.ink3,
    fontWeight: '300',
  },
});
