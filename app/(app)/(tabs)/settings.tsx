import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
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
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useNotificationsRegistration } from '@/hooks/useNotifications';
import { useUserProfile } from '@/hooks/useUserProfile';
import {
  familySettingsRoute,
  sharingInviteRoute,
  sharingManageRoute,
  sharingMembersRoute,
  sharingRedeemRoute,
  widgetSetupRoute,
} from '@/lib/routes';
import { getDeviceTimezone } from '@/services/auth';
import { requestDataExport } from '@/services/export';
import { leaveFamily } from '@/services/family';
import { clearPersistedQueryCache } from '@/lib/query-persistence';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { canEditFamilyContent, isOwnerRole, isViewerRole, roleLabel } from '@/utils/roles';
import { AuthInput } from '@/components/auth-screen';
import { FamilySwitcherSheet } from '@/components/family-switcher-sheet';
import { SelectField, type SelectOption } from '@/components/select-field';
import { SettingsBlock, SettingsRow } from '@/components/settings-row';
import { GalleryImportSettingsRow } from '@/components/gallery-import/gallery-import-settings';
import { clearMemoryWidgetForScope } from '@/hooks/useMemoryWidgetSync';

const DEFAULT_REMINDER_TIME = '20:00:00';
const FAQ_URL = 'https://usemomora.com/faq/';
const PRIVACY_POLICY_URL = 'https://usemomora.com/privacy-policy/';
const TERMS_OF_SERVICE_URL = 'https://usemomora.com/terms-of-service/';
const SUPPORT_EMAIL_URL = 'mailto:hello@usemomora.com';
const APP_VERSION = Constants.expoConfig?.version ?? '1.2.0';

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof error.message === 'string'
    && error.message
  ) {
    return error.message;
  }
  return fallback;
}

