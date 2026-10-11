import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import {
  Easing,
  type AnimatedStyle,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { REVEAL_DROP_PX, REVEAL_START_TILT } from '@/components/artwork/artwork-layout';
import { consumeArtworkReveal } from '@/utils/artwork-reveal';

// The Timeline reveal (docs/plans/artwork-scanning-v2.md decision 8, canvas
// Moments.dc.html): a freshly posted piece drops in from `REVEAL_DROP_PX` (40) above, tilted 9
// degrees (380ms ease-out), swings about its top-center in two damped swings
// (~900ms) and settles at its own tilt; the label fades in last. Reduced motion
// gets a plain fade.
//
// `ArtworkRevealDriver` is only mounted for a card that has a pending reveal
// mark (`consumeArtworkReveal`), so ordinary cards in the virtualized list
// carry no shared values or animated styles at all.

// The drop and start tilt live in artwork-layout.ts next to the other pose
// numbers. They are not reserved in any layout (a ~1s transient may overlap).
export { REVEAL_DROP_PX, REVEAL_START_TILT };
export const REVEAL_DROP_MS = 380;
export const REVEAL_LABEL_DELAY_MS = 700;
export const REVEAL_LABEL_FADE_MS = 240;
export const REVEAL_FADE_IN_MS = 140;
export const REVEAL_REDUCED_FADE_MS = 250;
/** Underdamped (damping ratio ~0.2) with a ~450ms period: two visible swings
 * over ~900ms. The energy threshold ends the spring once the remaining swing
 * is a fraction of a degree instead of ringing for seconds. */
export const REVEAL_SPRING = {
  damping: 6,
  energyThreshold: 1e-3,
  mass: 1,
  stiffness: 200,
} as const;

type AnimatedViewStyle = StyleProp<AnimatedStyle<StyleProp<ViewStyle>>>;

export interface ArtworkRevealStyles {
  /** Drop + swing about the wrapper's top-center. Apply with `revealPivot`. */
  frame: AnimatedViewStyle;
  /** Opacity only (the pieces stacked behind a deck's front card). */
  fade: AnimatedViewStyle;
  /** Opacity only, delayed: the label that fades in last. */
  label: AnimatedViewStyle;
}

/** Style that makes an Animated.View swing about its top-center. */
export const revealPivot = StyleSheet.create({
  pivot: { transformOrigin: ['50%', 0, 0] },
}).pivot;

/** Consumes the memory's reveal mark once, at first render (never again for
 * this mount). A lazy `useState` initializer so the very first frame is
 * already hidden when a reveal is about to play. */
export function useShouldRevealArtwork(memoryId: string): boolean {
  const [shouldReveal] = useState(() => consumeArtworkReveal(memoryId));
  return shouldReveal;
}

export function ArtworkRevealDriver({
  tilt,
  children,
}: {
  /** The piece's own tilt, which the swing settles into. */
  tilt: number;
  children: (styles: ArtworkRevealStyles) => ReactNode;
}) {
  const y = useSharedValue(-REVEAL_DROP_PX);
  const swing = useSharedValue(REVEAL_START_TILT - tilt);
  const alpha = useSharedValue(0);
  const labelAlpha = useSharedValue(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(AccessibilityInfo.isReduceMotionEnabled())
      .catch(() => false)
      .then((reduceMotion) => {
        if (cancelled) return;
        if (reduceMotion) {
          y.set(0);
          swing.set(0);
          alpha.set(withTiming(1, { duration: REVEAL_REDUCED_FADE_MS }));
          labelAlpha.set(withTiming(1, { duration: REVEAL_REDUCED_FADE_MS }));
          return;
        }
        alpha.set(withTiming(1, { duration: REVEAL_FADE_IN_MS }));
        y.set(withTiming(0, { duration: REVEAL_DROP_MS, easing: Easing.out(Easing.cubic) }));
        // Held at 9 degrees during the drop, then released into the swing.
        swing.set(
          withSequence(
            withTiming(REVEAL_START_TILT - tilt, { duration: REVEAL_DROP_MS }),
            withSpring(0, REVEAL_SPRING),
          ),
        );
        labelAlpha.set(
          withSequence(
            withTiming(0, { duration: REVEAL_LABEL_DELAY_MS }),
            withTiming(1, { duration: REVEAL_LABEL_FADE_MS }),
          ),
        );
      });
    return () => {
      cancelled = true;
    };
    // Plays once per mount; the shared values are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frame = useAnimatedStyle<ViewStyle>(() => ({
    opacity: alpha.get(),
    transform: [{ translateY: y.get() }, { rotate: `${swing.get()}deg` }],
  }));
  const fade = useAnimatedStyle<ViewStyle>(() => ({ opacity: alpha.get() }));
  const label = useAnimatedStyle<ViewStyle>(() => ({ opacity: labelAlpha.get() }));

  return <>{children({ frame, fade, label })}</>;
}
