import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { mediaImageSource } from '@/utils/media-image-source';
import type { PortraitMotion } from '@/utils/portrait-motion';

// Living portrait (docs/plans/living-portraits.md): the still stays underneath
// and this layer plays the generated frame sheet over it -- frame 0 held for
// 800ms, then 150ms per frame, forever. Hard cuts only; crossfading the frames
// ghosts two heads. Frames change by translating one oversized sheet inside a
// clipped box, driven by a single shared value on the UI thread, so playback
// never re-renders React.

export const LIVING_PORTRAIT_HOLD_MS = 800;
export const LIVING_PORTRAIT_FRAME_MS = 150;

/** One full loop: frame 0 held, then each remaining frame once. */
export function livingPortraitCycleMs(frameCount: number): number {
  return LIVING_PORTRAIT_HOLD_MS + Math.max(0, frameCount - 1) * LIVING_PORTRAIT_FRAME_MS;
}

/** Frame index (row-major) showing `elapsedMs` into the loop. Discrete: never fractional. */
export function livingPortraitFrameAt(elapsedMs: number, frameCount: number): number {
  'worklet';
  if (frameCount <= 1) return 0;
  const cycle = LIVING_PORTRAIT_HOLD_MS + (frameCount - 1) * LIVING_PORTRAIT_FRAME_MS;
  const t = ((elapsedMs % cycle) + cycle) % cycle;
  if (t < LIVING_PORTRAIT_HOLD_MS) return 0;
  return Math.min(frameCount - 1, 1 + Math.floor((t - LIVING_PORTRAIT_HOLD_MS) / LIVING_PORTRAIT_FRAME_MS));
}

function useIsAppActive(): boolean {
  // Initial read only rules out a known-inactive start ('unknown' just means
  // the first state event hasn't arrived yet).
  const [isActive, setIsActive] = useState(
    () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setIsActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  return isActive;
}

interface LivingPortraitFramesProps {
  motion: PortraitMotion;
  url: string;
  borderRadius?: number;
}

/** Keyed by URL at the call site so a re-signed/replaced sheet starts hidden again. */
function LivingPortraitFrames({ motion, url, borderRadius }: LivingPortraitFramesProps) {
  const { columns, rows } = motion;
  const frameCount = columns * rows;
  const [hasLoaded, setHasLoaded] = useState(false);
  const isAppActive = useIsAppActive();
  const elapsed = useSharedValue(0);

  useEffect(() => {
    // Paused (backgrounded) rests on frame 0, the still's own pose.
    elapsed.set(0);
    if (!isAppActive || !hasLoaded) return undefined;
    const cycleMs = livingPortraitCycleMs(frameCount);
    elapsed.set(withRepeat(withTiming(cycleMs, { duration: cycleMs, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(elapsed);
  }, [elapsed, frameCount, hasLoaded, isAppActive]);

  const sheetStyle = useAnimatedStyle(() => {
    const frame = livingPortraitFrameAt(elapsed.get(), frameCount);
    const column = frame % columns;
    const row = Math.floor(frame / columns);
    // Percent translates are relative to the sheet itself (columns x rows boxes).
    return {
      transform: [
        { translateX: `${-(column / columns) * 100}%` as const },
        { translateY: `${-(row / rows) * 100}%` as const },
      ],
    };
  });

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.window, { borderRadius, opacity: hasLoaded ? 1 : 0 }]}
      testID="living-portrait-overlay"
    >
      <Animated.View
        style={[{ width: `${columns * 100}%`, height: `${rows * 100}%` }, sheetStyle]}
        testID="living-portrait-strip"
      >
        <Image
          contentFit="fill"
          onLoad={() => setHasLoaded(true)}
          source={mediaImageSource(url, motion.key)}
          style={styles.sheet}
          testID="living-portrait-sheet"
        />
      </Animated.View>
    </View>
  );
}

interface LivingPortraitOverlayProps {
  motion: PortraitMotion;
  borderRadius?: number;
}

/**
 * Absolute-fill layer to render on top of an existing portrait still, inside a
 * box that already clips/rounds it. Renders nothing under Reduce Motion or
 * until the sheet has a signed URL; stays invisible until its image decodes.
 */
export function LivingPortraitOverlay({ motion, borderRadius }: LivingPortraitOverlayProps) {
  const reduceMotion = useReduceMotion();
  // Sheet objects are immutable per key, so the key is its own cache version.
  const { url } = useMediaUrl(reduceMotion ? null : motion.key, motion.key);

  if (reduceMotion || !url) return null;
  return <LivingPortraitFrames borderRadius={borderRadius} key={url} motion={motion} url={url} />;
}

const styles = StyleSheet.create({
  window: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
  },
  sheet: {
    height: '100%',
    width: '100%',
  },
});
