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
