import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { AuthInput } from '@/components/auth-screen';
import { GalleryCaptionLanguageRow } from '@/components/gallery-import/gallery-import-settings';
import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { SettingsBlock, SettingsRow } from '@/components/settings-row';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import {
  familyMembershipsQueryKey,
  useFamily,
  type FamilyMembershipSummary,
} from '@/hooks/use-family';
import { updateFamilyName, updateFamilyViewerSharing } from '@/services/family';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { canEditFamilyContent } from '@/utils/roles';

/**
 * Family-level settings for the active family (owner/manager only), split out
 * of Settings' Family block so that block only covers people (members and
 * invites) and every rule that applies to the whole family lives in one
 * place: family name, "Viewers can share memories", and photo caption
 * language. Viewers never see the Settings entry point; a direct navigation
 * gets an explanatory empty state rather than controls RLS would reject.
 */
export default function FamilySettingsScreen() {
  const { user } = useAuth();
  const { family, familyId, role } = useFamily();
  const queryClient = useQueryClient();
  const canEdit = canEditFamilyContent(role);

  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [isSavingName, setIsSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const [viewerSharingError, setViewerSharingError] = useState('');

  // "Viewers can share memories" (docs/plans/offline-awareness-and-share-
  // cards.md S1/S2). Optimistic update + rollback against the
  // family-memberships cache -- the same cache useFamily() derives
  // `family.viewerSharingEnabled` from -- mirrors useMemberManagement's
  // onMutate/onError/onSettled pattern rather than updateFamilyName's fire-
  // and-forget (this toggle needs its own error surface for the billing-
  // lockout case below).
  const membershipsQueryKey = [...familyMembershipsQueryKey, user?.id];
  const viewerSharingMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!familyId) {
        throw new Error('You must have a family to change this setting');
      }

      const { data, error } = await updateFamilyViewerSharing(familyId, enabled);
      if (error) {
        throw new Error(error.message);
      }
      if (!data) {
        // RLS-allowed shape but zero rows matched -- the families UPDATE
        // policy also requires billing_write_allowed_for_current_user, so a
        // lapsed-subscription owner/manager cannot flip this toggle (same
        // gate family rename is subject to).
        throw new Error(
          "Your family's subscription isn't active, so this setting can't be changed right now.",
        );
      }
      return enabled;
    },
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: membershipsQueryKey });
      const previous = queryClient.getQueryData<FamilyMembershipSummary[]>(membershipsQueryKey);

      if (previous && familyId) {
        queryClient.setQueryData<FamilyMembershipSummary[]>(
          membershipsQueryKey,
          previous.map((membership) =>
            membership.familyId === familyId
              ? { ...membership, viewerSharingEnabled: enabled }
              : membership,
          ),
        );
      }

      setViewerSharingError('');
      return { previous };
    },
    onError: (error, _enabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(membershipsQueryKey, context.previous);
      }
      setViewerSharingError(
        error instanceof Error ? error.message : 'Could not update this setting',
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey });
    },
  });

  const header = (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.back()}
        style={styles.backButton}
        testID="family-settings-back"
      >
        <Text style={styles.backButtonText}>Back</Text>
      </Pressable>
      <Text style={styles.title}>Family settings</Text>
      <Text style={styles.subtitle}>
        These apply to everyone in {family?.name ?? 'this family'}.
      </Text>
    </View>
  );

  if (!family || !familyId || !canEdit) {
    return (
      <KeyboardAwareFormScreen>
        {header}
        <Text style={styles.subtitle} testID="family-settings-not-allowed">
          Only a family owner or manager can change family settings.
        </Text>
      </KeyboardAwareFormScreen>
    );
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

  const handleToggleViewerSharing = async (value: boolean) => {
    try {
      await viewerSharingMutation.mutateAsync(value);
    } catch {
      // Surfaced via viewerSharingError, set in the mutation's onError.
    }
  };

  return (
    <KeyboardAwareFormScreen>
      {header}

      <SettingsBlock title="Family">
        {isEditingName ? (
          <View style={styles.editRow}>
            <AuthInput
              autoCapitalize="words"
              autoFocus
              onChangeText={setNameDraft}
              testID="settings-family-name-input"
              value={nameDraft}
            />
            {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
            <View style={styles.editActions}>
              <Pressable
                onPress={() => {
                  setIsEditingName(false);
                  setNameError('');
                }}
                style={styles.editCancel}
                testID="settings-family-name-cancel"
              >
                <Text style={styles.editCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={isSavingName}
                onPress={() => void handleSaveName()}
                style={styles.editSave}
                testID="settings-family-name-save"
              >
                {isSavingName ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <Text style={styles.editSaveText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : (
          <SettingsRow
            first
            label="Family name"
            caption={family.name}
            right={
              <Pressable
                onPress={() => {
                  setNameDraft(family.name);
                  setNameError('');
                  setIsEditingName(true);
                }}
                testID="settings-family-name-edit"
              >
                <Text style={styles.editTrigger}>Edit</Text>
              </Pressable>
            }
          />
        )}

        <SettingsRow
          label="Viewers can share memories"
          caption="Turn off to stop viewers from sharing memory cards outside the family."
          right={
            <Switch
              disabled={viewerSharingMutation.isPending}
              onValueChange={(value) => void handleToggleViewerSharing(value)}
              testID="settings-viewer-sharing-toggle"
              trackColor={{ false: colors.border, true: colors.primary }}
              value={family.viewerSharingEnabled ?? true}
            />
          }
        />
        {viewerSharingError ? <Text style={styles.errorText}>{viewerSharingError}</Text> : null}
      </SettingsBlock>

      {isGalleryImportFeatureEnabled ? (
        <SettingsBlock title="Photos">
          <GalleryCaptionLanguageRow first />
        </SettingsBlock>
      ) : null}
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
  editRow: {
    gap: spacing.sm,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  editTrigger: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
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
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.error,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
});
