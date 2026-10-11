import { seedFromKey } from '@/components/audio/audio-seed';
import type { FrameKind } from '@/components/artwork/frame-geometry';
import { colors } from '@/constants/theme';

// Which frame a piece of artwork hangs in. "Random" but stable: derived from
// the media asset's id (the memory id for a legacy single-asset row with no
// real asset), so a piece wears the same frame at the same tilt on every
// device and every render. Nothing is stored (docs/plans/artwork-scanning-v2.md
// decision 2). A future "change frame" feature needs a column that overrides
// this derived pick.

export const FRAME_KINDS: readonly FrameKind[] = [
  'scallop',
  'gingham',
  'ricrac',
  'wavy',
  'bobble',
  'chunky',
];

export const FRAME_COLORS: readonly string[] = [
  colors.frameBlush,
  colors.frameSky,
  colors.frameMint,
  colors.frameLilac,
  colors.frameButter,
  colors.frameTomato,
];

export interface FrameStyle {
  kind: FrameKind;
  color: string;
  /** Degrees, in [-2.5, -1] or [1, 2.5]. */
  tilt: number;
}

const TILT_STEPS = 7; // 1, 1.25, ... 2.5
const TILT_MIN = 1;
const TILT_MAX = 2.5;
/** Largest |tilt| `pickFrameStyle` returns (the Timeline's). */
export const FRAME_TILT_MAX = TILT_MAX;

// The detail wall leans harder and more variably than the Timeline: a frame
// hung on a nail reads as hand-hung with a visible tilt (1.5 - 4 degrees), and
// in the gallery walk neighbours lean opposite ways.
const DETAIL_TILT_MIN = 1.5;
const DETAIL_TILT_STEP = 0.25;
const DETAIL_TILT_STEPS = 11; // 1.5, 1.75, ... 4
export const DETAIL_TILT_MAX = DETAIL_TILT_MIN + (DETAIL_TILT_STEPS - 1) * DETAIL_TILT_STEP;

export function pickFrameStyle(key: string): FrameStyle {
  const seed = seedFromKey(key);
  // Kind and color come from independent slices of the seed so all 36
  // combinations occur; the tilt uses the next slice up.
  const kind = FRAME_KINDS[seed % FRAME_KINDS.length];
  const color = FRAME_COLORS[Math.floor(seed / FRAME_KINDS.length) % FRAME_COLORS.length];
  const rest = Math.floor(seed / (FRAME_KINDS.length * FRAME_COLORS.length));
  const magnitude = TILT_MIN + ((rest % TILT_STEPS) / (TILT_STEPS - 1)) * (TILT_MAX - TILT_MIN);
  const sign = Math.floor(rest / TILT_STEPS) % 2 === 0 ? -1 : 1;
  return { kind, color, tilt: sign * magnitude };
}

/** Lean direction of the Timeline tilt for `key` (-1 counter-clockwise, 1
 * clockwise): the "seed sign" the detail wall starts from. */
export function seedLeanSign(key: string): 1 | -1 {
  return Math.sign(pickFrameStyle(key).tilt) < 0 ? -1 : 1;
}

/**
 * Detail-screen tilt for a piece (degrees, |tilt| in [1.5, 4]). Derived from
 * the same seed as `pickFrameStyle` (so it is stable on every device and never
 * stored) but from a different slice, so the magnitude varies independently of
 * the Timeline's. `direction` is the lean's sign; omitted, it is the piece's
 * own seed sign (a single piece).
 */
export function pickDetailTilt(key: string, direction?: 1 | -1): number {
  const seed = seedFromKey(key);
  const rest = Math.floor(seed / (FRAME_KINDS.length * FRAME_COLORS.length));
  const step = Math.floor(rest / (TILT_STEPS * 2)) % DETAIL_TILT_STEPS;
  const magnitude = DETAIL_TILT_MIN + step * DETAIL_TILT_STEP;
  return (direction ?? seedLeanSign(key)) * magnitude;
}

/**
 * Lean direction for slide `index` of a gallery walk: the first piece's seed
 * sign, flipped by index parity, so adjacent pieces always lean opposite ways
 * whatever their own seeds say.
 */
export function walkLeanDirection(firstKey: string, index: number): 1 | -1 {
  const start = seedLeanSign(firstKey);
  return Math.abs(Math.trunc(index)) % 2 === 0 ? start : (-start as 1 | -1);
}
