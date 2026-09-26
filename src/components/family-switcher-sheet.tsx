import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { FamilyMembershipSummary } from '@/hooks/use-family';
import { roleLabel } from '@/utils/roles';

export interface FamilySwitcherSheetProps {
  visible: boolean;
  memberships: FamilyMembershipSummary[];
  activeFamilyId: string | null;
  onSelect: (familyId: string) => void;
  onJoin: () => void;
  onManage: () => void;
  onClose: () => void;
}

/**
 * Opened from the "Switch" link on Settings' family row. Groups everything
 * about *which* families you belong to -- switching, joining another with an
 * invite code, and creating/deleting journals -- so the main Settings Family
 * block only has to cover the active family. Same Modal + backdrop shape as
 * MemberActionSheet.
 */
export function FamilySwitcherSheet({
  visible,
  memberships,
  activeFamilyId,
  onSelect,
  onJoin,
  onManage,
  onClose,
}: FamilySwitcherSheetProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View
        pointerEvents="box-none"
        style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
      >
        <View style={styles.card}>
          <Text style={styles.title}>Your families</Text>
          <ScrollView style={styles.list}>
            {memberships.map((membership) => {
              const isActive = membership.familyId === activeFamilyId;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  key={membership.familyId}
                  onPress={() => onSelect(membership.familyId)}
                  style={({ pressed }) => [styles.familyRow, pressed && styles.optionPressed]}
                  testID={`family-switcher-option-${membership.familyId}`}
                >
                  <View style={styles.familyContent}>
                    <Text style={[styles.familyName, isActive && styles.familyNameActive]}>
                      {membership.name}
                    </Text>
                    <Text style={styles.familyRole}>{roleLabel(membership.role)}</Text>
                  </View>
                  {isActive ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="button"
            onPress={onJoin}
            style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
            testID="family-switcher-join"
          >
            <Text style={styles.optionText}>Join another family</Text>
            <Text style={styles.optionSubtitle}>Use an invite code from another family.</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="button"
            onPress={onManage}
            style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
            testID="family-switcher-manage"
          >
            <Text style={styles.optionText}>Manage families</Text>
            <Text style={styles.optionSubtitle}>Create a new family journal or delete one you own.</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.cancelCard, pressed && styles.optionPressed]}
          testID="family-switcher-cancel"
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44, 36, 24, 0.4)',
  },
  wrap: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.md,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  title: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  list: {
    maxHeight: 280,
  },
  familyRow: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  familyContent: {
    flex: 1,
  },
  familyName: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 15,
  },
  familyNameActive: {
    color: colors.primary,
  },
  familyRole: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: 2,
  },
  check: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
  divider: {
    backgroundColor: colors.border,
    height: 1,
  },
  optionRow: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  optionPressed: {
    backgroundColor: colors.surface,
  },
  optionText: {
    color: colors.primary,
    fontFamily: fonts.sansMedium,
    fontSize: 16,
  },
  optionSubtitle: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 3,
    paddingHorizontal: spacing.md,
    textAlign: 'center',
  },
  cancelCard: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    marginTop: spacing.sm,
    paddingVertical: 14,
  },
  cancelText: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
});
