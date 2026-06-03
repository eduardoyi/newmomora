import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FamilyProfilePortraitPhoto } from '@/components/family-profile-portrait-photo';
import { colors, emotionColors, fonts, radius, spacing, type EmotionName } from '@/constants/theme';
import {
  formatAgeFromDob,
  getPortraitStatusLabel,
  isPortraitInProgress,
  type IllustratedProfileStatus,
} from '@/utils/family-members';
import type { FamilyMember } from '@/services/family-members';

const TINTS: EmotionName[] = ['tender', 'joy', 'wonder', 'calm', 'mischief'];

interface FamilyMemberCardProps {
  member: FamilyMember;
  onPress?: () => void;
  onDelete?: () => void;
  isDeleting?: boolean;
}

export function FamilyMemberCard({ member, onPress, onDelete, isDeleting }: FamilyMemberCardProps) {
  const ageLabel = member.date_of_birth ? formatAgeFromDob(member.date_of_birth) : null;
  const portraitStatus = member.illustrated_profile_status as IllustratedProfileStatus;
  const statusLabel = getPortraitStatusLabel(portraitStatus);
  const showStatusText = !isPortraitInProgress(portraitStatus);

  const tintIndex = member.name.charCodeAt(0) % TINTS.length;
  const tint = TINTS[tintIndex];
  const emo = emotionColors[tint];

  return (
    <Pressable
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && onPress && styles.cardPressed]}
      testID={`family-member-card-${member.id}`}
    >
      <FamilyProfilePortraitPhoto
        accessibilityLabel={`${member.name} profile photo`}
        backgroundColor={emo.soft}
        height={72}
        member={member}
        width={72}
      />

      <View style={styles.content}>
        <Text style={styles.name} testID={`family-member-name-${member.id}`}>
          {member.name}
        </Text>
        {ageLabel ? <Text style={styles.meta}>{ageLabel}</Text> : null}
        {showStatusText ? (
          <Text style={[styles.status, { color: emo.c }]}>{statusLabel}</Text>
        ) : null}
        {onDelete ? (
          <Pressable
            accessibilityRole="button"
            disabled={isDeleting}
            onPress={onDelete}
            style={styles.deleteButton}
            testID={`family-member-delete-${member.id}`}
          >
            <Text style={styles.deleteText}>{isDeleting ? 'Removing…' : 'Remove'}</Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    overflow: 'hidden',
  },
  cardPressed: {
    opacity: 0.9,
  },
  content: {
    flex: 1,
    gap: 4,
  },
  name: {
    fontFamily: fonts.displayMedium,
    color: colors.ink,
    fontSize: 18,
  },
  meta: {
    fontFamily: fonts.sans,
    color: colors.ink3,
    fontSize: 14,
  },
  status: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
  },
  deleteButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
  },
  deleteText: {
    fontFamily: fonts.sansBold,
    color: colors.error,
    fontSize: 14,
  },
});
