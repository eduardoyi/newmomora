import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { roleLabel } from '@/utils/roles';

const ROLE_EXPLANATION =
  'Managers can add memories, edit anything, and invite family. Viewers can browse, like, and comment.';

export interface MemberActionSheetProps {
  visible: boolean;
  memberName: string;
  memberRole: 'owner' | 'manager' | 'viewer';
  onPromote: () => void;
  onDemote: () => void;
  onRemove: () => void;
  onReport?: () => void;
  onToggleBlock?: () => void;
  isBlocked?: boolean;
  showManagementActions?: boolean;
  /** Name of the person this account is linked to ("this is me"), when linked. */
  linkedPersonName?: string | null;
  /** Owner/manager link actions (docs/plans/manager-account-linking.md). "Link to a person…" shows when unlinked, "Change person…" + "Unlink person" when linked. */
  onLinkPerson?: () => void;
  onChangePerson?: () => void;
  onUnlinkPerson?: () => void;
  onClose: () => void;
}

/**
 * Member action menu for the Settings family member list. An in-house
 * bottom-sheet modal (same Modal + backdrop shape as FamilyRosterSheet)
 * rather than ActionSheetIOS/Alert, so each option carries a stable Maestro
 * testID and the role-change tap stays "confirm-free but informed" per
 * docs/features/family-sharing.md's member-management section: the
 * explanation is always visible, promote/demote applies on a single tap,
 * removal routes to a separate destructive Alert confirmation.
 */
export function MemberActionSheet({
  visible,
  memberName,
  memberRole,
  onPromote,
  onDemote,
  onRemove,
  onReport,
  onToggleBlock,
  isBlocked = false,
  showManagementActions = true,
  linkedPersonName = null,
  onLinkPerson,
  onChangePerson,
  onUnlinkPerson,
  onClose,
}: MemberActionSheetProps) {
  const insets = useSafeAreaInsets();
  const isManager = memberRole === 'manager';
  const roleActionLabel = isManager ? 'Make viewer' : 'Make manager';
  const roleActionTestID = isManager ? 'member-action-demote' : 'member-action-promote';
  const handleRoleAction = isManager ? onDemote : onPromote;
  const hasLinkActions = Boolean(onLinkPerson || onChangePerson || onUnlinkPerson);

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
          <View style={styles.header}>
            <Text style={styles.name}>{memberName}</Text>
            <Text style={styles.roleLine}>{roleLabel(memberRole)}</Text>
            {linkedPersonName ? (
              <Text style={styles.roleLine} testID="member-action-linked-person">This is {linkedPersonName}</Text>
            ) : null}
          </View>
          {hasLinkActions ? (
            <>
              <View style={[styles.divider, styles.linkTopDivider]} />
              {onLinkPerson ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={onLinkPerson}
                  style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
                  testID="member-action-link"
                >
                  <Text style={styles.optionText}>Link to a person…</Text>
                </Pressable>
              ) : null}
              {onChangePerson ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={onChangePerson}
                  style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
                  testID="member-action-change-person"
                >
                  <Text style={styles.optionText}>Change person…</Text>
                </Pressable>
              ) : null}
              {onUnlinkPerson ? (
                <>
                  <View style={styles.divider} />
                  <Pressable
                    accessibilityRole="button"
                    onPress={onUnlinkPerson}
                    style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
                    testID="member-action-unlink-person"
                  >
                    <Text style={styles.optionText}>Unlink person</Text>
                  </Pressable>
                </>
              ) : null}
            </>
          ) : null}
          {showManagementActions ? (
            <>
              {hasLinkActions ? <View style={styles.divider} /> : null}
              <Text style={styles.explanation}>{ROLE_EXPLANATION}</Text>
              <View style={styles.divider} />
              <Pressable
                accessibilityRole="button"
                onPress={handleRoleAction}
                style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
                testID={roleActionTestID}
              >
                <Text style={styles.optionText}>{roleActionLabel}</Text>
              </Pressable>
              <View style={styles.divider} />
              <Pressable
                accessibilityRole="button"
                onPress={onRemove}
                style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
                testID="member-action-remove"
              >
                <Text style={[styles.optionText, styles.destructiveText]}>Remove from family</Text>
              </Pressable>
            </>
          ) : null}
          {onToggleBlock ? (
            <>
              <View style={styles.divider} />
              <Pressable
                accessibilityLabel={isBlocked ? `Unblock account ${memberName}` : `Block account ${memberName}`}
                accessibilityRole="button"
                onPress={onToggleBlock}
                style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
                testID="member-action-toggle-block"
              >
                <Text style={styles.optionText}>{isBlocked ? 'Unblock account' : 'Block account'}</Text>
                <Text style={styles.optionSubtitle}>Hide their memories, comments, and activity alerts in this family.</Text>
              </Pressable>
            </>
          ) : null}
          {onReport ? (
            <>
              <View style={styles.divider} />
              <Pressable
                accessibilityLabel={`Report ${memberName}`}
                accessibilityRole="button"
                onPress={onReport}
                style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
                testID="member-action-report"
              >
                <Text style={[styles.optionText, styles.destructiveText]}>Report account</Text>
              </Pressable>
            </>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.cancelCard, pressed && styles.optionPressed]}
          testID="member-action-cancel"
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
  header: {
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  name: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 15,
  },
  roleLine: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 12.5,
  },
  explanation: {
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 12.5,
    lineHeight: 17,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    textAlign: 'center',
  },
  divider: {
    backgroundColor: colors.border,
    height: 1,
  },
  linkTopDivider: {
    marginTop: spacing.md,
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
  destructiveText: {
    color: colors.error,
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
