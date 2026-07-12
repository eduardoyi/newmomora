import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MemberActionSheet } from '@/components/member-action-sheet';
import { SettingsBlock, SettingsRow } from '@/components/settings-row';
import { colors, fonts, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
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
 * the same read-only list, just without the invite affordance or any
 * actionable rows (`canManageMember` already excludes them).
 */
export default function FamilyMembersScreen() {
  const { user } = useAuth();
  const { family, familyId, role } = useFamily();
  const { profiles } = useFamilyMemberProfiles(familyId);
  const { changeRole, removeMember: removeMemberMutation } = useMemberManagement(familyId);
  const canInvite = canEditFamilyContent(role);

  const [manageTarget, setManageTarget] = useState<FamilyMemberProfile | null>(null);

  const activeMemberCount = profiles.filter((profile) => profile.is_active_member).length;

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
            return (
              <SettingsRow
                accessibilityLabel={
                  actionable ? `Manage ${profile.name}, ${roleLabel(profile.role).toLowerCase()}` : undefined
                }
                chevron={actionable}
                first={!canInvite && index === 0}
                key={profile.user_id}
                label={profile.name}
                onPress={actionable ? () => setManageTarget(profile) : undefined}
                testID={`member-row-${profile.user_id}`}
                value={profile.is_active_member ? roleLabel(profile.role) : 'Former member'}
              />
            );
          })}
        </SettingsBlock>

        <MemberActionSheet
          memberName={manageTarget?.name ?? ''}
          memberRole={manageTarget?.role === 'manager' ? 'manager' : 'viewer'}
          onClose={() => setManageTarget(null)}
          onDemote={() => manageTarget && applyRoleChange(manageTarget, 'viewer')}
          onPromote={() => manageTarget && applyRoleChange(manageTarget, 'manager')}
          onRemove={() => manageTarget && handleRequestRemove(manageTarget)}
          visible={Boolean(manageTarget)}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.bg,
    flex: 1,
  },
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
