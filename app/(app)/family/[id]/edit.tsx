import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AuthErrorMessage, AuthField, AuthInput } from '@/components/auth-screen';
import { DatePickerField } from '@/components/date-picker-field';
import { FamilyProfilePortraitPhoto } from '@/components/family-profile-portrait-photo';
import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { NicknameInputRow } from '@/components/nickname-input-row';
import { SelectField } from '@/components/select-field';
import { GENDER_OPTIONS } from '@/constants/gender-options';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { canEditFamilyContent } from '@/utils/roles';
import { validateDateOfBirth, validateFamilyMemberName } from '@/utils/family-members';
import {
  type FamilyProfilePhotoPickResult,
  type FamilyProfilePhotoSelection,
  parsePendingPickerResult,
  pickFamilyProfilePhotoFromCamera,
  pickFamilyProfilePhotoFromLibrary,
} from '@/utils/family-profile-photo-picker';
import { runAfterNativeChooserDismisses } from '@/utils/native-permissions';

export default function EditFamilyMemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { role } = useFamily();
  const { members, isLoading, updateMember, isUpdating, deleteMember, isDeleting } = useFamilyMembers();

  const member = members.find((m) => m.id === id);

  // Guard on mount: viewers reaching this route directly get bounced back.
  useEffect(() => {
    if (!canEditFamilyContent(role)) {
      router.back();
    }
  }, [role]);

  const [name, setName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [gender, setGender] = useState('');
  const [additionalInfo, setAdditionalInfo] = useState('');
  const [nicknames, setNicknames] = useState<string[]>([]);
  const [nicknameInput, setNicknameInput] = useState('');
  const [newPhoto, setNewPhoto] = useState<FamilyProfilePhotoSelection | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [isRegeneratingPortrait, setIsRegeneratingPortrait] = useState(false);

  const defaultDobPickerDate = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 3);
    return d;
  }, []);
  const today = useMemo(() => new Date(), []);

  useEffect(() => {
    if (member && !isInitialized) {
      setName(member.name);
      setDateOfBirth(member.date_of_birth ?? '');
      setGender(member.gender ?? '');
      setAdditionalInfo(member.additional_info ?? '');
      setNicknames(member.nicknames ?? []);
      setIsInitialized(true);
    }
  }, [member, isInitialized]);

  const addNickname = () => {
    const v = nicknameInput.trim();
    if (v && !nicknames.includes(v)) {
      setNicknames((prev) => [...prev, v]);
    }
    setNicknameInput('');
  };

  const removeNickname = (nick: string) => {
    setNicknames((prev) => prev.filter((n) => n !== nick));
  };

  const applyPickResult = useCallback((result: FamilyProfilePhotoPickResult) => {
    if (result.error) {
      setErrorMessage(result.error);
      return;
    }

    if (result.selection) {
      setNewPhoto(result.selection);
      setErrorMessage('');
    }
  }, []);

  const takePhoto = useCallback(async () => {
    applyPickResult(await pickFamilyProfilePhotoFromCamera());
  }, [applyPickResult]);

  const choosePhotoFromLibrary = useCallback(async () => {
    applyPickResult(await pickFamilyProfilePhotoFromLibrary());
  }, [applyPickResult]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    let isMounted = true;
    const recoverPendingProfilePhoto = async () => {
      try {
        const pending = await ImagePicker.getPendingResultAsync();
        if (isMounted) {
          applyPickResult(parsePendingPickerResult(pending));
        }
      } catch {
        if (isMounted) {
          setErrorMessage('Could not recover the selected profile photo.');
        }
      }
    };

    void recoverPendingProfilePhoto();
    return () => {
      isMounted = false;
    };
  }, [applyPickResult]);

  const showProfilePhotoSourceChooser = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Take photo', 'Choose from library', 'Cancel'],
          cancelButtonIndex: 2,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) {
            runAfterNativeChooserDismisses(() => { void takePhoto(); });
          }
          if (buttonIndex === 1) {
            runAfterNativeChooserDismisses(() => { void choosePhotoFromLibrary(); });
          }
        },
      );
      return;
    }

    Alert.alert('Profile photo', undefined, [
      {
        text: 'Take photo',
        onPress: () => runAfterNativeChooserDismisses(() => { void takePhoto(); }),
      },
      {
        text: 'Choose from library',
        onPress: () => runAfterNativeChooserDismisses(() => { void choosePhotoFromLibrary(); }),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const saveChanges = async (regeneratePortrait: boolean) => {
    if (!member) return;

    if (regeneratePortrait && newPhoto) {
      setIsRegeneratingPortrait(true);
    }

    try {
      await updateMember({
        memberId: member.id,
        name: name.trim(),
        dateOfBirth: dateOfBirth.trim(),
        gender: gender.trim() || null,
        additionalInfo: additionalInfo.trim() || null,
        nicknames,
        photoUri: newPhoto?.uri,
        photoContentType: newPhoto?.contentType,
        regeneratePortrait,
      });
      router.back();
    } catch (error) {
      setIsRegeneratingPortrait(false);
      setErrorMessage(error instanceof Error ? error.message : 'Could not update family member');
    }
  };

  const handleSave = () => {
    setErrorMessage('');
    if (!member) return;

    const nameError = validateFamilyMemberName(name);
    if (nameError) { setErrorMessage(nameError); return; }

    const dobError = validateDateOfBirth(dateOfBirth);
    if (dobError) { setErrorMessage(dobError); return; }

    if (newPhoto) {
      Alert.alert(
        'Update portrait?',
        'You changed the profile photo. Regenerate the AI character portrait to match the new photo, or keep the current portrait for now.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save without regenerating',
            onPress: () => {
              void saveChanges(false);
            },
          },
          {
            text: 'Regenerate portrait',
            onPress: () => {
              void saveChanges(true);
            },
          },
        ],
      );
      return;
    }

    void saveChanges(false);
  };

  const handleDelete = () => {
    if (!member) return;
    Alert.alert(
      'Remove from family',
      `Remove ${member.name} from your family? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setErrorMessage('');
            try {
              await deleteMember(member.id);
              router.back();
            } catch (error) {
              setErrorMessage(error instanceof Error ? error.message : 'Could not remove member');
            }
          },
        },
      ],
    );
  };

  if (isLoading || !isInitialized) {
    return (
      <KeyboardAwareFormScreen>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </KeyboardAwareFormScreen>
    );
  }

  if (!member) {
    return (
      <KeyboardAwareFormScreen>
        <Text style={styles.notFoundText}>Person not found</Text>
      </KeyboardAwareFormScreen>
    );
  }

  return (
    <KeyboardAwareFormScreen>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backButton}
          testID="edit-family-member-cancel"
        >
          <Text style={styles.backButtonText}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Edit person</Text>
      </View>

      {/* ── Photo ── */}
      <View style={styles.photoSection}>
        <Pressable
          accessibilityRole="button"
          onPress={showProfilePhotoSourceChooser}
          style={styles.photoCircleWrap}
          testID="edit-family-member-photo"
        >
          <FamilyProfilePortraitPhoto
            forceGeneratingOverlay={isRegeneratingPortrait}
            localPhotoUri={newPhoto?.uri}
            member={member}
            width={96}
          />
          <View style={styles.photoOverlay}>
            <Text style={styles.photoOverlayIcon}>📷</Text>
          </View>
        </Pressable>
        <Text style={styles.photoHint}>Take or change photo</Text>
      </View>

      {/* ── Form ── */}
      <View style={styles.form}>
        <AuthField label="Name">
          <AuthInput
            autoCapitalize="words"
            onChangeText={setName}
            placeholder="Name"
            testID="edit-family-member-name"
            value={name}
          />
        </AuthField>

        <AuthField label="Date of birth">
          <DatePickerField
            defaultPickerDate={defaultDobPickerDate}
            maximumDate={today}
            onChange={setDateOfBirth}
            placeholder="Select date of birth"
            testID="edit-family-member-dob"
            value={dateOfBirth}
          />
        </AuthField>

        <AuthField label="Gender (optional)">
          <SelectField
            onChange={setGender}
            options={GENDER_OPTIONS}
            placeholder="Select gender"
            testID="edit-family-member-gender"
            value={gender}
          />
        </AuthField>

        {/* Nicknames */}
        <View style={styles.nicknamesSection}>
          <Text style={styles.nicknamesLabel}>Nicknames</Text>
          {nicknames.length > 0 && (
            <View style={styles.nicknamePills}>
              {nicknames.map((nick) => (
                <View key={nick} style={styles.nicknamePill}>
                  <Text style={styles.nicknamePillText}>{nick}</Text>
                  <Pressable
                    onPress={() => removeNickname(nick)}
                    style={styles.nicknamePillRemove}
                    accessibilityLabel={`Remove nickname ${nick}`}
                    hitSlop={8}
                  >
                    <Text style={styles.nicknamePillRemoveText}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
          <NicknameInputRow
            value={nicknameInput}
            onChangeText={setNicknameInput}
            onSubmitEditing={addNickname}
            onAdd={addNickname}
            inputTestID="edit-family-member-nickname-input"
            addTestID="edit-family-member-nickname-add"
          />
        </View>

        <AuthField label="Notes (optional)">
          <AuthInput
            multiline
            numberOfLines={3}
            onChangeText={setAdditionalInfo}
            placeholder="Physical traits, quirks, personality…"
            style={styles.notesInput}
            testID="edit-family-member-notes"
            value={additionalInfo}
          />
        </AuthField>

        <AuthErrorMessage message={errorMessage} />

        <Pressable
          accessibilityRole="button"
          disabled={isUpdating}
          onPress={handleSave}
          style={({ pressed }) => [
            styles.saveButton,
            isUpdating && styles.saveButtonDisabled,
            pressed && !isUpdating && styles.saveButtonPressed,
          ]}
          testID="edit-family-member-save"
        >
          {isUpdating ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.saveButtonText}>Save changes</Text>
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={isDeleting}
          onPress={handleDelete}
          style={styles.deleteButton}
          testID="edit-family-member-delete"
        >
          <Text style={[styles.deleteButtonText, isDeleting && styles.deleteButtonTextDisabled]}>
            {isDeleting ? 'Removing…' : 'Remove from family'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAwareFormScreen>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
  notFoundText: {
    fontFamily: fonts.sans,
    color: colors.ink3,
    fontSize: 16,
    textAlign: 'center',
  },
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
    color: colors.text,
    fontSize: 28,
    fontFamily: fonts.sansBold,
  },

  // Photo section
  photoSection: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  photoCircleWrap: {
    height: 96,
    overflow: 'hidden',
    position: 'relative',
    width: 96,
  },
  photoCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    overflow: 'hidden',
  },
  photoCirclePlaceholder: {
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoCircleInitial: {
    fontFamily: fonts.displayItalic,
    fontSize: 38,
    color: colors.ink3,
  },
  photoOverlay: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoOverlayIcon: {
    fontSize: 14,
  },
  photoHint: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },

  // Form
  form: {
    gap: spacing.md,
  },
  notesInput: {
    minHeight: 96,
    textAlignVertical: 'top',
  },

  // Nicknames
  nicknamesSection: {
    gap: spacing.sm,
  },
  nicknamesLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink2,
  },
  nicknamePills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  nicknamePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryTint,
    borderWidth: 1,
    borderColor: colors.primarySoft,
  },
  nicknamePillText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
  },
  nicknamePillRemove: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.primary + '22',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nicknamePillRemoveText: {
    fontSize: 14,
    color: colors.primary,
    lineHeight: 18,
    textAlign: 'center',
  },
  // Buttons
  saveButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    paddingVertical: 16,
  },
  saveButtonDisabled: {
    opacity: 0.7,
  },
  saveButtonPressed: {
    backgroundColor: colors.primaryDark,
  },
  saveButtonText: {
    fontFamily: fonts.sansBold,
    color: colors.white,
    fontSize: 16,
  },
  deleteButton: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  deleteButtonText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.error,
  },
  deleteButtonTextDisabled: {
    opacity: 0.5,
  },
});
