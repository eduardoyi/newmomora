// The inked-trace visualization every audio surface shares: a deterministic,
// stylized "waveform" line drawn once per (seed, points) and never
// recomputed from real audio -- there is no waveform-peaks sidecar in v1
// (see docs/features/audio-memories.md). Ported exactly from the approved
// design prototype's `moEnv`/`SoundTrace` (audio-kit.jsx) so every surface
// (card, chip, tile, mark) draws the identical hand-inked line for a given
// clip. Un-played ink is pencil-faint; playing ink is drawn in the emotion's
// ink tone (or the neutral graphite before analysis lands).
import { useId, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { ClipPath, Defs, Line, Path, Rect } from 'react-native-svg';

import { resolveAudioEmotionColors } from './audio-emotion';

const VIEWBOX_WIDTH = 300;
const VIEWBOX_HEIGHT = 100;

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

export interface SoundTraceProps {
  /** Deterministic per-clip seed -- same clip always draws the same trace. */
  seed: number;
  /** 0-1 playback progress. Everything left of this point is drawn "inked". */
  progress?: number;
  /** Null before emotion analysis lands (or forever, for unclassified babble) -- renders neutral graphite. */
  emotion: string | null;
  height?: number;
  /** Number of envelope samples -- more points = finer trace, at more cost. */
  points?: number;
  stroke?: number;
  /** Override the un-played (idle) stroke color. Defaults to the emotion/neutral ink at low opacity. */
  idleColor?: string;
  /** Override the played (inked) stroke color. Defaults to the emotion/neutral ink at full opacity. */
  inkColor?: string;
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
}: SoundTraceProps) {
  // A stable per-instance id (not per-render) -- SVG clipPath ids must be
  // unique across every SoundTrace mounted at once (card + chip + tile can
  // all be on screen together), but stable across re-renders of the same
  // instance so React doesn't have to remount the <ClipPath> each time
  // `progress` ticks during playback. React's own id generator (rather than
  // a module-level counter) keeps this a pure render -- no side effect to
  // reassign on every mount.
  const reactId = useId();
  const uid = `mo-sound-trace-clip-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

  const e = resolveAudioEmotionColors(emotion);
  const mid = VIEWBOX_HEIGHT / 2;
  const env = useMemo(() => moEnv(seed, points), [seed, points]);

  const path = useMemo(
    () =>
      env
        .map((amplitude, i) => {
          const x = (i / (points - 1)) * VIEWBOX_WIDTH;
          const y = mid + (i % 2 ? 1 : -1) * amplitude * (VIEWBOX_HEIGHT / 2) * 0.94;
          return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' '),
    [env, mid, points],
  );

  const clampedProgress = Math.max(0, Math.min(1, progress));
  const clipWidth = clampedProgress * VIEWBOX_WIDTH;
  const tipAmplitude = env[Math.min(points - 1, Math.round(clampedProgress * (points - 1)))] ?? 0;
  // Only draw the "wet tip" line while genuinely mid-play -- not at rest
  // (progress 0) and not once finished (progress 1), matching the
  // prototype's `p > 0.002 && p < 0.998` guard.
  const showTip = clampedProgress > 0.002 && clampedProgress < 0.998;

  return (
    <View style={[styles.container, { height }]}>
      <Svg
        height={height}
        preserveAspectRatio="none"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        width="100%"
      >
        <Defs>
          <ClipPath id={uid}>
            <Rect height={VIEWBOX_HEIGHT} width={clipWidth} x={0} y={0} />
          </ClipPath>
        </Defs>
        {/* Un-played ink: the same ink tone as the played stroke, just faint -- pencil waiting for ink, not a different color. */}
        <Path
          d={path}
          fill="none"
          stroke={idleColor ?? e.ink}
          strokeLinecap="round"
          strokeOpacity={0.45}
          strokeWidth={stroke}
          vectorEffect="non-scaling-stroke"
        />
        {/* Played ink, clipped to progress. */}
        <Path
          clipPath={`url(#${uid})`}
          d={path}
          fill="none"
          stroke={inkColor ?? e.ink}
          strokeLinecap="round"
          strokeWidth={stroke + 0.3}
          vectorEffect="non-scaling-stroke"
        />
        {showTip ? (
          <Line
            stroke={inkColor ?? e.ink}
            strokeOpacity={0.55}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            x1={clipWidth}
            x2={clipWidth}
            y1={mid - Math.max(tipAmplitude, 0.35) * 46}
            y2={mid + Math.max(tipAmplitude, 0.35) * 46}
          />
        ) : null}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'visible',
    width: '100%',
  },
});
