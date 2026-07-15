import { Image } from 'expo-image';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { emotionColors, fonts, type EmotionName } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { FamilyMember } from '@/services/family-members';
import { getMemberAvatarImageKey } from '@/utils/family-members';

const PORTRAIT_TINTS: EmotionName[] = ['tender', 'joy', 'wonder', 'calm', 'mischief'];

export type FamilyMemberAvatarMember = Pick<
  FamilyMember,
  | 'name'
  | 'illustrated_profile_key'
  | 'illustrated_profile_status'
  | 'profile_picture_key'
  | 'updated_at'
> & Pick<FamilyMember, 'avatarImageKey' | 'avatarUpdatedAt'>;

interface FamilyMemberAvatarProps {
  member: FamilyMemberAvatarMember;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function FamilyMemberAvatar({ member, size = 22, style, testID }: FamilyMemberAvatarProps) {
  const imageKey = getMemberAvatarImageKey(member);
  const { url } = useMediaUrl(imageKey, member.avatarUpdatedAt ?? member.updated_at);
  const tint = PORTRAIT_TINTS[member.name.charCodeAt(0) % PORTRAIT_TINTS.length];
  const emo = emotionColors[tint];

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: emo.soft,
        },
        style,
      ]}
      testID={testID}
    >
      {url ? (
        <Image
          accessibilityLabel={`${member.name} portrait`}
          contentFit="cover"
          source={{ uri: url }}
          style={{ width: size, height: size }}
        />
      ) : (
        <Text style={[styles.initial, { fontSize: size * 0.4, color: emo.ink }]}>
          {member.name.charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initial: {
    fontFamily: fonts.sansBold,
  },
});
