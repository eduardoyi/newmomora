// The compact clip row shared by the fork sheet, the composer, and the edit
// screen's read-only clip well. Ported from the design prototype's
// `ClipChip` (audio-kit.jsx): seal + trace + mono mm:ss time, with an
// optional remove control, a `recessed` variant (edit screen -- the clip
// renders inset, with no remove control, since v1 has no clip replacement
// post-save), and a `slim` variant for tighter contexts.
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';

import { formatClipTime, resolveAudioEmotionColors } from './audio-emotion';
import { ListenSeal } from './listen-seal';
import { SoundTrace } from './sound-trace';

export interface ClipChipProps {
  /** Deterministic per-clip seed shared with every other trace of this clip. */
  seed: number;
  /** Null before emotion analysis lands. */
  emotion: string | null;
  durationSeconds: number;
  /** Current playback position in seconds -- drives the "elapsed / total" time display. */
  positionSeconds?: number;
  /** 0-1 playback progress, fed straight to the trace. */
  progress: number;
  playing: boolean;
  busy?: boolean;
  onToggle: () => void;
  /**
   * Omitted (or ignored when `recessed`) hides the remove control -- the
   * edit screen's recessed clip has no remove/replace affordance in v1
   * (docs/features/audio-memories.md: "no clip replacement post-save").
   */
  onRemove?: () => void;
  /** Edit-screen treatment: inset "pressed into the page" look, remove control suppressed. */
  recessed?: boolean;
  /** Tighter padding/sizing for dense contexts (e.g. inline in a list row). */
  slim?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function ClipChip({
  seed,
  emotion,
  durationSeconds,
  positionSeconds = 0,
  progress,
  playing,
  busy = false,
  onToggle,
  onRemove,
  recessed = false,
  slim = false,
  disabled = false,
  testID,
}: ClipChipProps) {
  const e = resolveAudioEmotionColors(emotion);
  const showElapsed = playing || positionSeconds > 0.05;
  const showRemove = Boolean(onRemove) && !recessed;

  return (
    <View
      style={[
        styles.container,
        slim ? styles.containerSlim : styles.containerRegular,
        recessed ? styles.containerRecessed : styles.containerRaised,
      ]}
      testID={testID}
    >
      <ListenSeal
        busy={busy}
        disabled={disabled}
        emotion={emotion}
        onPress={onToggle}
        playing={playing}
        size={slim ? 34 : 40}
        testID={testID ? `${testID}-seal` : undefined}
      />
      <View style={styles.traceColumn}>
        <SoundTrace
          emotion={emotion}
          height={slim ? 20 : 28}
          points={38}
          progress={progress}
          seed={seed}
          stroke={1.9}
        />
      </View>
      <View style={styles.timeColumn}>
        {showElapsed ? (
          <Text style={[styles.time, styles.timeElapsed]}>{formatClipTime(positionSeconds)}</Text>
        ) : null}
        {showElapsed ? <Text style={[styles.time, styles.timeDim]}>/</Text> : null}
        <Text style={[styles.time, showElapsed ? styles.timeDim : styles.timeElapsed]}>
          {formatClipTime(durationSeconds)}
        </Text>
      </View>
      {showRemove ? (
        <Pressable
          accessibilityLabel="Remove sound"
          accessibilityRole="button"
          onPress={onRemove}
          style={styles.removeButton}
          testID={testID ? `${testID}-remove` : undefined}
        >
          <SymbolView
            fallback={<Text style={styles.removeFallback}>×</Text>}
            name={{ ios: 'xmark', android: 'close' }}
            size={12}
            tintColor={colors.ink2}
          />
        </Pressable>
      ) : null}
      {/* Neutral wash keeps the row legible against the recessed background even for a not-yet-analyzed clip. */}
      {recessed ? <View pointerEvents="none" style={[styles.recessedWash, { backgroundColor: e.soft }]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm + 4,
    overflow: 'hidden',
  },
  containerRegular: {
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  containerSlim: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  containerRaised: {},
  containerRecessed: {
    backgroundColor: colors.surface2,
    borderColor: colors.border,
  },
  recessedWash: {
    ...StyleSheet.absoluteFill,
    opacity: 0.28,
    zIndex: -1,
  },
  traceColumn: {
    flex: 1,
    minWidth: 0,
  },
  timeColumn: {
    flexDirection: 'row',
    flexShrink: 0,
    gap: 4,
  },
  time: {
    fontFamily: fonts.sansMedium,
    fontSize: 12.5,
    letterSpacing: -0.2,
  },
  timeElapsed: {
    color: colors.ink2,
  },
  timeDim: {
    color: colors.ink3,
  },
  removeButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexShrink: 0,
    height: 26,
    justifyContent: 'center',
    width: 26,
  },
  removeFallback: {
    color: colors.ink2,
    fontSize: 13,
    lineHeight: 14,
  },
});
