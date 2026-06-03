import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';

interface AnimatedSparkleProps {
  size?: number;
}

export function AnimatedSparkle({ size = 28 }: AnimatedSparkleProps) {
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 2500,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [rotation]);

  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.Text style={[styles.sparkleIcon, { fontSize: size, transform: [{ rotate }] }]}>
      ✦
    </Animated.Text>
  );
}

interface GeneratingVisualOverlayProps {
  label: string;
  sparkleSize?: number;
  compact?: boolean;
  /** `overlay` covers a photo; `inline` centers in a placeholder frame. */
  variant?: 'overlay' | 'inline';
}

/** Spinner-style overlay reused for illustrations and portrait generation. */
export function GeneratingVisualOverlay({
  label,
  sparkleSize = 28,
  compact = false,
  variant = 'overlay',
}: GeneratingVisualOverlayProps) {
  return (
    <View
      style={variant === 'overlay' ? styles.overlay : styles.inline}
      pointerEvents="none"
    >
      <AnimatedSparkle size={sparkleSize} />
      <Text style={[styles.label, compact && styles.labelCompact]} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
    zIndex: 1,
  },
  sparkleIcon: {
    color: colors.primary,
  },
  label: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 13,
    textAlign: 'center',
  },
  labelCompact: {
    fontSize: 10,
    lineHeight: 12,
  },
  inline: {
    alignItems: 'center',
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
});
