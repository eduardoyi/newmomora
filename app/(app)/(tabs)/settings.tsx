import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { familyMembershipsQueryKey, useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useNotificationsRegistration } from '@/hooks/useNotifications';
import { useUserProfile } from '@/hooks/useUserProfile';
import {
  sharingApprovalsRoute,
  sharingInviteRoute,
  sharingMembersRoute,
  sharingPendingInvitesRoute,
  sharingRedeemRoute,
} from '@/lib/routes';
import { getDeviceTimezone } from '@/services/auth';
import { leaveFamily, updateFamilyName } from '@/services/family';
import { isPendingInviteActive } from '@/utils/invites';
import { canEditFamilyContent, isOwnerRole, roleLabel } from '@/utils/roles';
import { AuthField, AuthInput } from '@/components/auth-screen';
import { SelectField } from '@/components/select-field';
import { SettingsBlock, SettingsRow } from '@/components/settings-row';

function FamilySection() {
  const { user } = useAuth();
  const { family, familyId, role, memberships, setActiveFamily, refetchMemberships } = useFamily();
  const { profiles } = useFamilyMemberProfiles(familyId);
  const queryClient = useQueryClient();
  const canEditName = canEditFamilyContent(role);
  const isOwner = isOwnerRole(role);
  // Pending/approvals rows: the invites query is manager+-only under RLS, so
  // it is gated on role rather than fired (and denied) for viewers.
  const { pendingInvites, redeemedInvites, isLoading: isInvitesLoading } = useFamilyInvites(familyId, {
    enabled: canEditName,
  });

  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(family?.name ?? '');
  const [isSavingName, setIsSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const [isLeaving, setIsLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState('');

  useEffect(() => {
    if (!isEditingName) {
      setNameDraft(family?.name ?? '');
    }
  }, [family?.name, isEditingName]);

  if (!family || !familyId) {
    return null;
  }

  const handleSaveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNameError('Family name is required');
      return;
    }

    setNameError('');
    setIsSavingName(true);
    try {
      const { error } = await updateFamilyName(familyId, trimmed);
      if (error) {
        throw new Error(error.message);
      }
      await queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey });
      setIsEditingName(false);
    } catch (error) {
      setNameError(error instanceof Error ? error.message : 'Could not update family name');
    } finally {
      setIsSavingName(false);
    }
  };

  const handleLeave = () => {
    Alert.alert(
      'Leave family',
      `Leave ${family.name}? You will lose access to its memories unless you're invited back.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              if (!user) return;
              setLeaveError('');
              setIsLeaving(true);
              try {
                const { error } = await leaveFamily(familyId, user.id);
                if (error) {
                  throw new Error(error.message);
                }
                await refetchMemberships();
              } catch (error) {
                setLeaveError(error instanceof Error ? error.message : 'Could not leave family');
              } finally {
                setIsLeaving(false);
              }
            })();
          },
        },
      ],
    );
  };

  const handlePickFamily = async (nextFamilyId: string) => {
    if (nextFamilyId === familyId) {
      return;
    }
    try {
      await setActiveFamily(nextFamilyId);
    } catch {
      Alert.alert('Could not switch families', 'Please try again.');
    }
  };

  const activeMemberCount = profiles.filter((profile) => profile.is_active_member).length;
  // "Expired" pending invites (status stays 'pending' until read/redemption
  // time -- see docs/features/family-sharing.md's invite-lifecycle section)
  // shouldn't keep this row alive once there's nothing left to act on.
  const hasActivePendingInvite = pendingInvites.some((invite) => isPendingInviteActive(invite.expires_at));

  return (
    <SettingsBlock title="Family">
      {isEditingName ? (
        <View style={[styles.row, styles.familyEditRow]}>
          <View style={styles.familyEditForm}>
            <AuthInput
              autoCapitalize="words"
              onChangeText={setNameDraft}
              testID="settings-family-name-input"
              value={nameDraft}
            />
            {nameError ? <Text style={styles.familyNameError}>{nameError}</Text> : null}
            <View style={styles.familyEditActions}>
              <Pressable
                onPress={() => {
                  setIsEditingName(false);
                  setNameError('');
                  setNameDraft(family.name);
                }}
                style={styles.familyEditCancel}
                testID="settings-family-name-cancel"
              >
                <Text style={styles.familyEditCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={isSavingName}
                onPress={() => void handleSaveName()}
                style={styles.familyEditSave}
                testID="settings-family-name-save"
              >
                {isSavingName ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <Text style={styles.familyEditSaveText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      ) : (
        <SettingsRow
          first
          label={family.name}
          caption={roleLabel(role)}
          right={
            canEditName ? (
              <Pressable
                onPress={() => setIsEditingName(true)}
                testID="settings-family-name-edit"
              >
                <Text style={styles.familyEditTrigger}>Edit</Text>
              </Pressable>
            ) : undefined
          }
        />
      )}

      <SettingsRow
        chevron
        label="Family members"
        onPress={() => router.push(sharingMembersRoute)}
        testID="settings-family-members"
        value={String(activeMemberCount)}
      />

      {canEditName && (
        <SettingsRow
          chevron
          label="Invite a family member"
          onPress={() => router.push(sharingInviteRoute)}
          testID="settings-invite-family-member"
        />
      )}

      {/* While invite data is loading, simply don't render these -- no
          flicker placeholder for a count that's about to settle. */}
      {canEditName && !isInvitesLoading && hasActivePendingInvite && (
        <SettingsRow
          chevron
          label="Pending invites"
          onPress={() => router.push(sharingPendingInvitesRoute)}
          testID="settings-pending-invites"
        />
      )}

      {canEditName && !isInvitesLoading && redeemedInvites.length > 0 && (
        <SettingsRow
          chevron
          label="Approvals"
          onPress={() => router.push(sharingApprovalsRoute)}
          testID="settings-approvals"
          value={String(redeemedInvites.length)}
        />
      )}

      <SettingsRow
        chevron
        label="Join a family"
        caption="Have an invite code from another family?"
        onPress={() => router.push(sharingRedeemRoute)}
        testID="settings-join-family"
      />

      {memberships.length > 1 && (
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>Switch family</Text>
          </View>
          <SelectField
            onChange={(value) => void handlePickFamily(value)}
            options={memberships.map((membership) => ({
              value: membership.familyId,
              label: membership.name,
            }))}
            testID="settings-family-picker"
            value={familyId}
          />
        </View>
      )}

      {!isOwner && (
        <View style={[styles.row, styles.rowBorder]}>
          <Pressable
            disabled={isLeaving}
            onPress={handleLeave}
            testID="settings-leave-family"
          >
            <Text style={styles.leaveFamilyText}>
              {isLeaving ? 'Leaving…' : 'Leave family'}
            </Text>
          </Pressable>
        </View>
      )}

      {leaveError ? <Text style={styles.familyNameError}>{leaveError}</Text> : null}
    </SettingsBlock>
  );
}

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const {
    profile,
    updateProfile,
    deleteAccount,
    cancelAccountDeletion,
    isUpdating,
    isDeletingAccount,
    isCancelingDeletion,
  } = useUserProfile();

  const remindersEnabled = profile?.enable_daily_reminder ?? false;
  const newMemoryAlertsEnabled = profile?.notify_new_memories ?? true;
  useNotificationsRegistration(remindersEnabled || newMemoryAlertsEnabled);

  const handleToggleReminders = async (value: boolean) => {
    await updateProfile({
      enableDailyReminder: value,
      timezone: profile?.timezone ?? getDeviceTimezone(),
      notificationTime: profile?.notification_time ?? '20:00:00',
    });
  };

  const handleToggleNewMemoryAlerts = async (value: boolean) => {
    await updateProfile({ notifyNewMemories: value });
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Schedule account deletion?',
      'Your account and family journal will be permanently deleted in 15 days. You can cancel at any time before then.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Schedule deletion',
          style: 'destructive',
          onPress: () => void deleteAccount(),
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <SafeAreaView>
            <View style={styles.header}>
              <Text style={styles.eyebrow}>Account</Text>
              <Text style={styles.title}>Settings.</Text>
            </View>
          </SafeAreaView>
  
          {/* Identity card */}
          <View style={styles.identityCard}>
            <View style={styles.identityAvatar}>
              <Text style={styles.identityInitial}>
                {(profile?.name ?? user?.email ?? 'U').charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.identityContent}>
              <Text style={styles.identityName}>{profile?.name ?? 'You'}</Text>
              <Text style={styles.identityEmail}>{user?.email ?? ''}</Text>
            </View>
            <Pressable style={styles.identityEdit}>
              <Text style={styles.identityEditIcon}>✎</Text>
            </Pressable>
          </View>
  
          {/* Display name */}
          <View style={styles.section}>
            <AuthField label="Display name">
              <AuthInput
                autoCapitalize="words"
                onChangeText={(name) => void updateProfile({ name })}
                placeholder="Your name"
                testID="settings-display-name"
                value={profile?.name ?? ''}
              />
            </AuthField>
          </View>
  
          <View style={styles.sections}>
            <SettingsBlock title="Notifications">
              <SettingsRow
                first
                label="Remind me to journal"
                caption="Get a gentle nudge to capture a moment."
                right={
                  <Switch
                    onValueChange={handleToggleReminders}
                    testID="settings-daily-reminder-toggle"
                    value={remindersEnabled}
                    trackColor={{ false: colors.border, true: colors.primary }}
                  />
                }
              />
              {remindersEnabled && (
                <SettingsRow
                  label="Reminder time"
                  value={(profile?.notification_time ?? '20:00:00').slice(0, 5)}
                  chevron
                />
              )}
              <SettingsRow
                label="New memory alerts"
                caption="Get notified when a family member adds a memory."
                right={
                  <Switch
                    onValueChange={handleToggleNewMemoryAlerts}
                    testID="settings-new-memory-alerts-toggle"
                    value={newMemoryAlertsEnabled}
                    trackColor={{ false: colors.border, true: colors.primary }}
                  />
                }
              />
            </SettingsBlock>
  
            <FamilySection />
  
            <SettingsBlock title="Privacy">
              <SettingsRow first label="Private storage" caption="Your moments live in your account only." />
              <SettingsRow label="Export data" chevron />
            </SettingsBlock>
  
            <SettingsBlock title="Help">
              <SettingsRow first label="How illustrations work" chevron />
              <SettingsRow label="Send feedback" chevron />
              <SettingsRow label="Privacy policy" chevron />
            </SettingsBlock>
  
            {/* Account deletion banner */}
            {profile?.deleted_at ? (
              <View style={styles.deletionBanner}>
                <Text style={styles.deletionTitle}>Account scheduled for deletion</Text>
                <Text style={styles.deletionBody}>
                  Hard delete on {profile.scheduled_hard_delete_at?.slice(0, 10) ?? 'soon'}.
                </Text>
                <Pressable
                  onPress={() => void cancelAccountDeletion()}
                  disabled={isCancelingDeletion}
                  style={styles.cancelDeletionBtn}
                  testID="settings-cancel-deletion"
                >
                  <Text style={styles.cancelDeletionText}>
                    {isCancelingDeletion ? 'Canceling…' : 'Cancel deletion'}
                  </Text>
                </Pressable>
              </View>
            ) : null}
  
            {/* Actions */}
            <View style={styles.actions}>
              <Pressable
                onPress={() => signOut()}
                style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.8 }]}
                testID="settings-sign-out-button"
              >
                <Text style={styles.signOutText}>Sign out</Text>
              </Pressable>
  
              {!profile?.deleted_at && (
                <Pressable
                  onPress={handleDeleteAccount}
                  disabled={isDeletingAccount || isUpdating}
                  testID="settings-delete-account"
                >
                  <Text style={styles.deleteText}>
                    {isDeletingAccount ? 'Scheduling deletion…' : 'Delete account'}
                  </Text>
                </Pressable>
              )}
            </View>
  
            <Text style={styles.version}>Momora · v1.0</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    paddingBottom: 130,
  },
  header: {
    paddingTop: 16,
    paddingHorizontal: spacing.lg,
    gap: 6,
  },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 42,
    lineHeight: 42,
    color: colors.ink,
    marginBottom: spacing.lg,
  },
  identityCard: {
    marginHorizontal: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  identityAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityInitial: {
    fontFamily: fonts.displayMedium,
    fontSize: 24,
    color: colors.primaryDark,
  },
  identityContent: {
    flex: 1,
  },
  identityName: {
    fontFamily: fonts.displayMedium,
    fontSize: 18,
    color: colors.ink,
  },
  identityEmail: {
    fontFamily: 'SpaceMono',
    fontSize: 12.5,
    color: colors.ink3,
  },
  identityEdit: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityEditIcon: {
    fontSize: 15,
    color: colors.ink2,
  },
  section: {
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
  },
  sections: {
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
    gap: 24,
  },
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
  familyEditTrigger: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
  },
  familyEditRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  familyEditForm: {
    flex: 1,
    gap: spacing.sm,
  },
  familyEditActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  familyEditCancel: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  familyEditCancelText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink3,
  },
  familyEditSave: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
  },
  familyEditSaveText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.white,
  },
  familyNameError: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.error,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  leaveFamilyText: {
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
    color: colors.error,
  },
  deletionBanner: {
    backgroundColor: colors.errorSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.error + '40',
    padding: spacing.md,
    gap: spacing.sm,
  },
  deletionTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.error,
  },
  deletionBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink2,
  },
  cancelDeletionBtn: {
    alignSelf: 'flex-start',
  },
  cancelDeletionText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
  },
  actions: {
    gap: 10,
    alignItems: 'flex-start',
  },
  signOutBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  signOutText: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    color: colors.ink,
  },
  deleteText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.error,
    paddingVertical: spacing.sm,
  },
  version: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'center',
    marginTop: 8,
  },
});
