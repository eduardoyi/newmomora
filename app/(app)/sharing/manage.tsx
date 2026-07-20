import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthErrorMessage, AuthField, AuthInput } from '@/components/auth-screen';
import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { SettingsBlock, SettingsRow } from '@/components/settings-row';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { type FamilyMembershipSummary, useFamily } from '@/hooks/use-family';
import { timelineRoute } from '@/lib/routes';
import { createFamily, deleteFamily, friendlyFamilyLimitError } from '@/services/family';
import { isOwnerRole, roleLabel } from '@/utils/roles';

/**
 * Lets an existing user create an additional family journal (previously
 * only reachable from the no-family screen for brand-new accounts) and
 * delete a family journal they own. See src/services/family.ts for
 * `createFamily`/`deleteFamily` and
 * supabase/migrations/20260720110000_delete_family.sql for the `delete_family`
 * RPC's soft-delete side effects.
 */
export default function ManageFamiliesScreen() {
  const { familyId, memberships, setActiveFamily, refetchMemberships } = useFamily();

  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [deletingFamilyId, setDeletingFamilyId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const handleCreate = async () => {
    const trimmed = name.trim();

    if (!trimmed) {
      setCreateError('Give your family journal a name');
      return;
    }

    setCreateError('');
    setIsCreating(true);

    try {
      const { data, error } = await createFamily(trimmed);

      if (error || !data) {
        throw new Error(friendlyFamilyLimitError(error?.message ?? 'Could not create your family', error?.code));
      }

      await refetchMemberships();
      await setActiveFamily(data.id);
      router.replace(timelineRoute);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create your family');
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (membership: FamilyMembershipSummary) => {
    setDeleteError('');
    setDeletingFamilyId(membership.familyId);

    try {
      const { error } = await deleteFamily(membership.familyId);

      if (error) {
        throw new Error(error.message);
      }

      if (familyId === membership.familyId) {
        const remaining = memberships.filter((item) => item.familyId !== membership.familyId);
        if (remaining.length > 0) {
          await setActiveFamily(remaining[0].familyId);
        }
      }

      await refetchMemberships();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete this family');
    } finally {
      setDeletingFamilyId(null);
    }
  };

  const handleRequestDelete = (membership: FamilyMembershipSummary) => {
    Alert.alert(
      'Delete family journal',
      `Delete "${membership.name}"? Every member will lose access immediately, and this can't be undone from the app.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void handleDelete(membership),
        },
      ],
    );
  };

  return (
    <KeyboardAwareFormScreen>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backButton}
          testID="sharing-manage-back"
        >
          <Text style={styles.backButtonText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Manage families</Text>
        <Text style={styles.subtitle}>
          Create another family journal, or delete one you own.
        </Text>
      </View>

      <SettingsBlock title="Your families">
        {memberships.map((membership, index) => {
          const isActive = membership.familyId === familyId;
          const isOwner = isOwnerRole(membership.role);
          const isDeletingThis = deletingFamilyId === membership.familyId;

          return (
            <SettingsRow
              first={index === 0}
              key={membership.id}
              label={membership.name}
              caption={roleLabel(membership.role)}
              value={isActive ? 'Active' : undefined}
              right={
                isOwner ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={deletingFamilyId !== null}
                    onPress={() => handleRequestDelete(membership)}
                    testID={`manage-families-delete-${membership.familyId}`}
                  >
                    {isDeletingThis ? (
                      <ActivityIndicator color={colors.error} size="small" />
                    ) : (
                      <Text style={styles.deleteText}>Delete</Text>
                    )}
                  </Pressable>
                ) : undefined
              }
              testID={`manage-families-row-${membership.familyId}`}
            />
          );
        })}
      </SettingsBlock>

      {deleteError ? <Text style={styles.errorText}>{deleteError}</Text> : null}

      <View style={styles.form}>
        <Text style={styles.formTitle}>Start a new family journal</Text>
        <AuthField label="Family name">
          <AuthInput
            autoCapitalize="words"
            onChangeText={setName}
            placeholder="e.g. The Rivera family"
            testID="manage-families-name-input"
            value={name}
          />
        </AuthField>

        <AuthErrorMessage message={createError} />

        <Pressable
          accessibilityRole="button"
          disabled={isCreating}
          onPress={() => void handleCreate()}
          style={({ pressed }) => [
            styles.createButton,
            isCreating && styles.createButtonDisabled,
            pressed && !isCreating && styles.createButtonPressed,
          ]}
          testID="manage-families-create-button"
        >
          {isCreating ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.createButtonText}>Create family journal</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAwareFormScreen>
  );
}

const styles = StyleSheet.create({
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
  deleteText: {
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
    color: colors.error,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
  },
  form: {
    gap: spacing.md,
  },
  formTitle: {
    fontFamily: fonts.displayMedium,
    fontSize: 18,
    color: colors.ink,
  },
  createButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    paddingVertical: 16,
  },
  createButtonDisabled: {
    opacity: 0.7,
  },
  createButtonPressed: {
    backgroundColor: colors.primaryDark,
  },
  createButtonText: {
    fontFamily: fonts.sansBold,
    color: colors.white,
    fontSize: 16,
  },
});
