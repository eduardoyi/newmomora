import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { AuthErrorMessage, AuthInput } from '@/components/auth-screen';
import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { familyInvitesQueryKey } from '@/hooks/queryKeys';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyRelationships } from '@/hooks/useFamilyRelationships';
import { sharingPendingInvitesRoute } from '@/lib/routes';
import { trackEvent } from '@/services/analytics';
import { createFamilyInvite } from '@/services/invites';
import { isInviteTargetEligible } from '@/utils/family-relationships';
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

const INVITEE_NAME_MAX_LENGTH = 60;

// `maxLength` only limits typing, not programmatic fills.
function clipInviteeName(name: string): string {
  return name.trim().slice(0, INVITEE_NAME_MAX_LENGTH);
}

// Server errors are matched by message token (several share code 22023;
// docs/plans/invite-for-person.md §5.2). Raw tokens never reach the screen.
function mapInviteError(error: { message: string; code?: string }): {
  message: string;
  clearPerson: boolean;
} | null {
  if (error.message === 'member_already_linked') {
    return { message: 'Someone in the family already says this is them.', clearPerson: true };
  }
  if (error.message === 'member_not_linkable' || error.message === 'member_not_in_family') {
    return {
      message: "That person can't be invited anymore. Pick someone else or type a name.",
      clearPerson: true,
    };
  }
  if (error.message === 'invitee_name_too_long' || error.code === '23514') {
    return { message: 'That name is a bit long.', clearPerson: false };
  }
  return null;
}

export default function InviteFamilyMemberScreen() {
  const { memberId: memberIdParam } = useLocalSearchParams<{ memberId?: string }>();
  const { family, familyId, role } = useFamily();
  const queryClient = useQueryClient();
  const { members } = useFamilyMembers();
  const relationships = useFamilyRelationships(members);
  const contentSafety = useContentSafety();
  const [selectedRole, setSelectedRole] = useState<InviteRole>('viewer');
  // Overrides of what the `memberId` param preselects: `undefined` / `null`
  // mean "the user hasn't touched it yet".
  const [selectedOverride, setSelectedOverride] = useState<string | null | undefined>(undefined);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Guard on mount: viewers reaching this route directly get bounced back.
  useEffect(() => {
    if (!canEditFamilyContent(role)) {
      router.back();
    }
  }, [role]);

  const eligibleMembers = useMemo(
    () =>
      relationships.isLoadingLinks || contentSafety.isLoading
        ? []
        : members.filter((member) =>
            isInviteTargetEligible(
              member,
              relationships.links,
              contentSafety.isTargetReported('family_member_profile', member.id),
            ),
          ),
    [members, relationships.isLoadingLinks, relationships.links, contentSafety],
  );

  // `memberId` param (person detail's "Invite {name}"): preselect once the
  // people and links have loaded; ignored silently if they turn out ineligible.
  const preselected = memberIdParam
    ? eligibleMembers.find((member) => member.id === memberIdParam) ?? null
    : null;
  const selectedMemberId =
    selectedOverride === undefined ? (preselected?.id ?? null) : selectedOverride;
  const inviteeName =
    nameOverride ?? (preselected ? clipInviteeName(preselected.name) : '');

  const handleSelectMember = (member: { id: string; name: string }) => {
    if (selectedMemberId === member.id) {
      // Deselect unlinks the person but keeps whatever is typed.
      setSelectedOverride(null);
      setNameOverride(inviteeName);
      return;
    }
    setSelectedOverride(member.id);
    setNameOverride(clipInviteeName(member.name));
  };

  const handleInvite = async () => {
    if (!familyId || !family) {
      return;
    }

    setErrorMessage('');
    setIsCreating(true);

    const trimmedName = inviteeName.trim();

    try {
      const { data: invite, error } = await createFamilyInvite(familyId, selectedRole, {
        inviteeName: trimmedName || undefined,
        inviteeMemberId: selectedMemberId ?? undefined,
      });

      if (error || !invite) {
        const mapped = error ? mapInviteError(error) : null;
        if (mapped) {
          if (mapped.clearPerson) {
            setSelectedOverride(null);
            setNameOverride(inviteeName);
          }
          setErrorMessage(mapped.message);
          return;
        }
        throw new Error(error?.message ?? 'Could not create the invite');
      }

      queryClient.invalidateQueries({ queryKey: familyInvitesQueryKey(familyId) });
      trackEvent('invite_created', {
        role: selectedRole,
        family_id: familyId,
        has_invitee_name: trimmedName.length > 0,
        for_family_member: selectedMemberId !== null,
      });

      // The share sheet resolving covers both "shared" and "dismissed" -- in
      // either case the invite now exists, so land on pending-invites where
      // it can be reshared or revoked.
      try {
        await Share.share({ message: buildInviteShareMessage(invite.code, family.name, trimmedName || null) });
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
        <Text style={styles.sectionLabel}>Who&apos;s this for? (optional)</Text>

        <AuthInput
          autoCapitalize="words"
          maxLength={INVITEE_NAME_MAX_LENGTH}
          onChangeText={setNameOverride}
          placeholder="Their name, e.g. Grandma Ana"
          returnKeyType="done"
          testID="sharing-invite-name-input"
          value={inviteeName}
        />

        {eligibleMembers.length > 0 ? (
          <ScrollView
            contentContainerStyle={styles.chipRow}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
          >
            {eligibleMembers.map((member) => {
              const isSelected = member.id === selectedMemberId;

              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  key={member.id}
                  onPress={() => handleSelectMember(member)}
                  style={[styles.personChip, isSelected && styles.personChipSelected]}
                  testID={`sharing-invite-person-${member.id}`}
                >
                  <FamilyMemberAvatar member={member} size={24} />
                  <Text style={[styles.personChipText, isSelected && styles.personChipTextSelected]}>
                    {member.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        <Text style={[styles.sectionLabel, styles.roleSectionLabel]}>They can join as</Text>

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
  roleSectionLabel: {
    marginTop: spacing.sm,
  },
  chipRow: {
    gap: spacing.sm,
  },
  personChip: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  personChipSelected: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primary,
  },
  personChipText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.ink2,
  },
  personChipTextSelected: {
    color: colors.primaryDark,
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
