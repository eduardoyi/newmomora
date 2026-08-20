// The wax-seal play/pause control every sound surface shares -- a pressed
// stamp, not a media-player button. Ported from the design prototype's
// `ListenSeal` (audio-kit.jsx): a circle filled with the emotion color, a
// dashed white perforation ring, a letterpress inner shadow, an explicit
// pressed-in state, a busy spinner, and -- while playing -- two bars plus a
// slow breathing halo (2.2s). Deliberately no scale-on-tap (that read as a
// "button", not a stamp, in design review).
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';

import { resolveAudioEmotionColors } from './audio-emotion';

export interface ListenSealProps {
  playing: boolean;
  onPress: () => void;
  /** Null before emotion analysis lands -- renders the neutral graphite seal. */
  emotion: string | null;
  size?: number;
  busy?: boolean;
  disabled?: boolean;
  /** Override the seal's fill -- e.g. the recessed edit-screen chip tints it to match a dimmed treatment. */
  color?: string;
  accessibilityLabel?: string;
  testID?: string;
}

const BREATH_DURATION_MS = 2200;

export function ListenSeal({
  playing,
  onPress,
  emotion,
  size = 52,
  busy = false,
  disabled = false,
  color,
  accessibilityLabel,
  testID,
}: ListenSealProps) {
  const e = resolveAudioEmotionColors(emotion);
  const fill = color ?? e.main;
  const [pressed, setPressed] = useState(false);
  const breath = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!playing) {
      breath.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(breath, {
        toValue: 1,
        duration: BREATH_DURATION_MS,
        easing: Easing.bezier(0.5, 0, 0.2, 1),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [playing, breath]);

  const haloScale = breath.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.22, 1] });
  const haloOpacity = breath.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.34, 0.12, 0.34] });

  const glyphSize = Math.round(size * 0.36);
  const barWidth = Math.max(2.5, glyphSize * 0.26);

  return (
    <View style={{ width: size, height: size }}>
      {playing ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            {
              backgroundColor: fill,
              borderRadius: size / 2,
              opacity: haloOpacity,
              transform: [{ scale: haloScale }],
            },
          ]}
          testID={testID ? `${testID}-halo` : undefined}
        />
      ) : null}
      <Pressable
        accessibilityLabel={accessibilityLabel ?? (playing ? 'Pause' : 'Listen')}
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={[
          styles.seal,
          {
            backgroundColor: disabled ? colors.surface2 : fill,
            borderRadius: size / 2,
            height: size,
            width: size,
          },
          !pressed && !disabled ? styles.sealElevated : null,
        ]}
        testID={testID}
      >
        <View pointerEvents="none" style={[styles.perforation, { borderRadius: size / 2 }]} />
        <LinearGradient
          colors={
            pressed
              ? ['rgba(44,36,24,0.30)', 'rgba(44,36,24,0.30)']
              : ['rgba(255,255,255,0.42)', 'rgba(255,255,255,0)', 'rgba(44,36,24,0.14)']
          }
          locations={pressed ? undefined : [0, 0.4, 1]}
          pointerEvents="none"
          style={[styles.innerShadow, { borderRadius: size / 2 }]}
        />
        {busy ? (
          <ActivityIndicator color="#fff" size="small" testID={testID ? `${testID}-busy` : undefined} />
        ) : playing ? (
          <View style={styles.bars} testID={testID ? `${testID}-bars` : undefined}>
            <View style={[styles.bar, { height: glyphSize, width: barWidth }]} />
            <View style={[styles.bar, { height: glyphSize, width: barWidth }]} />
          </View>
        ) : (
          <View
            style={[
              styles.playTriangle,
              {
                borderBottomWidth: glyphSize * 0.5,
                borderLeftWidth: glyphSize * 0.86,
                borderTopWidth: glyphSize * 0.5,
                marginLeft: glyphSize * 0.16,
              },
            ]}
            testID={testID ? `${testID}-play-glyph` : undefined}
          />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  halo: {
    position: 'absolute',
    top: -2,
    left: -2,
    right: -2,
    bottom: -2,
  },
  seal: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sealElevated: {
    elevation: 2,
    shadowColor: 'rgba(44,36,24,1)',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  perforation: {
    ...StyleSheet.absoluteFill,
    borderColor: 'rgba(255,255,255,0.62)',
    borderStyle: 'dashed',
    borderWidth: 1.5,
  },
  innerShadow: {
    ...StyleSheet.absoluteFill,
  },
  bars: {
    flexDirection: 'row',
    gap: 3,
  },
  bar: {
    backgroundColor: '#fff',
    borderRadius: 1,
  },
  playTriangle: {
    backgroundColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#fff',
    borderStyle: 'solid',
    borderTopColor: 'transparent',
    height: 0,
    width: 0,
  },
});
