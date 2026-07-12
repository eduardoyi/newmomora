import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FamilyProfilePortraitPhoto } from '@/components/family-profile-portrait-photo';
import { colors, emotionColors, fonts, radius, type EmotionName } from '@/constants/theme';
import type { FamilyMember } from '@/services/family-members';
import { formatAgeFromDob } from '@/utils/family-members';

const PORTRAIT_TINTS: EmotionName[] = ['tender', 'joy', 'wonder', 'calm', 'mischief'];

export function memberTint(member: FamilyMember): EmotionName {
  return PORTRAIT_TINTS[member.name.charCodeAt(0) % PORTRAIT_TINTS.length];
}

interface CastCardProps {
  member: FamilyMember;
  onPortraitPress?: () => void;
}

export function CastCard({ member, onPortraitPress }: CastCardProps) {
  const emo = emotionColors[memberTint(member)];
  const age = member.date_of_birth ? formatAgeFromDob(member.date_of_birth) : null;
  return (
    <View style={styles.castCard}>
      <Pressable
        accessibilityLabel={onPortraitPress ? `View ${member.name}'s portrait full screen` : undefined}
        accessibilityRole={onPortraitPress ? 'button' : undefined}
        disabled={!onPortraitPress}
        onPress={onPortraitPress}
        style={({ pressed }) => [styles.castPortraitSlot, pressed && styles.portraitPressed]}
        testID="family-member-portrait"
      >
        <FamilyProfilePortraitPhoto
          accessibilityLabel={`${member.name} portrait`}
          backgroundColor={emo.soft}
          borderRadius={0}
          height={120}
          member={member}
          width={120}
        />
      </Pressable>

      <View style={styles.castInfo}>
        <Text style={styles.castName}>{member.name}</Text>
        {age && <Text style={styles.castAge}>{age}</Text>}
        {member.nicknames && member.nicknames.length > 0 && (
          <Text style={styles.castNicknames}>“{member.nicknames.join(', ')}”</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  castCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    overflow: 'hidden',
    maxHeight: 120,
  },
  castPortraitSlot: {
    flexShrink: 0,
    height: 120,
    overflow: 'hidden',
    width: 120,
  },
  portraitPressed: {
    opacity: 0.88,
  },
  castInfo: {
    flex: 1,
    padding: 16,
    gap: 5,
    justifyContent: 'center',
  },
  castName: {
    fontFamily: fonts.displayMedium,
    fontSize: 20,
    lineHeight: 22,
    color: colors.ink,
  },
  castAge: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  castNicknames: {
    fontFamily: fonts.script,
    fontSize: 16,
    color: colors.ink2,
    marginTop: 2,
  },
});
