// The inked-trace visualization every audio surface shares: a deterministic,
// stylized "waveform" line drawn once per (seed, points) and never
// recomputed from real audio -- there is no waveform-peaks sidecar in v1
// (see docs/features/audio-memories.md). Ported from the approved design
// prototype's `moEnv`/`SoundTrace` (audio-kit.jsx) so every surface (card,
// chip, tile, mark) draws the identical hand-inked line for a given clip.
//
// Playback reads as the recording being inked: un-played ink is a faint
// pencil line; played ink is bold emotion-toned ink with a soft glow; a
// pen-nib dot rides the line at the playhead (its halo breathes while
// playing). Progress glides on the UI thread between the player's status
// updates, so the ink advances continuously instead of stepping. With
// `onSeek`, the trace is tap-to-seek and drag-to-scrub.
import { useEffect, useId, useMemo, useRef } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { ClipPath, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { resolveAudioEmotionColors } from './audio-emotion';

const VIEWBOX_WIDTH = 300;
const VIEWBOX_HEIGHT = 100;
/** A jump bigger than this (e.g. a seek) snaps; smaller drift is glided through. */
const SNAP_THRESHOLD_MS = 400;
const NIB_VISIBLE_MIN = 0.002;
const NIB_VISIBLE_MAX = 0.998;
const RESTING_GLOW = 0.16;

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedPath = Animated.createAnimatedComponent(Path);

const envCache = new Map<string, number[]>();

/**
 * Deterministic seeded envelope generator, ported line-for-line from the
 * prototype's `moEnv` (audio-kit.jsx): a cheap seeded LCG, a slow random
 * contour, two smoothing passes (so it reads as a "loud passages and quiet
 * gaps" contour, never a sawtooth), then per-stroke jitter and an edge
 * taper so the trace fades in/out at both ends instead of clipping abruptly.
 * Cached by "seed:n" -- same seed always draws the same line, cheaply.
 */
export function moEnv(seed: number, n: number): number[] {
  const key = `${seed}:${n}`;
  const cached = envCache.get(key);
  if (cached) {
    return cached;
  }

  let s = (seed * 9301 + 49297) % 233280;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  // Slow contour -- loud passages and the quiet gaps between them.
  let env: number[] = [];
  let v = 0.55;
  for (let i = 0; i < n; i++) {
    v += (rnd() - 0.5) * 0.62;
    v = Math.max(0.06, Math.min(1, v));
    env.push(v);
  }
  for (let pass = 0; pass < 2; pass++) {
    env = env.map(
      (x, i) => (env[Math.max(0, i - 1)] + x * 2 + env[Math.min(n - 1, i + 1)]) / 4,
    );
  }

  const lo = Math.min(...env);
  const hi = Math.max(...env);
  const span = Math.max(0.001, hi - lo);

  // Per-stroke jitter -- hand-drawn, never a sawtooth -- plus an edge taper.
  const out = env.map((x, i) => {
    const norm = 0.1 + 0.9 * ((x - lo) / span);
    const edge = Math.min(1, Math.min(i, n - 1 - i) / Math.max(1, n * 0.08));
    const j = rnd();
    return norm * (0.34 + 0.66 * j * j) * (0.18 + 0.82 * edge);
  });

  envCache.set(key, out);
  return out;
}

function clamp01(value: number): number {
  'worklet';
  return Math.max(0, Math.min(1, value));
}

/** Trace y (viewBox units) at 0-1 progress, interpolated between points. */
function traceYAt(ys: number[], progress: number): number {
  'worklet';
  const last = ys.length - 1;
  if (last <= 0) return VIEWBOX_HEIGHT / 2;
  const position = clamp01(progress) * last;
  const index = Math.min(last - 1, Math.floor(position));
  const t = position - index;
  return ys[index] + (ys[index + 1] - ys[index]) * t;
}

/**
 * The displayed progress, as a UI-thread value: while playing it runs
 * linearly to the end at the clip's real rate, re-synced on each status
 * update (the player only reports every ~250ms); a seek snaps; paused
 * eases to the reported position. Held still while scrubbing/settling.
 */
function useSmoothProgress(
  progress: number,
  playing: boolean,
  durationSeconds: number,
  held: SharedValue<boolean>,
): SharedValue<number> {
  const shown = useSharedValue(clamp01(progress));

  useEffect(() => {
    if (held.get()) return;
    const target = clamp01(progress);
    const durationMs = durationSeconds * 1000;
    cancelAnimation(shown);
    if (playing && durationMs > 0) {
      const drifted = Math.abs(shown.get() - target) * durationMs > SNAP_THRESHOLD_MS;
      if (drifted) shown.set(target);
      shown.set(withTiming(1, {
        duration: Math.max(0, (1 - target) * durationMs),
        easing: Easing.linear,
      }));
    } else {
      shown.set(withTiming(target, { duration: 160 }));
    }
  }, [durationSeconds, held, playing, progress, shown]);

  return shown;
}

export interface SoundTraceProps {
  /** Deterministic per-clip seed -- same clip always draws the same trace. */
  seed: number;
  /** 0-1 playback progress (as last reported by the player). */
  progress?: number;
  /** Null before emotion analysis lands (or forever, for unclassified babble) -- renders neutral graphite. */
  emotion: string | null;
  height?: number;
  /** Number of envelope samples -- more points = finer trace, at more cost. */
  points?: number;
  stroke?: number;
  /** Override the un-played (idle) stroke color. Defaults to the emotion/neutral ink, faint. */
  idleColor?: string;
  /** Override the played (inked) stroke color. Defaults to the emotion/neutral ink. */
  inkColor?: string;
  /** While true (with durationSeconds), progress glides between updates. */
  playing?: boolean;
  durationSeconds?: number;
  /** The pen-nib playhead. Defaults to on; static thumbnails turn it off. */
  showNib?: boolean;
  /** Enables tap-to-seek and drag-to-scrub. May return the seek promise. */
  onSeek?: (fraction: number) => void | Promise<void>;
  /** Live 0-1 position while dragging; null when the drag ends. */
  onScrubChange?: (fraction: number | null) => void;
  /** Temporarily ignore touches (e.g. while the clip loads). */
  disabled?: boolean;
  testID?: string;
}

export function SoundTrace({
  seed,
  progress = 0,
  emotion,
  height = 56,
  points = 52,
  stroke = 2.2,
  idleColor,
  inkColor,
  playing = false,
  durationSeconds = 0,
  showNib = true,
  onSeek,
  onScrubChange,
  disabled = false,
  testID,
}: SoundTraceProps) {
  // Stable per-instance ids: SVG clipPath/gradient ids must be unique across
  // every SoundTrace mounted at once, but stable across re-renders.
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const clipId = `mo-sound-trace-clip-${reactId}`;
  const gradientId = `mo-sound-trace-ink-${reactId}`;

  const e = resolveAudioEmotionColors(emotion);
  const ink = inkColor ?? e.ink;
  const mid = VIEWBOX_HEIGHT / 2;
  const env = useMemo(() => moEnv(seed, points), [seed, points]);
  const ys = useMemo(
    () => env.map((amplitude, i) => mid + (i % 2 ? 1 : -1) * amplitude * (VIEWBOX_HEIGHT / 2) * 0.94),
    [env, mid],
  );
  const path = useMemo(
    () => ys
      .map((y, i) => `${i ? 'L' : 'M'}${((i / (points - 1)) * VIEWBOX_WIDTH).toFixed(1)} ${y.toFixed(1)}`)
      .join(' '),
    [points, ys],
  );

  const widthValue = useSharedValue(0);
  const held = useSharedValue(false);
  const shown = useSmoothProgress(progress, playing, durationSeconds, held);
  const reduceMotion = useReducedMotion();

  // Played ink, clipped to the (smoothed) progress.
  const clipProps = useAnimatedProps(() => ({ width: shown.get() * VIEWBOX_WIDTH }));

  // A brief glow when the clip plays through to the end.
  const glow = useSharedValue(RESTING_GLOW);
  const glowProps = useAnimatedProps(() => ({ strokeOpacity: glow.get() }));
  const previousProgress = useRef(progress);
  useEffect(() => {
    const finished = previousProgress.current < 0.99 && progress >= NIB_VISIBLE_MAX && !playing;
    previousProgress.current = progress;
    if (finished && !reduceMotion) {
      glow.set(withSequence(withTiming(0.5, { duration: 220 }), withTiming(RESTING_GLOW, { duration: 700 })));
    }
  }, [glow, playing, progress, reduceMotion]);

  // The nib's halo breathes while playing.
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (playing && !reduceMotion) {
      pulse.set(0);
      pulse.set(withRepeat(withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }), -1, false));
    } else {
      cancelAnimation(pulse);
      pulse.set(withTiming(0, { duration: 200 }));
    }
  }, [playing, pulse, reduceMotion]);

  const nibSize = Math.round(Math.max(10, stroke * 4.6));
  const scrubbing = useSharedValue(false);
  const nibStyle = useAnimatedStyle(() => {
    const p = shown.get();
    const visible = scrubbing.get() || (p > NIB_VISIBLE_MIN && p < NIB_VISIBLE_MAX);
    return {
      opacity: withTiming(visible ? 1 : 0, { duration: 180 }),
      transform: [
        { translateX: p * widthValue.get() - nibSize / 2 },
        { translateY: (traceYAt(ys, p) / VIEWBOX_HEIGHT) * height - nibSize / 2 },
        { scale: scrubbing.get() ? 1.35 : 1 },
      ],
    };
  });
  const haloStyle = useAnimatedStyle(() => ({
    opacity: playing ? 0.4 * (1 - pulse.get()) : 0.22,
    transform: [{ scale: 1 + pulse.get() * 1.4 }],
  }));

  // Seeking: show the new spot immediately, and hold the smoothing still
  // until the player has actually moved there, so a status update that was
  // already in flight can't yank the ink back for a frame.
  const seekTo = (fraction: number) => {
    // A touch without usable coordinates must never reach the player.
    if (!onSeek || !Number.isFinite(fraction)) return;
    const target = clamp01(fraction);
    held.set(true);
    cancelAnimation(shown);
    shown.set(target);
    void Promise.resolve(onSeek(target)).finally(() => {
      setTimeout(() => {
        held.set(false);
      }, 120);
    });
  };
  const emitScrub = (fraction: number | null) => onScrubChange?.(fraction);

  const lastEmitted = useSharedValue(-1);
  const interactive = Boolean(onSeek) && !disabled;
  const pan = Gesture.Pan()
    .enabled(interactive)
    // Horizontal drags scrub; vertical drags stay with the list scroll.
    .activeOffsetX([-6, 6])
    .failOffsetY([-12, 12])
    .onStart((event) => {
      held.set(true);
      scrubbing.set(true);
      cancelAnimation(shown);
      shown.set(clamp01(event.x / Math.max(1, widthValue.get())));
    })
    .onUpdate((event) => {
      const fraction = clamp01(event.x / Math.max(1, widthValue.get()));
      shown.set(fraction);
      // Only cross to JS when the displayed time would change.
      const key = durationSeconds > 0 ? Math.floor(fraction * durationSeconds) : Math.round(fraction * 100);
      if (key !== lastEmitted.get()) {
        lastEmitted.set(key);
        runOnJS(emitScrub)(fraction);
      }
    })
    .onEnd(() => {
      runOnJS(seekTo)(shown.get());
    })
    .onFinalize(() => {
      scrubbing.set(false);
      lastEmitted.set(-1);
      runOnJS(emitScrub)(null);
    });

  // Exclusive: a drag that becomes a scrub can never also land as a tap.
  const tap = Gesture.Tap()
    .enabled(interactive)
    .maxDuration(400)
    .withTestId(testID ? `${testID}-tap` : 'sound-trace-tap')
    .onEnd((event, success) => {
      if (success) runOnJS(seekTo)(clamp01(event.x / Math.max(1, widthValue.get())));
    });
  const gesture = Gesture.Exclusive(pan.withTestId(testID ? `${testID}-pan` : 'sound-trace-pan'), tap);

  const handleLayout = (event: LayoutChangeEvent) => {
    widthValue.set(event.nativeEvent.layout.width);
  };

  const content = (
    <>
      <Svg
        height={height}
        preserveAspectRatio="none"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        width="100%"
      >
        <Defs>
          <ClipPath id={clipId}>
            <AnimatedRect animatedProps={clipProps} height={VIEWBOX_HEIGHT} x={0} y={0} />
          </ClipPath>
          <LinearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
            <Stop offset="0" stopColor={e.main} stopOpacity={0.85} />
            <Stop offset="1" stopColor={ink} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        {/* Un-played: a faint pencil line waiting for ink. */}
        <Path
          d={path}
          fill="none"
          stroke={idleColor ?? ink}
          strokeLinecap="round"
          strokeLinejoin="round"
          // A caller-supplied idle color (static tiles, the unavailable
          // state) keeps its original treatment.
          strokeOpacity={idleColor ? 0.45 : 0.24}
          strokeWidth={idleColor ? stroke : stroke * 0.8}
          vectorEffect="non-scaling-stroke"
        />
        {/* Played: a soft glow under bold ink, both clipped to progress. */}
        <AnimatedPath
          animatedProps={glowProps}
          clipPath={`url(#${clipId})`}
          d={path}
          fill="none"
          stroke={e.main}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={stroke + 5}
          vectorEffect="non-scaling-stroke"
        />
        <Path
          clipPath={`url(#${clipId})`}
          d={path}
          fill="none"
          stroke={inkColor ?? `url(#${gradientId})`}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={stroke + 0.6}
          vectorEffect="non-scaling-stroke"
        />
      </Svg>
      {showNib ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.nib, { height: nibSize, width: nibSize }, nibStyle]}
          testID={testID ? `${testID}-nib` : undefined}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: e.main, borderRadius: nibSize / 2 },
              haloStyle,
            ]}
          />
          <View
            style={[
              styles.nibCore,
              { backgroundColor: ink, borderRadius: nibSize / 2, shadowColor: e.main },
            ]}
          />
        </Animated.View>
      ) : null}
    </>
  );

  if (!onSeek) {
    return (
      <View onLayout={handleLayout} style={[styles.container, { height }]} testID={testID}>
        {content}
      </View>
    );
  }

  return (
    <GestureDetector gesture={gesture}>
      {/* Taps and drags are handled by the gestures above; this Pressable
          only claims the touch so a host card's own onPress never fires
          for it, and carries the screen-reader adjust actions. */}
      <Pressable
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        accessibilityLabel="Playback position"
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(clamp01(progress) * 100) }}
        disabled={!interactive}
        onAccessibilityAction={(event) => {
          const step = event.nativeEvent.actionName === 'increment' ? 0.1 : -0.1;
          seekTo(clamp01(progress) + step);
        }}
        onLayout={handleLayout}
        onPress={claimTouch}
        style={[styles.container, { height }]}
        testID={testID}
      >
        {content}
      </Pressable>
    </GestureDetector>
  );
}

function claimTouch() {
  // Intentionally empty -- see the GestureDetector comment.
}

const styles = StyleSheet.create({
  container: {
    overflow: 'visible',
    width: '100%',
  },
  nib: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
  nibCore: {
    ...StyleSheet.absoluteFill,
    borderColor: 'rgba(255,255,255,0.9)',
    borderWidth: 1.5,
    elevation: 2,
    shadowOffset: { height: 0, width: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 4,
  },
});