// Backend cron only honors the hour (see parseNotificationHour in
// schedule-daily-reminders), so the picker is hour-granularity only.
function formatReminderHourLabel(hour: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:00 ${period}`;
}

const REMINDER_TIME_OPTIONS: SelectOption[] = Array.from({ length: 24 }, (_, hour) => ({
  value: `${String(hour).padStart(2, '0')}:00:00`,
  label: formatReminderHourLabel(hour),
}));

function normalizeReminderTime(notificationTime: string | null | undefined): string {
  const hour = (notificationTime ?? DEFAULT_REMINDER_TIME).slice(0, 2);
  return `${hour}:00:00`;
}

/**
 * Settings' Family block covers only the *active* family's people: who is in
 * it, inviting more, and (for owners/managers) a link to the family-wide
 * rules on app/(app)/family-settings.tsx. Everything about *which* families
 * you belong to -- switching, joining, creating/deleting -- lives behind the
 * "Switch" link in FamilySwitcherSheet. Pending invites and approvals live on
 * the members screen; the Members row just surfaces the approvals count.
 */
function FamilySection() {
  const { user } = useAuth();
  const { family, familyId, role, memberships, setActiveFamily, refetchMemberships } = useFamily();
  const { profiles } = useFamilyMemberProfiles(familyId);
  const canManage = canEditFamilyContent(role);
  const isOwner = isOwnerRole(role);
  // The invites query is manager+-only under RLS, so it is gated on role
  // rather than fired (and denied) for viewers.
  const { redeemedInvites, isLoading: isInvitesLoading } = useFamilyInvites(familyId, {
    enabled: canManage,
  });

  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState('');

  if (!family || !familyId) {
    return null;
  }

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
                await clearMemoryWidgetForScope({ accountId: user.id, familyId }).catch(() => undefined);
                // Purge the persisted cache before refetching memberships --
                // a device handed to another user, or this user re-invited
                // later, must never cold-boot into memories from a family
                // they just left (docs/plans/offline-awareness-and-share-cards.md
                // O4).
                await clearPersistedQueryCache();
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
    setIsSwitcherOpen(false);
    if (nextFamilyId === familyId) {
      return;
    }
    try {
      await setActiveFamily(nextFamilyId);
    } catch {
      Alert.alert('Could not switch families', 'Please try again.');
    }
  };

  const openFromSwitcher = (route: typeof sharingRedeemRoute) => {
    setIsSwitcherOpen(false);
    router.push(route);
  };

  const activeMemberCount = profiles.filter((profile) => profile.is_active_member).length;
  const waitingCount = canManage && !isInvitesLoading ? redeemedInvites.length : 0;

  return (
    <SettingsBlock title="Family">
      <SettingsRow
        first
        label={family.name}
        caption={roleLabel(role)}
        right={
          <Pressable
            accessibilityRole="button"
            onPress={() => setIsSwitcherOpen(true)}
            testID="settings-family-switch"
          >
            <Text style={styles.linkText}>{memberships.length > 1 ? 'Switch' : 'Families'}</Text>
          </Pressable>
        }
      />

      <SettingsRow
        chevron
        label="Members"
        caption={waitingCount > 0 ? `${waitingCount} waiting for approval` : undefined}
        onPress={() => router.push(sharingMembersRoute)}
        testID="settings-family-members"
        value={String(activeMemberCount)}
      />

      {canManage && (
        <SettingsRow
          chevron
          label="Invite someone"
          onPress={() => router.push(sharingInviteRoute)}
          testID="settings-invite-family-member"
        />
      )}

      {canManage && (
        <SettingsRow
          chevron
          label="Family settings"
          caption={isOwner ? 'Name, sharing, and photo captions' : 'Name and sharing'}
          onPress={() => router.push(familySettingsRoute)}
          testID="settings-family-settings"
        />
      )}

      {!isOwner && (
        <SettingsRow
          destructive
          label={isLeaving ? 'Leaving…' : 'Leave family'}
          onPress={isLeaving ? undefined : handleLeave}
          testID="settings-leave-family"
        />
      )}

      {leaveError ? <Text style={styles.errorText}>{leaveError}</Text> : null}

      <FamilySwitcherSheet
        activeFamilyId={familyId}
        memberships={memberships}
        onClose={() => setIsSwitcherOpen(false)}
        onJoin={() => openFromSwitcher(sharingRedeemRoute)}
        onManage={() => openFromSwitcher(sharingManageRoute)}
        onSelect={(nextFamilyId) => void handlePickFamily(nextFamilyId)}
        visible={isSwitcherOpen}
      />
    </SettingsBlock>
  );
}

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { familyId, role } = useFamily();
  const isViewer = isViewerRole(role);
  const isOwner = isOwnerRole(role);
  const { status: billingStatus, isLoading: isBillingLoading } = useBilling();
  const [isExporting, setIsExporting] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState('');
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
  const engagementAlertsEnabled = profile?.notify_engagement ?? true;
  const { requestRegistration } = useNotificationsRegistration(
    remindersEnabled || newMemoryAlertsEnabled || engagementAlertsEnabled,
  );

  const promptOpenSystemSettings = () => {
    Alert.alert(
      'Notifications are off',
      'Momora needs permission to send notifications. Enable them for Momora in your device settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open settings', onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const showMutationError = (title: string, error: unknown, fallback: string) => {
    Alert.alert(title, getErrorMessage(error, fallback));
  };

  // Do not save an enabled preference until the device has granted permission
  // and its Expo token has been stored. Otherwise the UI says alerts are on
  // while the server has no way to deliver them.
  const ensureNotificationsAreRegistered = async (): Promise<boolean> => {
    const result = await requestRegistration();

    if (!result) {
      Alert.alert(
        'Notifications unavailable',
        'Notifications are not available in this build. Update Momora and try again.',
      );
      return false;
    }

    if (!result.granted) {
      if (!result.canAskAgain) {
        promptOpenSystemSettings();
      } else {
        Alert.alert('Notifications are off', 'Allow notifications when prompted, then try again.');
      }
      return false;
    }

    if (!result.isRegistered) {
      Alert.alert(
        'Could not enable notifications',
        'Your device could not be registered for notifications. Please try again.',
      );
      return false;
    }

    return true;
  };

  const handleSaveDisplayName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNameError('Your name is required');
      return;
    }

    setNameError('');
    try {
      await updateProfile({ name: trimmed });
      setIsEditingName(false);
    } catch (error) {
      setNameError(getErrorMessage(error, 'Could not update your name'));
    }
  };

  const startEditingName = () => {
    setNameDraft(profile?.name ?? '');
    setNameError('');
    setIsEditingName(true);
  };

  const handleToggleReminders = async (value: boolean) => {
    if (value && !(await ensureNotificationsAreRegistered())) {
      return;
    }

    try {
      await updateProfile({
        enableDailyReminder: value,
        timezone: getDeviceTimezone(),
        notificationTime: profile?.notification_time ?? DEFAULT_REMINDER_TIME,
      });
    } catch (error) {
      showMutationError('Could not update reminders', error, 'Please try again.');
    }
  };

  const handleToggleNewMemoryAlerts = async (value: boolean) => {
    if (value && !(await ensureNotificationsAreRegistered())) {
      return;
    }

    try {
      await updateProfile({ notifyNewMemories: value });
    } catch (error) {
      showMutationError('Could not update new memory alerts', error, 'Please try again.');
    }
  };

  const handleToggleEngagementAlerts = async (value: boolean) => {
    if (value && !(await ensureNotificationsAreRegistered())) {
      return;
    }

    try {
      await updateProfile({ notifyEngagement: value });
    } catch (error) {
      showMutationError('Could not update likes and comments alerts', error, 'Please try again.');
    }
  };

  const handleReminderTimeChange = async (value: string) => {
    try {
      await updateProfile({ notificationTime: value });
    } catch (error) {
      showMutationError('Could not update reminder time', error, 'Please try again.');
    }
  };

  const handleCancelAccountDeletion = async () => {
    try {
      await cancelAccountDeletion();
    } catch (error) {
      showMutationError('Could not cancel account deletion', error, 'Please try again.');
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      showMutationError('Could not sign out', error, 'Please try again.');
    }
  };

  const openExternalUrl = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Could not open link', 'Please try again.');
    }
  };

  const handleManageSubscription = async () => {
    if (billingStatus?.access_reason === 'complimentary') {
      return;
    }

    if (!billingStatus?.management_url) {
      router.push(
        billingStatus?.has_ever_had_access
          ? { pathname: '/(onboarding)/paywall', params: { mode: 'resubscribe' } }
          : '/(onboarding)/paywall',
      );
      return;
    }
    await openExternalUrl(billingStatus.management_url);
  };

  const handleExportMemories = async () => {
    if (isExporting) return;

    setIsExporting(true);
    try {
      const result = await requestDataExport();
      if (result.error || !result.data) {
        showMutationError('Could not export memories', result.error, 'Please try again.');
        return;
      }
      // The archive can be gigabytes, so it's prepared in the background and
      // emailed as a download link rather than pushed onto the phone.
      const destination = result.data.email ?? 'your email address';
      Alert.alert(
        result.data.alreadyRunning ? 'Already on its way' : 'Preparing your archive',
        result.data.alreadyRunning
          ? `We're still preparing your archive and will email a download link to ${destination} when it's ready.`
          : `We'll email a download link to ${destination} when it's ready — usually within an hour. It's best opened on a computer.`,
      );
    } catch (error) {
      showMutationError('Could not export memories', error, 'Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const scheduleAccountDeletion = async () => {
    try {
      await deleteAccount();
      if (user?.id && familyId) {
        await clearMemoryWidgetForScope({ accountId: user.id, familyId }).catch(() => undefined);
      }
    } catch (error) {
      showMutationError('Could not schedule account deletion', error, 'Please try again.');
    }
  };

  const handleDeleteAccount = () => {
    const deletionMessage = isOwnerRole(role)
      ? 'Every family journal you own will be hidden immediately. Your account and those journals will be permanently deleted in 15 days unless you cancel before then.'
      : 'Your account will be permanently deleted in 15 days. Content you added to another person\'s family journal may remain without your account attribution. You can cancel before deletion.';

    Alert.alert(
      'Schedule account deletion?',
      deletionMessage,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Schedule deletion',
          style: 'destructive',
          onPress: () => void scheduleAccountDeletion(),
        },
      ],
    );
  };

  const isComplimentary = billingStatus?.access_reason === 'complimentary';
  const subscriptionCaption = isBillingLoading
    ? 'Checking access…'
    : isComplimentary
      ? 'Complimentary Momora Plus access'
      : billingStatus?.has_write_access
        ? billingStatus.access_reason === 'trial'
          ? 'Momora Plus trial is active'
          : 'Momora Plus is active'
        : billingStatus?.has_ever_had_access
          ? 'Your archive is safe. Resubscribe to capture more.'
          : 'Start Momora Plus to unlock your journal.';

  return (
    <View style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Top edge only -- the default also pads the Android nav-bar inset
              under the header (the same gap the Family tab had). */}
          <SafeAreaView edges={['top']}>
            <View style={styles.header}>
              <Text style={styles.title}>Settings.</Text>
            </View>
          </SafeAreaView>

          <View style={styles.sections}>
            {/* Account deletion banner -- first, so it can't be missed. */}
            {profile?.deleted_at ? (
              <View style={styles.deletionBanner}>
                <Text style={styles.deletionTitle}>Account scheduled for deletion</Text>
                <Text style={styles.deletionBody}>
                  Permanent deletion is scheduled for{' '}
                  {profile.scheduled_hard_delete_at
                    ? new Date(profile.scheduled_hard_delete_at).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })
                    : 'soon'}.
                </Text>
                <Pressable
                  onPress={() => void handleCancelAccountDeletion()}
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

            {/* Identity card: tap to edit your name; owners also see their plan here. */}
            <View style={styles.identityCard}>
              {isEditingName ? (
                <View style={styles.identityEdit}>
                  <AuthInput
                    autoCapitalize="words"
                    autoFocus
                    onChangeText={setNameDraft}
                    placeholder="Your name"
                    testID="settings-display-name"
                    value={nameDraft}
                  />
                  {nameError ? <Text style={styles.inlineErrorText}>{nameError}</Text> : null}
                  <View style={styles.editActions}>
                    <Pressable
                      onPress={() => setIsEditingName(false)}
                      style={styles.editCancel}
                      testID="settings-display-name-cancel"
                    >
                      <Text style={styles.editCancelText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      disabled={isUpdating}
                      onPress={() => void handleSaveDisplayName()}
                      style={styles.editSave}
                      testID="settings-display-name-save"
                    >
                      {isUpdating ? (
                        <ActivityIndicator color={colors.white} size="small" />
                      ) : (
                        <Text style={styles.editSaveText}>Save</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable
                  accessibilityLabel="Edit your name"
                  accessibilityRole="button"
                  onPress={startEditingName}
                  style={({ pressed }) => [styles.identityRow, pressed && styles.identityPressed]}
                  testID="settings-profile-edit"
                >
                  <View style={styles.identityAvatar}>
                    <Text style={styles.identityInitial}>
                      {(profile?.name ?? user?.email ?? 'U').charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.identityContent}>
                    <Text style={styles.identityName}>{profile?.name || 'You'}</Text>
                    <Text style={styles.identityEmail}>{user?.email ?? ''}</Text>
                  </View>
                  <Text style={styles.linkText}>Edit</Text>
                </Pressable>
              )}
              {isOwner ? (
                <SettingsRow
                  chevron={!isComplimentary}
                  label="Subscription"
                  caption={subscriptionCaption}
                  onPress={isComplimentary ? undefined : () => void handleManageSubscription()}
                  testID="settings-manage-subscription"
                />
              ) : null}
            </View>

            <FamilySection />

            <SettingsBlock title="Your journal">
              <GalleryImportSettingsRow first />
              <SettingsRow
                chevron
                first={isViewer || !isGalleryImportFeatureEnabled}
                label="Home-screen widget"
                caption="Keep a private memory card on your phone."
                onPress={() => router.push(widgetSetupRoute)}
                testID="settings-home-screen-widget"
              />
            </SettingsBlock>

            <SettingsBlock title="Notifications">
              {!isViewer && (
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
              )}
              {!isViewer && remindersEnabled && (
                <View style={[styles.row, styles.rowBorder]}>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>Reminder time</Text>
                  </View>
                  <SelectField
                    onChange={(value) => void handleReminderTimeChange(value)}
                    options={REMINDER_TIME_OPTIONS}
                    testID="settings-reminder-time"
                    value={normalizeReminderTime(profile?.notification_time)}
                  />
                </View>
              )}
              <SettingsRow
                first={isViewer}
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
              <SettingsRow
                label="Likes & comments"
                caption="Get notified when someone engages with a memory you added."
                right={
                  <Switch
                    onValueChange={handleToggleEngagementAlerts}
                    testID="settings-engagement-alerts-toggle"
                    value={engagementAlertsEnabled}
                    trackColor={{ false: colors.border, true: colors.primary }}
                  />
                }
              />
            </SettingsBlock>

            <SettingsBlock title="Help">
              <SettingsRow
                first
                chevron
                label="FAQ"
                onPress={() => void openExternalUrl(FAQ_URL)}
                testID="settings-faq"
              />
              <SettingsRow
                chevron
                label="Contact support"
                onPress={() => void openExternalUrl(SUPPORT_EMAIL_URL)}
                testID="settings-contact-support"
              />
              <SettingsRow
                chevron
                label="Privacy policy"
                onPress={() => void openExternalUrl(PRIVACY_POLICY_URL)}
                testID="settings-privacy-policy"
              />
              <SettingsRow
                chevron
                label="Terms of service"
                onPress={() => void openExternalUrl(TERMS_OF_SERVICE_URL)}
                testID="settings-terms-of-service"
              />
            </SettingsBlock>

            <SettingsBlock title="Account">
              {isOwner ? (
                <SettingsRow
                  first
                  chevron={!isExporting}
                  label="Export your memories"
                  caption="We'll email you a download link"
                  onPress={isExporting ? undefined : () => void handleExportMemories()}
                  right={isExporting ? <ActivityIndicator color={colors.primary} size="small" /> : undefined}
                  testID="settings-export-memories"
                />
              ) : null}
              <SettingsRow
                first={!isOwner}
                label="Sign out"
                onPress={() => void handleSignOut()}
                testID="settings-sign-out-button"
              />
              {!profile?.deleted_at && (
                <SettingsRow
                  destructive
                  label={isDeletingAccount ? 'Scheduling deletion…' : 'Delete account'}
                  onPress={isDeletingAccount || isUpdating ? undefined : handleDeleteAccount}
                  testID="settings-delete-account"
                />
              )}
            </SettingsBlock>

            <Text style={styles.version}>Momora · v{APP_VERSION}</Text>
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
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 42,
    lineHeight: 42,
    color: colors.ink,
  },
  identityCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  identityRow: {
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  identityPressed: {
    backgroundColor: colors.surface,
  },
  identityEdit: {
    padding: 18,
    gap: spacing.sm,
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
  sections: {
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
    gap: 24,
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
  rowContent: {
    flex: 1,
  },
  rowLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 14.5,
    color: colors.ink,
  },
  linkText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  editCancel: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  editCancelText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink3,
  },
  editSave: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
  },
  editSaveText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.white,
  },
  inlineErrorText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.error,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.error,
    paddingHorizontal: 16,
    paddingBottom: 8,
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
  version: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: colors.ink3,
    textAlign: 'center',
    marginTop: 8,
  },
});
