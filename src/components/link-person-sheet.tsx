import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { FamilyMember } from '@/services/family-members';
import type { MembershipLink } from '@/services/family-relationships';
import { isInviteTargetEligible } from '@/utils/family-relationships';
import { roleLabel } from '@/utils/roles';

export interface LinkSheetAccount {
  userId: string;
  name: string;
  role: string | null;
}

interface SharedProps {
  visible: boolean;
  onClose: () => void;
  /** Disables the rows while a link call is in flight. */
  isBusy?: boolean;
}

/** People-picker mode (Members screen): choose the person an account is. */
export interface LinkPersonSheetPeopleProps extends SharedProps {
  mode: 'people';
  title: string;
  members: FamilyMember[];
  /** Every account's link; people held by an account other than `accountUserId` are not offered. */
  links: readonly MembershipLink[];
  /** The account being linked. Its own current person stays offered, shown as selected. */
  accountUserId: string;
  isMemberHidden: (memberId: string) => boolean;
  onSelectPerson: (memberId: string) => void;
}

/** Accounts-picker mode (person detail): choose which joined account is this person. */
export interface LinkPersonSheetAccountsProps extends SharedProps {
  mode: 'accounts';
  title: string;
  accounts: LinkSheetAccount[];
  onSelectAccount: (userId: string) => void;
}

export type LinkPersonSheetProps = LinkPersonSheetPeopleProps | LinkPersonSheetAccountsProps;

/**
 * Bottom-sheet picker for manager-linked "this is me"
 * (docs/plans/manager-account-linking.md §4.3). Same Modal + backdrop shape as
 * MemberActionSheet / FamilyRosterSheet, with stable testIDs. No text input, so
 * no keyboard handling is needed; the bottom inset keeps the Cancel row
 * reachable above gesture / three-button navigation.
 */
export function LinkPersonSheet(props: LinkPersonSheetProps) {
  const { visible, onClose, title, isBusy = false } = props;
  const insets = useSafeAreaInsets();

  // The account's own link doesn't count as a claim: its current person stays
  // offered (and is shown as selected).
  const eligiblePeople = props.mode === 'people'
    ? props.members.filter((member) => isInviteTargetEligible(
        member,
        props.links.filter((link) => link.userId !== props.accountUserId),
        props.isMemberHidden(member.id),
      ))
    : [];

  const currentMemberId = props.mode === 'people'
    ? props.links.find((link) => link.userId === props.accountUserId)?.familyMemberId ?? null
    : null;

  const isEmpty = props.mode === 'people' ? eligiblePeople.length === 0 : props.accounts.length === 0;

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen" transparent visible={visible}>
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
          testID="link-person-sheet"
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{title}</Text>
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
            testID="link-person-list"
          >
            {props.mode === 'people'
              ? eligiblePeople.map((member) => {
                  const isSelected = member.id === currentMemberId;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected, disabled: isBusy }}
                      disabled={isBusy}
                      key={member.id}
                      onPress={() => (isSelected ? onClose() : props.onSelectPerson(member.id))}
                      style={({ pressed }) => [styles.row, isBusy && styles.rowDisabled, pressed && styles.rowPressed]}
                      testID={`link-person-option-${member.id}`}
                    >
                      <FamilyMemberAvatar member={member} size={38} />
                      <Text numberOfLines={1} style={styles.name}>{member.name}</Text>
                      <View style={[styles.checkCircle, isSelected && styles.checkCircleSelected]}>
                        {isSelected ? <Text style={styles.checkMark}>✓</Text> : null}
                      </View>
                    </Pressable>
                  );
                })
              : props.accounts.map((account) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: isBusy }}
                    disabled={isBusy}
                    key={account.userId}
                    onPress={() => props.onSelectAccount(account.userId)}
                    style={({ pressed }) => [styles.row, isBusy && styles.rowDisabled, pressed && styles.rowPressed]}
                    testID={`link-account-option-${account.userId}`}
                  >
                    <View style={styles.initial}>
                      <Text style={styles.initialText}>{account.name.trim().charAt(0).toUpperCase() || '?'}</Text>
                    </View>
                    <View style={styles.info}>
                      <Text numberOfLines={1} style={styles.name}>{account.name.trim() || 'This family member'}</Text>
                      <Text style={styles.caption}>{roleLabel(account.role)}</Text>
                    </View>
                  </Pressable>
                ))}

            {isEmpty ? (
              <Text style={styles.emptyText} testID="link-person-empty">
                {props.mode === 'people' ? 'No one in the family list can be linked.' : 'Everyone who has joined is already linked to a person.'}
              </Text>
            ) : null}
          </ScrollView>

          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.cancelBtn, pressed && styles.rowPressed]}
            testID="link-person-cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44, 36, 24, 0.4)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '78%',
    overflow: 'hidden',
    paddingTop: spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
    height: 4,
    marginBottom: spacing.md,
    width: 36,
  },
  header: { paddingBottom: spacing.md, paddingHorizontal: spacing.lg },
  headerTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 17 },
  scroll: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  scrollContent: { paddingBottom: spacing.xs },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
  },
  rowDisabled: { opacity: 0.5 },
  rowPressed: { opacity: 0.82 },
  info: { flex: 1 },
  name: { color: colors.ink, flex: 1, fontFamily: fonts.sansBold, fontSize: 15 },
  caption: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12.5 },
  initial: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 19,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  initialText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 15 },
  checkCircle: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  checkCircleSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 12 },
  emptyText: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 14,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    textAlign: 'center',
  },
  cancelBtn: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: 14,
  },
  cancelText: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 16 },
});
