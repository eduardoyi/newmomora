import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { router } from 'expo-router';
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
import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { NicknameInputRow } from '@/components/nickname-input-row';
import { SelectField } from '@/components/select-field';
import { GENDER_OPTIONS } from '@/constants/gender-options';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useUserProfile } from '@/hooks/useUserProfile';
import { canEditFamilyContent } from '@/utils/roles';
import {
  E2E_FAMILY_MEMBER_DOB,
  E2E_FAMILY_MEMBER_GENDER,
  E2E_FAMILY_MEMBER_NAME,
  E2E_FAMILY_MEMBER_NOTES,
  isE2eFixturesEnabled,
  loadE2eProfilePhoto,
} from '@/utils/e2e-fixtures';
import { validateDateOfBirth, validateFamilyMemberName } from '@/utils/family-members';
import {
  type FamilyProfilePhotoPickResult,
  type FamilyProfilePhotoSelection,
  parsePendingPickerResult,
  pickFamilyProfilePhotoFromCamera,
  pickFamilyProfilePhotoFromLibrary,
} from '@/utils/family-profile-photo-picker';

export default function AddFamilyMemberScreen() {
  const { role } = useFamily();
  const { createMember, isCreating } = useFamilyMembers();
  const { updateProfile } = useUserProfile();

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
  const [photo, setPhoto] = useState<FamilyProfilePhotoSelection | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const showE2eFixturePhoto = isE2eFixturesEnabled();
  const defaultDobPickerDate = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 3);
    return d;
  }, []);
  const today = useMemo(() => new Date(), []);

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

  const applyE2eFixtures = async () => {
    setErrorMessage('');
    try {
      setPhoto(await loadE2eProfilePhoto());
      setName(E2E_FAMILY_MEMBER_NAME);
      setDateOfBirth(E2E_FAMILY_MEMBER_DOB);
      setGender(E2E_FAMILY_MEMBER_GENDER);
      setAdditionalInfo(E2E_FAMILY_MEMBER_NOTES);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not load E2E test data');
    }
  };

  const applyPickResult = useCallback((result: FamilyProfilePhotoPickResult) => {
    if (result.error) {
      setErrorMessage(result.error);
      return;
    }

    if (result.selection) {
      setPhoto(result.selection);
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
            void takePhoto();
          }
          if (buttonIndex === 1) {
            void choosePhotoFromLibrary();
          }
        },
      );
      return;
    }

    Alert.alert('Profile photo', undefined, [
      { text: 'Take photo', onPress: () => { void takePhoto(); } },
      { text: 'Choose from library', onPress: () => { void choosePhotoFromLibrary(); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleSave = async () => {
    setErrorMessage('');

    const nameError = validateFamilyMemberName(name);
    if (nameError) { setErrorMessage(nameError); return; }

    const dobError = validateDateOfBirth(dateOfBirth);
    if (dobError) { setErrorMessage(dobError); return; }

    if (!photo) { setErrorMessage('Profile photo is required'); return; }

    try {
      await createMember({
        name,
        dateOfBirth: dateOfBirth.trim(),
        gender: gender.trim() || undefined,
        additionalInfo: additionalInfo.trim() || undefined,
        nicknames: nicknames.length > 0 ? nicknames : undefined,
        photoUri: photo.uri,
        photoContentType: photo.contentType,
      });
      void updateProfile({ hasCompletedOnboarding: true });
      router.back();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save family member');
    }
  };

  return (
    <KeyboardAwareFormScreen>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backButton}
          testID="add-family-member-cancel"
        >
          <Text style={styles.backButtonText}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Add person</Text>
      </View>

      {/* ── Photo ── */}
      <View style={styles.photoSection}>
        <Pressable
          accessibilityRole="button"
          onPress={showProfilePhotoSourceChooser}
          style={styles.photoCircleWrap}
          testID="add-family-member-photo"
        >
          {photo ? (
            <Image
              source={{ uri: photo.uri }}
              style={styles.photoCircle}
              contentFit="cover"
              accessibilityLabel="Selected profile photo"
            />
          ) : (
            <View style={[styles.photoCircle, styles.photoCirclePlaceholder]}>
              <Text style={styles.photoCircleInitial}>+</Text>
            </View>
          )}
          <View style={styles.photoOverlay}>
            <Text style={styles.photoOverlayIcon}>📷</Text>
          </View>
        </Pressable>
        <Text style={styles.photoHint}>Take or choose a photo</Text>

        {showE2eFixturePhoto && (
          <Pressable
            accessibilityRole="button"
            onPress={() => void applyE2eFixtures()}
            style={styles.e2eBtn}
            testID="add-family-member-photo-fixture"
          >
            <Text style={styles.e2eBtnText}>Use E2E test data</Text>
          </Pressable>
        )}
      </View>

      {/* ── Form ── */}
      <View style={styles.form}>
        <AuthField label="Name">
          <AuthInput
            autoCapitalize="words"
            onChangeText={setName}
            placeholder="Name"
            testID="add-family-member-name"
            value={name}
          />
        </AuthField>

        <AuthField label="Date of birth">
          <DatePickerField
            defaultPickerDate={defaultDobPickerDate}
            maximumDate={today}
            onChange={setDateOfBirth}
            placeholder="Select date of birth"
            testID="add-family-member-dob"
            value={dateOfBirth}
          />
        </AuthField>

        <AuthField label="Gender (optional)">
          <SelectField
            onChange={setGender}
            options={GENDER_OPTIONS}
            placeholder="Select gender"
            testID="add-family-member-gender"
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
            inputTestID="add-family-member-nickname-input"
            addTestID="add-family-member-nickname-add"
          />
        </View>

        <AuthField label="Notes (optional)">
          <AuthInput
            multiline
            numberOfLines={3}
            onChangeText={setAdditionalInfo}
            placeholder="Physical traits, quirks, personality…"
            style={styles.notesInput}
            testID="add-family-member-notes"
            value={additionalInfo}
          />
        </AuthField>

        <AuthErrorMessage message={errorMessage} />

        <Pressable
          accessibilityRole="button"
          disabled={isCreating}
          onPress={handleSave}
          style={({ pressed }) => [
            styles.saveButton,
            isCreating && styles.saveButtonDisabled,
            pressed && !isCreating && styles.saveButtonPressed,
          ]}
          testID="add-family-member-save"
        >
          {isCreating ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.saveButtonText}>Add to family</Text>
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
    position: 'relative',
    width: 96,
    height: 96,
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
  e2eBtn: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  e2eBtnText: {
    fontFamily: fonts.sansBold,
    color: colors.ink3,
    fontSize: 13,
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
});
