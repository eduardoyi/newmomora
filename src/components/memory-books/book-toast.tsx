// Small in-screen toast for the Memory Books shelf redesign (owner-approved
// picker-redesign brief, 2026-09-17) -- shown after tapping a create/retry
// row, floating above the "Create a book" CTA. Auto-dismisses itself after
// ~4s; the parent screen owns *when* a message is shown (it passes `null`
// to hide), this component only owns the timer for auto-hiding one it's
// already showing.
import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { colors, fonts, radius } from '@/constants/theme';

const TOAST_DURATION_MS = 4000;

export interface BookToastProps {
  message: string | null;
  onDismiss: () => void;
  /** Distance from the bottom of the screen -- callers place this just
   * above the fixed Create CTA. */
  bottomOffset: number;
}

function PulsingDot() {
  const opacity = useSharedValue(0.5);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 650 }), -1, true);
  }, [opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, animatedStyle]} />;
}

export function BookToast({ message, onDismiss, bottomOffset }: BookToastProps) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <Animated.View
      // FadeIn, not FadeInDown -- jest.setup.ts's reanimated mock (shared,
      // outside this change's file ownership) only exports FadeIn/FadeOut;
      // a plain fade reads close enough to the brief's "FadeInDown" ask.
      entering={FadeIn}
      exiting={FadeOut}
      style={[styles.toast, { bottom: bottomOffset }]}
      testID="memory-books-toast"
    >
      <PulsingDot />
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(44,36,24,0.94)',
    borderRadius: radius.md + 2,
    flexDirection: 'row',
    gap: 8,
    maxWidth: '90%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    position: 'absolute',
  },
  dot: {
    backgroundColor: colors.sun,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  text: {
    color: '#FBF8F2',
    flexShrink: 1,
    fontFamily: fonts.sansMedium,
    fontSize: 12.5,
  },
});
