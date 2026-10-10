import Svg, { Circle, G, Path, Rect } from 'react-native-svg';

import { colors } from '@/constants/theme';

// The three composer toolbar icons (docs/plans/artwork-scanning-v2.md
// decision 9): hand-drawn, an ink outline plus one color each. Paths are the
// "in the toolbar" (heavier stroke) variants from the design canvas
// (`Icons.dc.html`), 48-unit viewBox. When `disabled`, every stroke and fill
// goes grey so they read as inert without needing the surrounding opacity.

export interface ComposerIconProps {
  /** Rendered size in px (square). */
  size?: number;
  /** Draw everything in grey. */
  disabled?: boolean;
}

const DEFAULT_SIZE = 28;

const ACTIVE_COLORS = {
  ink: colors.ink,
  paper: '#FFFFFF',
  sea: colors.sea,
  seaSoft: colors.seaSoft,
  sun: colors.sun,
  sunSoft: colors.sunSoft,
  hills: '#6BB58A',
  pink: colors.primary,
  pinkSoft: colors.primarySoft,
} as const;

const DISABLED_FILL = '#E6E1DD';
const DISABLED_ACCENT_FILL = '#CFC8BF';

function palette(disabled: boolean) {
  if (!disabled) return ACTIVE_COLORS;
  return {
    ink: colors.ink3,
    paper: DISABLED_FILL,
    sea: colors.ink3,
    seaSoft: DISABLED_FILL,
    sun: DISABLED_ACCENT_FILL,
    sunSoft: DISABLED_FILL,
    hills: DISABLED_ACCENT_FILL,
    pink: colors.ink3,
    pinkSoft: DISABLED_FILL,
  };
}

/** Retro microphone with sea-green sound waves. */
export function SoundIcon({ size = DEFAULT_SIZE, disabled = false }: ComposerIconProps) {
  const c = palette(disabled);
  return (
    <Svg height={size} viewBox="0 0 48 48" width={size}>
      <G fill="none" strokeLinecap="round" strokeLinejoin="round">
        <Path d="M9 12q-3.5 6 0 12M39 12q3.5 6 0 12" fill="none" stroke={c.sea} strokeWidth={2.6} />
        <Rect fill={c.seaSoft} height={21} rx={7} stroke={c.ink} strokeWidth={2.4} width={14} x={17} y={5} />
        <Path d="M12.5 21a11.5 11.5 0 0 0 23 0M24 32.5v7M17 42h14" fill="none" stroke={c.ink} strokeWidth={2.4} />
      </G>
    </Svg>
  );
}

/** Two stacked instant photos, the top one sunny. */
export function PhotosIcon({ size = DEFAULT_SIZE, disabled = false }: ComposerIconProps) {
  const c = palette(disabled);
  return (
    <Svg height={size} viewBox="0 0 48 48" width={size}>
      <G fill="none" strokeLinecap="round" strokeLinejoin="round">
        <G transform="rotate(-11 22 24)">
          <Rect fill={c.paper} height={29} rx={2} stroke={c.ink} strokeWidth={2.4} width={24} x={8} y={9} />
        </G>
        <G transform="rotate(7 27 25)">
          <Rect fill={c.paper} height={29} rx={2} stroke={c.ink} strokeWidth={2.4} width={24} x={15} y={10} />
          <Rect fill={c.sunSoft} height={17} width={18} x={18} y={13} />
          <Path d="M18 30l6-7 4 4 3-3 5 6z" fill={c.hills} />
          <Circle cx={31.5} cy={18} fill={c.sun} r={2.6} />
        </G>
      </G>
    </Svg>
  );
}

const SCALLOP_FRAME =
  'M9 7a2.5 2.5 0 0 1 5 0a2.5 2.5 0 0 1 5 0a2.5 2.5 0 0 1 5 0a2.5 2.5 0 0 1 5 0a2.5 2.5 0 0 1 5 0a2.5 2.5 0 0 1 5 0' +
  'a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5' +
  'a2.5 2.5 0 0 1 -5 0a2.5 2.5 0 0 1 -5 0a2.5 2.5 0 0 1 -5 0a2.5 2.5 0 0 1 -5 0a2.5 2.5 0 0 1 -5 0a2.5 2.5 0 0 1 -5 0' +
  'a2.5 2.5 0 0 1 0 -5a2.5 2.5 0 0 1 0 -5a2.5 2.5 0 0 1 0 -5a2.5 2.5 0 0 1 0 -5a2.5 2.5 0 0 1 0 -5a2.5 2.5 0 0 1 0 -5a2.5 2.5 0 0 1 0 -5z';

/** A scalloped pink frame around a crayon squiggle and a little sun. */
export function ScanArtIcon({ size = DEFAULT_SIZE, disabled = false }: ComposerIconProps) {
  const c = palette(disabled);
  return (
    <Svg height={size} viewBox="0 0 48 48" width={size}>
      <G fill="none" strokeLinecap="round" strokeLinejoin="round">
        <Path d={SCALLOP_FRAME} fill={c.pinkSoft} stroke={c.ink} strokeWidth={2.2} />
        <Rect fill={c.paper} height={25} stroke={c.ink} strokeWidth={2} width={20} x={14} y={12} />
        <Path d="M17 31c2.5-7 5.5-7.5 6.5-2.5s4 5 6.5-4" fill="none" stroke={c.pink} strokeWidth={3} />
        <Circle cx={29} cy={17.5} fill={c.sun} r={2.4} />
      </G>
    </Svg>
  );
}
