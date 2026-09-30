// The stand-in for a Year Film that is being remade after an edit removed
// moments (`filmDisplayState` = 'remaking'): a paper-toned 9:16 frame with a
// gentle pulse, a small spinner and "Remaking your film..." copy. No poster (a
// blocked film is never signed), no play button. Shared by the Timeline
// polaroid (`variant="card"`, sits where the cover sits) and the Keepsakes
// tiles (`variant="tile"`, "Remaking..." only). Pulse pattern as
// book-cover-tile's PulseBar / gallery-import BreathingDot; Reduce Motion
// keeps everything static (no pulse, no spinner).
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { colors, fonts } from '@/constants/theme';

export interface RemakingPlaceholderProps {
  width: number;
  /** Defaults to `width * 16 / 9`. */
  height?: number;
  /** Defaults to 12. */
  radius?: number;
  /** `card`: the Timeline polaroid (two text lines); `tile`: Keepsakes (one short line). */
  variant: 'card' | 'tile';
  testID?: string;
}

export const REMAKING_CARD_TITLE = 'Remaking your film…';
export const REMAKING_CARD_SUBTITLE = 'This takes a few minutes';
export const REMAKING_TILE_LABEL = 'Remaking…';

export function RemakingPlaceholder({ width, height, radius = 12, variant, testID }: RemakingPlaceholderProps) {
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(0.3);
  useEffect(() => {
    if (reducedMotion) {
      pulse.set(0.5);
      return;
    }
    pulse.set(withRepeat(withTiming(0.75, { duration: 1400 }), -1, true));
  }, [pulse, reducedMotion]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.get() }));

  const resolvedHeight = height ?? Math.round((width * 16) / 9);
  const isCard = variant === 'card';

  return (
    <View
      style={[styles.frame, { width, height: resolvedHeight, borderRadius: radius }]}
      testID={testID}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.pulse, pulseStyle]} />
      <View style={styles.content}>
        {reducedMotion ? null : (
          <ActivityIndicator
            color={colors.primary}
            size="small"
            testID={testID ? `${testID}-spinner` : undefined}
          />
        )}
        <Text style={isCard ? styles.cardTitle : styles.tileLabel}>
          {isCard ? REMAKING_CARD_TITLE : REMAKING_TILE_LABEL}
        </Text>
        {isCard ? <Text style={styles.cardSubtitle}>{REMAKING_CARD_SUBTITLE}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    backgroundColor: colors.surface2,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  pulse: { backgroundColor: colors.primaryTint },
  content: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
  },
  cardTitle: {
    color: colors.ink,
    fontFamily: fonts.displayMedium,
    fontSize: 22,
    lineHeight: 28,
    textAlign: 'center',
  },
  cardSubtitle: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  tileLabel: {
    color: colors.ink2,
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'center',
  },
});
