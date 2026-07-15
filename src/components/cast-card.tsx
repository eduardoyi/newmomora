import { SymbolView } from 'expo-symbols';
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
  onPortraitTimelinePress?: () => void;
  portraitCount?: number;
}

export function CastCard({
  member,
  onPortraitPress,
  onPortraitTimelinePress,
  portraitCount = 0,
}: CastCardProps) {
  const emo = emotionColors[memberTint(member)];
  const age = member.date_of_birth ? formatAgeFromDob(member.date_of_birth) : null;
  return (
    <View style={styles.castCard}>
      <View style={styles.castPortraitSlot}>
        <Pressable
          accessibilityLabel={onPortraitPress ? `View ${member.name}'s portrait full screen` : undefined}
          accessibilityRole={onPortraitPress ? 'button' : undefined}
          disabled={!onPortraitPress}
          onPress={onPortraitPress}
          style={({ pressed }) => [styles.castPortraitPressable, pressed && styles.portraitPressed]}
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
        {onPortraitTimelinePress ? (
          <Pressable
            accessibilityLabel={`Open portrait timeline, ${portraitCount} ${portraitCount === 1 ? 'portrait' : 'portraits'}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onPortraitTimelinePress}
            style={({ pressed }) => [styles.historyButton, pressed && styles.portraitPressed]}
            testID="family-member-portrait-history"
          >
            <SymbolView
              fallback={<Text style={styles.historyFallback}>↻</Text>}
              name={{ ios: 'clock.arrow.circlepath', android: 'history' }}
              size={17}
              tintColor={colors.ink}
            />
            {portraitCount > 0 ? (
              <View style={styles.historyCount}>
                <Text style={styles.historyCountText}>{portraitCount}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
      </View>

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
    position: 'relative',
    width: 120,
  },
  castPortraitPressable: {
    height: 120,
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
  historyButton: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: 17,
    borderWidth: 1,
    bottom: 8,
    elevation: 3,
    height: 34,
    justifyContent: 'center',
    position: 'absolute',
    right: 8,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    width: 34,
  },
  historyFallback: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 17,
  },
  historyCount: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderColor: colors.white,
    borderRadius: 9,
    borderWidth: 1.5,
    height: 18,
    justifyContent: 'center',
    minWidth: 18,
    paddingHorizontal: 4,
    position: 'absolute',
    right: -5,
    top: -5,
  },
  historyCountText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    lineHeight: 12,
  },
});
