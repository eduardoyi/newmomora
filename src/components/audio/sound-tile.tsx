// Two small presentational glyphs shared across type-aware surfaces that
// need to represent an audio memory without a card: the 1:1 `SoundTile`
// (member-profile grid thumb, calendar hero) and the tiny `SoundMark`
// bar-glyph (calendar day stamp). Both are read-only -- no play affordance --
// so they never wrap a `Pressable` themselves; callers that want the whole
// tile tappable wrap it in their own.
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { fonts } from '@/constants/theme';

import { formatClipTime, resolveAudioEmotionColors } from './audio-emotion';
import { moEnv, SoundTrace } from './sound-trace';

export interface SoundTileProps {
  seed: number;
  emotion: string | null;
  durationSeconds: number;
  size?: number;
  showDuration?: boolean;
  testID?: string;
}

/** Small square tile -- member profile grid, calendar hero, anywhere 1:1. */
export function SoundTile({
  seed,
  emotion,
  durationSeconds,
  size = 108,
  showDuration = true,
  testID,
}: SoundTileProps) {
  const e = resolveAudioEmotionColors(emotion);
  const glyphSize = Math.round(size * 0.3);

  return (
    <View
      style={[
        styles.tile,
        {
          borderRadius: 12,
          height: size,
          width: size,
        },
      ]}
      testID={testID}
    >
      <LinearGradient
        colors={[`${e.soft}`, `${e.soft}77`]}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.traceWrap, { paddingHorizontal: size * 0.12 }]}>
        <SoundTrace
          emotion={emotion}
          height={Math.round(size * 0.34)}
          idleColor={e.ink}
          points={34}
          progress={0}
          seed={seed}
          stroke={1.8}
        />
      </View>
      <View
        style={[
          styles.glyph,
          {
            backgroundColor: e.main,
            borderRadius: glyphSize / 2,
            height: glyphSize,
            marginLeft: -glyphSize / 2,
            marginTop: -glyphSize / 2,
            width: glyphSize,
          },
        ]}
      >
        <View
          style={[
            styles.glyphTriangle,
            {
              borderBottomWidth: glyphSize * 0.14,
              borderLeftWidth: glyphSize * 0.24,
              borderTopWidth: glyphSize * 0.14,
              marginLeft: glyphSize * 0.04,
            },
          ]}
        />
      </View>
      {showDuration ? (
        <Text style={[styles.duration, { color: e.ink, fontSize: Math.max(9, Math.round(size * 0.095)) }]}>
          {formatClipTime(durationSeconds)}
        </Text>
      ) : null}
    </View>
  );
}

export interface SoundMarkProps {
  seed: number;
  emotion: string | null;
  size?: number;
  stroke?: number;
  testID?: string;
}

/** Tiny bar-glyph mark -- calendar day stamp, anywhere a compact audio glyph is needed. */
export function SoundMark({ seed, emotion, size = 22, stroke = 1.6, testID }: SoundMarkProps) {
  const e = resolveAudioEmotionColors(emotion);
  const bars = moEnv(seed, 13);

  return (
    <Svg
      height={size * 0.52}
      testID={testID}
      viewBox="0 0 40 20"
      width={size}
    >
      {bars.map((amplitude, i) => {
        const x = 2 + i * 3;
        const h = Math.max(2.4, amplitude * 17);
        return (
          <Line
            key={i}
            stroke={e.ink}
            strokeLinecap="round"
            strokeOpacity={0.9}
            strokeWidth={stroke}
            x1={x}
            x2={x}
            y1={10 - h / 2}
            y2={10 + h / 2}
          />
        );
      })}
    </Svg>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  traceWrap: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: '50%',
    transform: [{ translateY: -1 }],
  },
  glyph: {
    alignItems: 'center',
    borderColor: 'rgba(255,255,255,0.65)',
    borderStyle: 'dashed',
    borderWidth: 1.5,
    justifyContent: 'center',
    left: '50%',
    position: 'absolute',
    top: '50%',
  },
  glyphTriangle: {
    backgroundColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#fff',
    borderTopColor: 'transparent',
    height: 0,
    width: 0,
  },
  duration: {
    bottom: 5,
    fontFamily: fonts.sansMedium,
    opacity: 0.85,
    position: 'absolute',
    right: 6,
  },
});
