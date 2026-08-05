import * as Haptics from 'expo-haptics';
import { Heart, MessageCircle, Send } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useMemoryEngagement } from '@/hooks/useMemoryEngagement';
import { useShareMemoryCard } from '@/hooks/useShareMemoryCard';
import type { MemoryWithTags } from '@/services/memories';

interface MemoryEngagementBarProps {
  memory: MemoryWithTags;
  onOpenComments: () => void;
  iconSize?: number;
  /**
   * Opts this bar instance into the share icon (S4,
   * docs/plans/offline-awareness-and-share-cards.md). `MemoryEngagementBar`
   * is shared UI -- only timeline cards (memory-card.tsx) and the memory
   * detail screen pass this; the full-screen media viewer never renders
   * this bar at all. Defaults to hidden so any future caller must opt in
   * explicitly rather than getting the icon for free.
   */
  enableShare?: boolean;
  /**
   * The `memory_media.id` of the carousel page currently on screen, lifted
   * from `memory-media-carousel.tsx`'s `onActiveIndexChange` by
   * memory-card.tsx / the detail screen. `null`/`undefined` for text-only
   * and illustrated memories, which don't need a `mediaAssetId`.
   */
  currentMediaAssetId?: string | null;
  /**
   * True while the current carousel page is a video -- disables (dims) the
   * share icon rather than hiding it, since a mixed carousel's other pages
   * may still be shareable. A video-only memory's active page is always a
   * video, so this alone also covers that case without extra logic.
   */
  isCurrentPageVideo?: boolean;
}

export function MemoryEngagementBar({
  memory,
  onOpenComments,
  iconSize = 22,
  enableShare = false,
  currentMediaAssetId = null,
  isCurrentPageVideo = false,
}: MemoryEngagementBarProps) {
  const engagement = useMemoryEngagement(memory);
  const { role, family } = useFamily();
  const { shareMemoryCard, isSharing } = useShareMemoryCard();
  const [scale] = useState(() => new Animated.Value(1));
  const previousLiked = useRef(engagement.likedByMe);

  useEffect(() => {
    if (engagement.likedByMe && !previousLiked.current) {
      scale.setValue(1);
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.32, duration: 120, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
      ]).start();
    }
    previousLiked.current = engagement.likedByMe;
  }, [engagement.likedByMe, scale]);

  const handleLike = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    void engagement.toggleLike().catch(() => {});
  };

  // Visibility (S4): a viewer is blocked ONLY when the family has
  // explicitly turned sharing off. `viewerSharingEnabled` missing/undefined
  // (not yet loaded, or a membership cached before S2 shipped) reads as
  // enabled -- the column's own DB default -- never as disabled. Owner/
  // manager always see the icon regardless of the toggle (server-enforced
  // too; see compose-share-card's authorizeShareCardAccess).
  const viewerSharingEnabled = family?.viewerSharingEnabled ?? true;
  const isShareBlockedForViewer = role === 'viewer' && viewerSharingEnabled === false;
  const showShare = enableShare && !isShareBlockedForViewer;
  const shareDisabled = isCurrentPageVideo || isSharing;

  const handleShare = () => {
    void shareMemoryCard(memory, currentMediaAssetId ?? undefined);
  };

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel={engagement.likedByMe ? 'Unlike memory' : 'Like memory'}
        accessibilityRole="button"
        accessibilityState={{ selected: engagement.likedByMe, busy: engagement.isUpdatingLike }}
        onPress={handleLike}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        testID={`memory-like-${memory.id}`}
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          <Heart
            color={engagement.likedByMe ? colors.primary : colors.ink2}
            fill={engagement.likedByMe ? colors.primary : 'transparent'}
            size={iconSize}
            strokeWidth={1.9}
          />
        </Animated.View>
        {engagement.likeCount > 0 ? (
          <Text
            style={[
              styles.count,
              engagement.likedByMe && styles.likedCount,
            ]}
          >
            {engagement.likeCount}
          </Text>
        ) : null}
      </Pressable>

      <Pressable
        accessibilityLabel="Open comments"
        accessibilityRole="button"
        onPress={onOpenComments}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        testID={`memory-comments-${memory.id}`}
      >
        <MessageCircle color={colors.ink2} size={iconSize} strokeWidth={1.9} />
        {engagement.commentCount > 0 ? (
          <Text style={styles.count}>{engagement.commentCount}</Text>
        ) : null}
      </Pressable>

      {showShare ? (
        <Pressable
          accessibilityLabel="Share memory"
          accessibilityRole="button"
          accessibilityState={{ disabled: shareDisabled, busy: isSharing }}
          disabled={shareDisabled}
          onPress={handleShare}
          style={({ pressed }) => [styles.action, (pressed || shareDisabled) && styles.pressed]}
          testID={`memory-share-${memory.id}`}
        >
          {isSharing ? (
            <ActivityIndicator color={colors.ink2} size="small" />
          ) : (
            <Send color={colors.ink2} size={iconSize} strokeWidth={1.9} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 20,
  },
  action: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
    minHeight: 36,
  },
  pressed: {
    opacity: 0.65,
  },
  count: {
    color: colors.ink2,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
  },
  likedCount: {
    color: colors.primary,
  },
});
