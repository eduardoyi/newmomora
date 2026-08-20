// The tinted card-stock panel every sound surface's visual sits on -- ported
// from the design prototype's `StubBand` (audio-kit.jsx): an emotion-soft
// wash (graphite/neutral before analysis lands), the seal, the trace, and
// the mono elapsed/total time, with an optional tap-to-seek on the trace.
// NEW kit file (P3.1, docs/plans/audio-memories-v1.md) -- StubBand/StubTear
// didn't exist in the ported kit yet. This is the timeline card's visual
// slot (the "4:3 visual" a photo/illustration would otherwise occupy); the
// detail screen's larger hero player is its own, screen-specific layout
// (app/(app)/memory/[id]/index.tsx's SoundStage-equivalent), not this file.
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { type GestureResponderEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';

import { formatClipTime, resolveAudioEmotionColors } from './audio-emotion';
import { ListenSeal } from './listen-seal';
import { SoundTrace } from './sound-trace';

export interface StubBandProps {
  /** Deterministic per-clip seed shared with every other trace of this clip. */
  seed: number;
  /** Null before emotion analysis lands (or forever, for unclassified babble). */
  emotion: string | null;
  durationSeconds: number;
  positionSeconds: number;
  progress: number;
  playing: boolean;
  onToggle: () => void;
  /** Tap-to-seek on the trace -- omit to render the trace non-interactive. */
  onSeek?: (fraction: number) => void;
  /**
   * Tapping the band outside the seal/trace opens the memory detail screen.
   * The seal and (when present) the trace each claim their own touch first,
   * so this never double-fires alongside `onToggle`/`onSeek` -- omit for a
   * context with nothing to navigate to (e.g. a future non-card host).
   */
  onPress?: () => void;
  height?: number;
  sealSize?: number;
  padding?: number;
  testID?: string;
}

export function StubBand({
  seed,
  emotion,
  durationSeconds,
  positionSeconds,
  progress,
  playing,
  onToggle,
  onSeek,
  onPress,
  height = 104,
  sealSize = 46,
  padding = 14,
  testID,
}: StubBandProps) {
  const e = resolveAudioEmotionColors(emotion);
  const [traceWidth, setTraceWidth] = useState(0);
  const showElapsed = playing || positionSeconds > 0.05;
  const traceHeight = Math.max(28, height - padding * 2 - 20);

  const handleSeekPress = (event: GestureResponderEvent) => {
    if (!onSeek || !traceWidth) {
      return;
    }
    const fraction = event.nativeEvent.locationX / traceWidth;
    onSeek(Math.max(0, Math.min(1, fraction)));
  };

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={[styles.container, { minHeight: height, padding }]}
      testID={testID}
    >
      <LinearGradient
        colors={[e.soft, `${e.soft}00`]}
        end={{ x: 0.5, y: 1 }}
        start={{ x: 0.3, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.row}>
        <ListenSeal
          emotion={emotion}
          onPress={onToggle}
          playing={playing}
          size={sealSize}
          testID={testID ? `${testID}-seal` : undefined}
        />
        <View style={styles.traceColumn}>
          <Pressable
            disabled={!onSeek}
            onLayout={(event) => setTraceWidth(event.nativeEvent.layout.width)}
            onPress={handleSeekPress}
            testID={testID ? `${testID}-trace` : undefined}
          >
            <SoundTrace
              emotion={emotion}
              height={traceHeight}
              points={46}
              progress={progress}
              seed={seed}
              stroke={2.2}
            />
          </Pressable>
          <View style={styles.timeRow}>
            {showElapsed ? (
              <Text style={[styles.time, styles.timeElapsed]}>{formatClipTime(positionSeconds)}</Text>
            ) : null}
            {showElapsed ? <Text style={[styles.time, styles.timeDim]}>/</Text> : null}
            <Text style={[styles.time, showElapsed ? styles.timeDim : styles.timeElapsed]}>
              {formatClipTime(durationSeconds)}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    position: 'relative',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 13,
  },
  traceColumn: {
    flex: 1,
    minWidth: 0,
  },
  timeRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 6,
  },
  time: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    letterSpacing: -0.2,
  },
  timeElapsed: {
    color: colors.ink2,
  },
  timeDim: {
    color: colors.ink3,
  },
});
