import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { AuthErrorMessage } from '@/components/auth-screen';
import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { familyInvitesQueryKey } from '@/hooks/queryKeys';
import { sharingPendingInvitesRoute } from '@/lib/routes';
import { createFamilyInvite } from '@/services/invites';
import { buildInviteShareMessage } from '@/utils/invites';
import { canEditFamilyContent } from '@/utils/roles';
import { useQueryClient } from '@tanstack/react-query';

type InviteRole = 'viewer' | 'manager';

const ROLE_OPTIONS: { value: InviteRole; label: string; description: string }[] = [
  {
    value: 'viewer',
    label: 'Viewer',
    description: 'Can look through every memory, but not add or change anything.',
  },
  {
    value: 'manager',
    label: 'Manager',
    description: 'Can add and edit memories, children, and invite other family members.',
  },
];

export default function InviteFamilyMemberScreen() {
  const { family, familyId, role } = useFamily();
  const queryClient = useQueryClient();
  const [selectedRole, setSelectedRole] = useState<InviteRole>('viewer');
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Guard on mount: viewers reaching this route directly get bounced back.
  useEffect(() => {
    if (!canEditFamilyContent(role)) {
      router.back();
    }
  }, [role]);

  const handleInvite = async () => {
    if (!familyId || !family) {
      return;
    }

    setErrorMessage('');
    setIsCreating(true);

    try {
      const { data: invite, error } = await createFamilyInvite(familyId, selectedRole);

      if (error || !invite) {
        throw new Error(error?.message ?? 'Could not create the invite');
      }

      queryClient.invalidateQueries({ queryKey: familyInvitesQueryKey(familyId) });

      // The share sheet resolving covers both "shared" and "dismissed" -- in
      // either case the invite now exists, so land on pending-invites where
      // it can be reshared or revoked.
      try {
        await Share.share({ message: buildInviteShareMessage(invite.code, family.name) });
      } catch {
        // A share-sheet failure never orphans the invite.
      }

      router.replace(sharingPendingInvitesRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not create the invite');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <KeyboardAwareFormScreen>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backButton}
          testID="sharing-invite-cancel"
        >
          <Text style={styles.backButtonText}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Invite a family member</Text>
        <Text style={styles.subtitle}>
          They get a 3-word code that works for 7 days. You approve them before they join.
        </Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.sectionLabel}>They can join as</Text>

        {ROLE_OPTIONS.map((option) => {
          const isSelected = option.value === selectedRole;

          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              key={option.value}
              onPress={() => setSelectedRole(option.value)}
              style={[styles.roleCard, isSelected && styles.roleCardSelected]}
              testID={`sharing-invite-role-${option.value}`}
            >
              <View style={styles.roleCardHeader}>
                <Text style={[styles.roleLabel, isSelected && styles.roleLabelSelected]}>
                  {option.label}
                </Text>
                <View style={[styles.radio, isSelected && styles.radioSelected]}>
                  {isSelected ? <View style={styles.radioDot} /> : null}
                </View>
              </View>
              <Text style={styles.roleDescription}>{option.description}</Text>
            </Pressable>
          );
        })}

        <AuthErrorMessage message={errorMessage} />

        <Pressable
          accessibilityRole="button"
          disabled={isCreating}
          onPress={() => void handleInvite()}
          style={({ pressed }) => [
            styles.inviteButton,
            isCreating && styles.inviteButtonDisabled,
            pressed && !isCreating && styles.inviteButtonPressed,
          ]}
          testID="sharing-invite-create-button"
        >
          {isCreating ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.inviteButtonText}>Create invite &amp; share</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAwareFormScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: {
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
  form: {
    gap: spacing.md,
  },
  sectionLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  roleCard: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 6,
    padding: spacing.md,
  },
  roleCardSelected: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primary,
  },
  roleCardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  roleLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.ink,
  },
  roleLabelSelected: {
    color: colors.primaryDark,
  },
  roleDescription: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    color: colors.ink2,
  },
  radio: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: 11,
    borderWidth: 2,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  radioSelected: {
    borderColor: colors.primary,
  },
  radioDot: {
    backgroundColor: colors.primary,
    borderRadius: 6,
    height: 12,
    width: 12,
  },
  inviteButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    paddingVertical: 16,
  },
  inviteButtonDisabled: {
    opacity: 0.7,
  },
  inviteButtonPressed: {
    backgroundColor: colors.primaryDark,
  },
  inviteButtonText: {
    fontFamily: fonts.sansBold,
    color: colors.white,
    fontSize: 16,
  },
});
