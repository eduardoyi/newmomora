import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
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

interface FrameSize {
  width: number;
  height: number;
}

/** Keyed by URL at the call site so a re-signed/replaced sheet starts hidden again. */
function LivingPortraitFrames({ motion, url, borderRadius }: LivingPortraitFramesProps) {
  const { columns, rows } = motion;
  const frameCount = columns * rows;
  const [hasLoaded, setHasLoaded] = useState(false);
  // The sheet is sized and moved in measured pixels, not percentages: on
  // Android a percent-sized/-translated sheet briefly laid out at the box's own
  // size (the whole grid shrunk into one frame) before filling it.
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);
  const isAppActive = useIsAppActive();
  const elapsed = useSharedValue(0);
  const frameWidth = useSharedValue(0);
  const frameHeight = useSharedValue(0);

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    frameWidth.set(width);
    frameHeight.set(height);
    setFrameSize((current) => (
      current && current.width === width && current.height === height ? current : { width, height }
    ));
  };

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
    return {
      transform: [
        { translateX: -column * frameWidth.get() },
        { translateY: -row * frameHeight.get() },
      ],
    };
  });

  const sheetSize = frameSize
    ? { width: columns * frameSize.width, height: rows * frameSize.height }
    : null;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={handleLayout}
      pointerEvents="none"
      style={[styles.window, { borderRadius, opacity: hasLoaded && sheetSize ? 1 : 0 }]}
      testID="living-portrait-overlay"
    >
      {sheetSize ? (
        <Animated.View style={[sheetSize, sheetStyle]} testID="living-portrait-strip">
          <Image
            contentFit="fill"
            onLoad={() => setHasLoaded(true)}
            source={mediaImageSource(url, motion.key)}
            style={sheetSize}
            testID="living-portrait-sheet"
          />
        </Animated.View>
      ) : null}
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
});
