import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useNotificationsRegistration } from '@/hooks/useNotifications';
import { useUserProfile } from '@/hooks/useUserProfile';
import { getDeviceTimezone } from '@/services/auth';
import { AuthField, AuthInput } from '@/components/auth-screen';

function SettingsBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View>
      <Text style={styles.blockTitle}>{title}</Text>
      <View style={styles.block}>
        {children}
      </View>
    </View>
  );
}

function SettingsRow({
  label,
  caption,
  value,
  chevron,
  right,
  first,
}: {
  label: string;
  caption?: string;
  value?: string;
  chevron?: boolean;
  right?: React.ReactNode;
  first?: boolean;
}) {
  return (
    <View style={[styles.row, !first && styles.rowBorder]}>
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{label}</Text>
        {caption && <Text style={styles.rowCaption}>{caption}</Text>}
      </View>
      {value && <Text style={styles.rowValue}>{value}</Text>}
      {right}
      {chevron && <Text style={styles.chevron}>›</Text>}
    </View>
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
  useNotificationsRegistration(remindersEnabled);

  const handleToggleReminders = async (value: boolean) => {
    await updateProfile({
      enableDailyReminder: value,
      timezone: profile?.timezone ?? getDeviceTimezone(),
      notificationTime: profile?.notification_time ?? '20:00:00',
    });
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
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
          <SettingsBlock title="Daily reminder">
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
          </SettingsBlock>

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
                onPress={() => void deleteAccount()}
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
