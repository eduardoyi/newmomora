import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MemberActionSheet } from '@/components/member-action-sheet';
import { ReportSheet } from '@/components/report-sheet';
import { SettingsBlock, SettingsRow } from '@/components/settings-row';
import { colors, fonts, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useContentSafety } from '@/hooks/useContentSafety';
import { MemberChangedElsewhereError, useMemberManagement } from '@/hooks/useMemberManagement';
import { sharingInviteRoute } from '@/lib/routes';
import type { FamilyMemberProfile } from '@/services/family';
import { canEditFamilyContent, canManageMember, roleLabel } from '@/utils/roles';

/**
 * Family members list, moved out of Settings' FamilySection (which used to
 * render every member inline and grew unboundedly for large families -- up
 * to 50 members per family, see docs/features/family-sharing.md). Same row
 * rendering, roles, and tap-to-manage action sheet as before; Settings now
 * only links here with a member count. Visible to every role -- viewers get
 * no invite or role-management affordances, but every active role can use
 * the separate Report and Block account safety actions.
 */
export default function FamilyMembersScreen() {
  const { user } = useAuth();
  const { family, familyId, role } = useFamily();
  const { profiles } = useFamilyMemberProfiles(familyId);
  const { changeRole, removeMember: removeMemberMutation } = useMemberManagement(familyId);
  const canInvite = canEditFamilyContent(role);
  const contentSafety = useContentSafety();

  const [manageTarget, setManageTarget] = useState<FamilyMemberProfile | null>(null);
  const [reportTarget, setReportTarget] = useState<FamilyMemberProfile | null>(null);

  const activeMemberCount = profiles.filter((profile) => profile.is_active_member).length;
  const isManageTargetReported = Boolean(
    manageTarget?.membership_id &&
    contentSafety.isTargetReported('household_member', manageTarget.membership_id),
  );
  const hasManageTargetReport = Boolean(
    manageTarget?.membership_id &&
    contentSafety.hasActiveReport('household_member', manageTarget.membership_id),
  );

  const applyRoleChange = (profile: FamilyMemberProfile, nextRole: 'manager' | 'viewer') => {
    setManageTarget(null);
    void (async () => {
      try {
        await changeRole({ userId: profile.user_id, role: nextRole });
      } catch (error) {
        if (error instanceof MemberChangedElsewhereError) {
          Alert.alert('List refreshed', error.message);
          return;
        }
        Alert.alert('Could not update role', `Could not change ${profile.name}'s role. Please try again.`);
      }
    })();
  };

  const handleRequestRemove = (profile: FamilyMemberProfile) => {
    setManageTarget(null);
    Alert.alert(
      'Remove from family',
      `${profile.name} will no longer be able to see the family journal. Memories and photos they added will stay.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeMemberMutation(profile.user_id);
              } catch (error) {
                if (error instanceof MemberChangedElsewhereError) {
                  Alert.alert('List refreshed', error.message);
                  return;
                }
                Alert.alert('Could not remove member', `Could not remove ${profile.name}. Please try again.`);
              }
            })();
          },
        },
      ],
    );
  };

  if (contentSafety.isLoading) {
    return (
      <SafeAreaView style={styles.centered} testID="sharing-members-safety-loading">
        <ActivityIndicator color={colors.primary} size="large" />
      </SafeAreaView>
    );
  }

  if (contentSafety.isError) {
    return (
      <SafeAreaView style={styles.centered} testID="sharing-members-safety-error">
        <Text style={styles.errorText}>Couldn’t load family members</Text>
        <Pressable accessibilityRole="button" onPress={() => void contentSafety.refetch()}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
            testID="sharing-members-back"
          >
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
          <Text style={styles.title}>Family members</Text>
          <Text style={styles.subtitle}>
            {activeMemberCount} {activeMemberCount === 1 ? 'person has' : 'people have'} access to{' '}
            {family?.name ?? 'this family'}.
          </Text>
        </View>

        <SettingsBlock title="Members">
          {canInvite && (
            <SettingsRow
              chevron
              first
              label="Invite a family member"
              onPress={() => router.push(sharingInviteRoute)}
              testID="members-invite-family-member"
            />
          )}
          {profiles.map((profile, index) => {
            const actionable = canManageMember(role, user?.id, profile);
            const isBlocked = Boolean(contentSafety.getBlockForUser(profile.user_id));
            const hasSafetyActions = Boolean(
              profile.user_id !== user?.id && (
                (profile.is_active_member && profile.membership_id) || isBlocked
              ),
            );
            const isReported = profile.membership_id
              ? contentSafety.isTargetReported('household_member', profile.membership_id)
              : false;
            return (
              <SettingsRow
                accessibilityLabel={
                  actionable || hasSafetyActions
                    ? `${actionable ? 'Manage' : 'Account actions for'} ${isReported ? 'reported household account' : profile.name}`
                    : undefined
                }
                chevron={actionable || hasSafetyActions}
                first={!canInvite && index === 0}
                key={profile.user_id}
                label={isReported ? 'Reported household account' : profile.name}
                onPress={actionable || hasSafetyActions ? () => setManageTarget(profile) : undefined}
                testID={`member-row-${profile.user_id}`}
                value={isBlocked ? 'Blocked' : profile.is_active_member ? roleLabel(profile.role) : 'Former member'}
              />
            );
          })}
        </SettingsBlock>

        <MemberActionSheet
          memberName={isManageTargetReported ? 'Reported household account' : manageTarget?.name ?? ''}
          memberRole={manageTarget?.role === 'owner' ? 'owner' : manageTarget?.role === 'manager' ? 'manager' : 'viewer'}
          onClose={() => setManageTarget(null)}
          onDemote={() => manageTarget && applyRoleChange(manageTarget, 'viewer')}
          onPromote={() => manageTarget && applyRoleChange(manageTarget, 'manager')}
          onRemove={() => manageTarget && handleRequestRemove(manageTarget)}
          onReport={manageTarget?.membership_id && !hasManageTargetReport ? () => {
            setManageTarget(null);
            setReportTarget(manageTarget);
          } : undefined}
          onToggleBlock={manageTarget && (
            manageTarget.membership_id || contentSafety.getBlockForUser(manageTarget.user_id)
          ) ? () => {
            const target = manageTarget;
            const existingBlock = contentSafety.getBlockForUser(target.user_id);
            setManageTarget(null);
            void contentSafety.setAccountBlocked(existingBlock
              ? { shouldBlock: false, blockId: existingBlock.id }
              : { shouldBlock: true, membershipId: target.membership_id! }
            ).catch(() => Alert.alert('Could not update block', 'Please try again.'));
          } : undefined}
          isBlocked={Boolean(manageTarget && contentSafety.getBlockForUser(manageTarget.user_id))}
          showManagementActions={Boolean(manageTarget && canManageMember(role, user?.id, manageTarget))}
          visible={Boolean(manageTarget)}
        />
        {reportTarget?.membership_id ? (
          <ReportSheet
            isSubmitting={contentSafety.isReporting}
            onClose={() => setReportTarget(null)}
            onSubmit={(reason, note) => contentSafety.report({
              targetType: 'household_member',
              targetId: reportTarget.membership_id!,
              reason,
              note,
            }).then(() => undefined)}
            targetLabel="account"
            targetType="household_member"
            visible
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  centered: { alignItems: 'center', backgroundColor: colors.bg, flex: 1, gap: spacing.sm, justifyContent: 'center' },
  errorText: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 15 },
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
  },
  header: {
    gap: spacing.sm,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontFamily: fonts.sansBold,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 34,
    color: colors.ink,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink3,
  },
});
