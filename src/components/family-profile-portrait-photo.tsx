import { Image } from 'expo-image';
import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { GeneratingVisualOverlay } from '@/components/generating-visual-overlay';
import { LivingPortraitOverlay } from '@/components/living-portrait-overlay';
import { colors, fonts } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { FamilyMember } from '@/services/family-members';
import {
  getPortraitStatusLabel,
  getProfilePortraitPhotoKey,
  isPortraitInProgress,
  type IllustratedProfileStatus,
} from '@/utils/family-members';
import { mediaImageSource } from '@/utils/media-image-source';
import { getPortraitMotion } from '@/utils/portrait-motion';

export type FamilyProfilePortraitMember = Pick<
  FamilyMember,
  | 'name'
  | 'profile_picture_key'
  | 'illustrated_profile_key'
  | 'illustrated_profile_status'
  | 'updated_at'
> & Partial<
  Pick<FamilyMember, 'avatarImageKey' | 'avatarStatus' | 'avatarUpdatedAt' | 'resolvedPortraitVersion'>
>;

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
  /**
   * Opt-in living portrait (docs/plans/living-portraits.md): loops the
   * generated frames over the ready illustrated portrait. Never over a local
   * photo or the generating state. Only the profile header and Family tab
   * cards ask for it.
   */
  animated?: boolean;
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
  animated = false,
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
  const resolvedVersion = member.resolvedPortraitVersion;
  // The motion must be showing over the very still it was made from: the
  // displayed key is the resolved version's published illustration, not the
  // source photo a pending/failed portrait falls back to.
  const motion = animated
    && !localPhotoUri
    && !showGeneratingOverlay
    && status === 'ready'
    && displayUri
    && resolvedVersion?.illustrated_profile_key === remoteKey
    ? getPortraitMotion(resolvedVersion)
    : null;

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
          source={mediaImageSource(displayUri, localPhotoUri ? null : remoteKey)}
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

      {motion ? (
        <LivingPortraitOverlay borderRadius={resolvedRadius} coverColor={backgroundColor} motion={motion} />
      ) : null}

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
