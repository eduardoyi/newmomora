import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '@/constants/theme';

interface FamilyEmptyStateProps {
  onAddMember: () => void;
}

export function FamilyEmptyState({ onAddMember }: FamilyEmptyStateProps) {
  return (
    <View style={styles.container} testID="family-empty-state">
      <Text style={styles.eyebrow}>Start here</Text>
      <Text style={styles.title}>Add your child first</Text>
      <Text style={styles.body}>
        Momora is about capturing their moments. Add a family member with a photo so we can create
        their character portrait before you journal.
      </Text>

      <Pressable
        accessibilityRole="button"
        onPress={onAddMember}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        testID="family-add-first-member"
      >
        <Text style={styles.buttonText}>Add family member</Text>
      </Pressable>
    </View>
  );
}

interface SelectedPhotoPreviewProps {
  uri: string;
  onChangePhoto: () => void;
}

export function SelectedPhotoPreview({ uri, onChangePhoto }: SelectedPhotoPreviewProps) {
  return (
    <View style={styles.previewWrap}>
      <Image accessibilityLabel="Selected profile photo" source={{ uri }} style={styles.previewImage} />
      <Pressable
        accessibilityRole="button"
        onPress={onChangePhoto}
        style={styles.changePhotoButton}
        testID="family-change-photo"
      >
        <Text style={styles.changePhotoText}>Change photo</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  eyebrow: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  body: {
    color: colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 12,
    marginTop: spacing.sm,
    paddingVertical: 16,
  },
  buttonPressed: {
    backgroundColor: colors.primaryDark,
  },
  buttonText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
  },
  previewWrap: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  previewImage: {
    borderRadius: 16,
    height: 180,
    width: 180,
  },
  changePhotoButton: {
    paddingVertical: spacing.sm,
  },
  changePhotoText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
});
