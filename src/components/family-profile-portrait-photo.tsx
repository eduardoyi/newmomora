import { Image } from 'expo-image';
import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { GeneratingVisualOverlay } from '@/components/generating-visual-overlay';
import { colors, fonts } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { FamilyMember } from '@/services/family-members';
import {
  getPortraitStatusLabel,
  getProfilePortraitPhotoKey,
  isPortraitInProgress,
  type IllustratedProfileStatus,
} from '@/utils/family-members';

export type FamilyProfilePortraitMember = Pick<
  FamilyMember,
  | 'name'
  | 'profile_picture_key'
  | 'illustrated_profile_key'
  | 'illustrated_profile_status'
  | 'updated_at'
> & Partial<Pick<FamilyMember, 'avatarImageKey' | 'avatarStatus' | 'avatarUpdatedAt'>>;

interface FamilyProfilePortraitPhotoProps {
  member: FamilyProfilePortraitMember;
  /** Local file URI while the user is picking a photo before save. */
  localPhotoUri?: string | null;
  /** Show the generating overlay before server status catches up (e.g. during save). */
  forceGeneratingOverlay?: boolean;
  width: number;
  height?: number;
  borderRadius?: number;
  backgroundColor?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function FamilyProfilePortraitPhoto({
  member,
  localPhotoUri,
  forceGeneratingOverlay = false,
  width,
  height = width,
  borderRadius,
  backgroundColor = colors.surface,
  style,
  accessibilityLabel,
}: FamilyProfilePortraitPhotoProps) {
  const status = (
    'avatarStatus' in member
      ? member.avatarStatus ?? 'pending'
      : member.illustrated_profile_status ?? 'pending'
  ) as IllustratedProfileStatus;
  const showGeneratingOverlay = isPortraitInProgress(status) || forceGeneratingOverlay;
  const remoteKey = getProfilePortraitPhotoKey(member);
  const { url: remoteUrl, isLoading } = useMediaUrl(
    localPhotoUri ? null : remoteKey,
    member.avatarUpdatedAt ?? member.updated_at,
  );
  const displayUri = localPhotoUri ?? remoteUrl;
  const resolvedRadius = borderRadius ?? width / 2;
  const sparkleSize = width >= 96 ? 28 : width >= 72 ? 22 : 18;
  const compact = width < 96;
  const photoStyle = { width, height };

  return (
    <View
      style={[
        styles.frame,
        {
          width,
          height,
          borderRadius: resolvedRadius,
          backgroundColor,
        },
        style,
      ]}
    >
      {displayUri ? (
        <Image
          accessibilityLabel={accessibilityLabel ?? `${member.name} profile photo`}
          contentFit="cover"
          source={{
            uri: displayUri,
            cacheKey: localPhotoUri ? undefined : remoteKey ?? undefined,
          }}
          style={photoStyle}
        />
      ) : isLoading ? (
        <View style={[styles.placeholder, photoStyle]}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <View style={[styles.placeholder, photoStyle]}>
          <Text style={[styles.initial, { fontSize: width * 0.38 }]}>
            {member.name.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}

      {showGeneratingOverlay ? (
        <GeneratingVisualOverlay
          compact={compact}
          label={
            forceGeneratingOverlay && !isPortraitInProgress(status)
              ? 'Generating portrait…'
              : getPortraitStatusLabel(status)
          }
          sparkleSize={sparkleSize}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    position: 'relative',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: colors.ink3,
    fontFamily: fonts.displayItalic,
  },
});
