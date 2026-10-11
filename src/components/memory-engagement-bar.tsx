import * as Haptics from 'expo-haptics';
import { MessageCircle, Plus, Send, SmilePlus } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { MemoryReactionsSheet } from '@/components/memory-reactions-sheet';
import { ReactionEmojiPicker } from '@/components/reaction-emoji-picker';
import { ReactionTray, type ReactionTrayAnchor } from '@/components/reaction-tray';
import { colors, fonts, radius } from '@/constants/theme';
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
  const previousReaction = useRef(engagement.myReaction);
  const addButtonRef = useRef<View>(null);
  const pillRef = useRef<View>(null);
  const [trayAnchor, setTrayAnchor] = useState<ReactionTrayAnchor | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMounted, setPickerMounted] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);
  const pickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Pop whenever a reaction is set or changed (not on removal).
    if (engagement.myReaction && engagement.myReaction !== previousReaction.current) {
      scale.setValue(1);
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.32, duration: 120, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
      ]).start();
    }
    previousReaction.current = engagement.myReaction;
  }, [engagement.myReaction, scale]);

  useEffect(
    () => () => {
      if (pickerTimerRef.current) clearTimeout(pickerTimerRef.current);
    },
    [],
  );

  const openTrayFrom = (node: View | null, haptic: Haptics.ImpactFeedbackStyle) => {
    void Haptics.impactAsync(haptic).catch(() => {});
    if (!node) return;
    node.measureInWindow((x, y, width, height) => {
      setTrayAnchor({ x, y, width, height });
    });
  };

  const closeTray = useCallback(() => setTrayAnchor(null), []);

  // Picking the caller's current emoji removes it (WhatsApp-style toggle).
  const applyReaction = (emoji: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    void engagement.setReaction(emoji === engagement.myReaction ? null : emoji).catch(() => {});
  };

  const handleTraySelect = (emoji: string) => {
    closeTray();
    applyReaction(emoji);
  };

  const handleOpenPicker = () => {
    closeTray();
    setPickerMounted(true);
    // Let the tray modal finish dismissing first -- iOS drops a Modal that
    // is presented while another is still animating out.
    if (pickerTimerRef.current) clearTimeout(pickerTimerRef.current);
    pickerTimerRef.current = setTimeout(() => setPickerOpen(true), 250);
  };

  const handlePickerPick = (emoji: string) => {
    setPickerOpen(false);
    applyReaction(emoji);
  };

  // Each emoji gets its own <Text>: a joined multi-emoji string was laid out
  // but not drawn on Android. Fallback when the server sent no top list.
  const pillEmojis = (
    engagement.topReactions.length > 0
      ? engagement.topReactions
      : [engagement.myReaction ?? '❤️']
  ).slice(0, 3);

  const openReactionsSheet = () => {
    setSheetMounted(true);
    setSheetOpen(true);
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
      {engagement.likeCount > 0 ? (
        <Animated.View
          collapsable={false}
          ref={pillRef as never}
          style={[
            styles.pill,
            engagement.myReaction ? styles.pillMine : styles.pillNeutral,
            { transform: [{ scale }] },
          ]}
        >
          <Pressable
            accessibilityHint="Touch and hold to change your reaction"
            accessibilityLabel={`${engagement.likeCount} ${engagement.likeCount === 1 ? 'reaction' : 'reactions'}, ${
              engagement.myReaction ? `you reacted ${engagement.myReaction}` : 'not reacted'
            }. Double tap to see who reacted`}
            accessibilityRole="button"
            accessibilityState={{ selected: engagement.myReaction != null, busy: engagement.isUpdatingLike }}
            delayLongPress={300}
            onLongPress={() => openTrayFrom(pillRef.current, Haptics.ImpactFeedbackStyle.Medium)}
            onPress={openReactionsSheet}
            style={({ pressed }) => [
              styles.pillSegment,
              engagement.myReaction == null && styles.pillSegmentWithPlus,
              pressed && styles.pressed,
            ]}
            testID={`memory-reactions-${memory.id}`}
          >
            {pillEmojis.map((emoji, index) => (
              <Text key={`${emoji}-${index}`} style={styles.pillEmoji}>
                {emoji}
              </Text>
            ))}
            <Text style={[styles.count, engagement.myReaction != null && styles.likedCount]}>
              {engagement.likeCount}
            </Text>
          </Pressable>
          {engagement.myReaction == null ? (
            <>
              <View style={styles.pillDivider} testID={`memory-reactions-divider-${memory.id}`} />
              <Pressable
                accessibilityLabel="Add reaction"
                accessibilityRole="button"
                accessibilityState={{ busy: engagement.isUpdatingLike }}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 8 }}
                onPress={() => openTrayFrom(pillRef.current, Haptics.ImpactFeedbackStyle.Light)}
                style={({ pressed }) => [styles.plusSegment, pressed && styles.pressed]}
                testID={`memory-react-${memory.id}`}
              >
                <Plus color={colors.ink2} size={16} strokeWidth={2} />
              </Pressable>
            </>
          ) : null}
        </Animated.View>
      ) : (
        <Pressable
          accessibilityLabel="Add reaction"
          accessibilityRole="button"
          accessibilityState={{ busy: engagement.isUpdatingLike }}
          onPress={() => openTrayFrom(addButtonRef.current, Haptics.ImpactFeedbackStyle.Light)}
          ref={addButtonRef}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          testID={`memory-react-${memory.id}`}
        >
          <SmilePlus color={colors.ink2} size={iconSize} strokeWidth={1.9} />
        </Pressable>
      )}

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

      <ReactionTray
        anchor={trayAnchor}
        currentEmoji={engagement.myReaction}
        onClose={closeTray}
        onOpenPicker={handleOpenPicker}
        onSelect={handleTraySelect}
        visible={trayAnchor !== null}
      />
      {pickerMounted ? (
        <ReactionEmojiPicker
          onClose={() => setPickerOpen(false)}
          onPick={handlePickerPick}
          open={pickerOpen}
        />
      ) : null}
      {sheetMounted ? (
        <MemoryReactionsSheet
          memory={memory}
          onClose={() => setSheetOpen(false)}
          visible={sheetOpen}
        />
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
  pill: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 32,
    overflow: 'hidden',
  },
  pillSegment: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 10,
  },
  pillSegmentWithPlus: {
    paddingRight: 8,
  },
  pillDivider: {
    alignSelf: 'stretch',
    backgroundColor: colors.border,
    width: 1,
  },
  plusSegment: {
    alignItems: 'center',
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: 9,
  },
  pillNeutral: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  pillMine: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primary,
  },
  pillEmoji: {
    fontSize: 15,
    lineHeight: 19,
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
