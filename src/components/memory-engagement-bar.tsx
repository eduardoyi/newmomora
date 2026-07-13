import * as Haptics from 'expo-haptics';
import { Heart, MessageCircle } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';
import { useMemoryEngagement } from '@/hooks/useMemoryEngagement';
import type { MemoryWithTags } from '@/services/memories';

interface MemoryEngagementBarProps {
  memory: MemoryWithTags;
  onOpenComments: () => void;
  iconSize?: number;
}

export function MemoryEngagementBar({
  memory,
  onOpenComments,
  iconSize = 22,
}: MemoryEngagementBarProps) {
  const engagement = useMemoryEngagement(memory);
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
