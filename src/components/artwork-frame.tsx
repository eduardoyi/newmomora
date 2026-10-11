import { memo, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Path, Pattern, Rect } from 'react-native-svg';

import {
  frameMetrics,
  framePaths,
  type FrameKind,
  type FrameLipTone,
  type FrameOutlineTone,
  type FramePaths,
} from '@/components/artwork/frame-geometry';
import { colors } from '@/constants/theme';

// A scrapbook picture frame drawn with react-native-svg (docs/plans/
// artwork-scanning-v2.md, geometry in artwork/frame-geometry.ts). The frame
// body, mat, cast shadow and (optionally) nail + string are SVG; the artwork
// itself is an ordinary View positioned in the mat opening, so any child (an
// expo-image, a carousel) drops in unchanged.
//
// Layout box = the frame itself (`getArtworkFrameSize`). The SVG is larger
// than that box (padded) and positioned with negative offsets, so the cast
// shadow and the string/nail are not clipped; they overflow the layout box
// without taking space, so callers reserve any extra room (a nail needs
// `ARTWORK_NAIL_HEIGHT` px above the box).

export interface ArtworkFrameProps {
  /** Width of the art opening in px (the frame is wider by 2 * inset). */
  artWidth: number;
  /** Art width / height. */
  aspectRatio: number;
  kind: FrameKind;
  /** Frame color (one of `FRAME_COLORS`). */
  color: string;
  /** Degrees. Rotates about top-center, or about the nail when `nail`. */
  tilt?: number;
  /** Hang from a nail on a string (detail screen). */
  nail?: boolean;
  children?: React.ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** Nail position relative to the frame's top edge (negative = above). */
export const ARTWORK_NAIL_Y = -30;
const NAIL_Y = ARTWORK_NAIL_Y;
/** Room above the frame box the nail + string occupy, for layout. */
export const ARTWORK_NAIL_HEIGHT = 36;

// SVG viewport padding around the frame box. The cast shadow's farthest copy
// is offset (6, 10); the nail dot is 3.4px radius, 30px up.
const PAD_LEFT = 6;
const PAD_RIGHT = 14;
const PAD_BOTTOM = 18;
const PAD_TOP = 6;

/** How far the drawn SVG reaches beyond the frame's layout box (the viewport
 * clips anything past it, so it is the frame's full visual extent). `top` is
 * the no-nail value; a nailed frame reaches `ARTWORK_NAIL_HEIGHT` up. Layout
 * code that must keep a rotated frame inside its own box reads these. */
export const ARTWORK_FRAME_PAD = {
  left: PAD_LEFT,
  right: PAD_RIGHT,
  bottom: PAD_BOTTOM,
  top: PAD_TOP,
} as const;

// Cast shadow: stacked, offset copies of the body (RN SVG has no reliable
// blur, and Android elevation shadows are rectangular).
const SHADOW_COPIES = [
  { dx: 2, dy: 4, opacity: 0.1 },
  { dx: 4, dy: 7, opacity: 0.07 },
  { dx: 6, dy: 10, opacity: 0.04 },
] as const;

const NAIL_COLOR = '#5F4A36';
const NAIL_HIGHLIGHT = '#C9B79F';
const STRING_COLOR = '#6B5E4F';
const ART_BACKDROP = '#FFFFFF';

const LIP_COLORS: Record<Exclude<FrameLipTone, 'none'>, string> = {
  light: 'rgba(255,255,255,0.55)',
  warm: 'rgba(120,90,50,0.18)',
  white: 'rgba(255,255,255,0.9)',
};
const OUTLINE_WARM = 'rgba(120,90,50,0.18)';

export interface ArtworkFrameSizeResult {
  /** Frame box (what the layout reserves). */
  width: number;
  height: number;
  /** Art opening. */
  artWidth: number;
  artHeight: number;
  /** Distance from the frame edge to the art opening (band + mat). */
  inset: number;
}

/** Layout size for a frame around art of the given width and aspect ratio. */
export function getArtworkFrameSize(artWidth: number, aspectRatio: number): ArtworkFrameSizeResult {
  const artW = Math.max(1, Math.round(artWidth));
  const artH = Math.max(1, Math.round(artW / (aspectRatio > 0 ? aspectRatio : 1)));
  const m = frameMetrics(artW, artH);
  return { width: m.w, height: m.h, artWidth: artW, artHeight: artH, inset: m.inset };
}

function outlineStroke(tone: FrameOutlineTone, color: string): string | null {
  if (tone === 'color') return color;
  if (tone === 'warm') return OUTLINE_WARM;
  return null;
}

interface FrameSvgProps {
  paths: FramePaths;
  color: string;
  nail: boolean;
}

// Everything inside the SVG depends only on (kind, color, size, nail), so it
// is its own memo'd component: a child (image) update never re-renders it.
const FrameSvg = memo(function FrameSvg({ paths, color, nail }: FrameSvgProps) {
  const { w, h, band } = paths.metrics;
  const padTop = nail ? ARTWORK_NAIL_HEIGHT : PAD_TOP;
  const svgW = w + PAD_LEFT + PAD_RIGHT;
  const svgH = h + padTop + PAD_BOTTOM;
  const check = paths.checkSize;
  const stringY = Math.round(band * 6) / 10;
  const stringLeftX = Math.round(w * 26) / 100;
  const stringRightX = Math.round(w * 74) / 100;
  const patternId = `gingham-${color.replace(/[^A-Za-z0-9]/g, '')}-${check}`;
  const bodyFill =
    paths.bodyFill === 'gingham' ? `url(#${patternId})` : paths.bodyFill === 'cream' ? colors.frameCream : color;
  const outline = outlineStroke(paths.outlineTone, color);
  const lipColor = paths.lipTone === 'none' ? null : LIP_COLORS[paths.lipTone];

  return (
    <Svg
      accessibilityElementsHidden
      height={svgH}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ left: -PAD_LEFT, position: 'absolute', top: -padTop }}
      viewBox={`${-PAD_LEFT} ${-padTop} ${svgW} ${svgH}`}
      width={svgW}
    >
      {paths.bodyFill === 'gingham' ? (
        <Defs>
          <Pattern height={check} id={patternId} patternUnits="userSpaceOnUse" width={check}>
            <Rect fill="#FFFFFF" height={check} width={check} x={0} y={0} />
            <Rect fill={color} fillOpacity={0.5} height={check} width={check / 2} x={0} y={0} />
            <Rect fill={color} fillOpacity={0.5} height={check / 2} width={check} x={0} y={0} />
          </Pattern>
        </Defs>
      ) : null}
      {nail ? (
        <>
          <Path
            d={`M${stringLeftX} ${stringY} L${w / 2} ${NAIL_Y} L${stringRightX} ${stringY}`}
            fill="none"
            stroke={STRING_COLOR}
            strokeLinecap="round"
            strokeWidth={1.2}
          />
          <Circle cx={w / 2} cy={NAIL_Y} fill={NAIL_COLOR} r={3.4} />
          <Circle cx={w / 2 - 1} cy={NAIL_Y - 1.2} fill={NAIL_HIGHLIGHT} r={1.1} />
        </>
      ) : null}
      {SHADOW_COPIES.map((s) => (
        <Path
          d={paths.bodyPath}
          fill={colors.frameShadow}
          fillOpacity={s.opacity}
          key={s.dx}
          transform={`translate(${s.dx} ${s.dy})`}
        />
      ))}
      <Path d={paths.bodyPath} fill={bodyFill} />
      {paths.beads.length > 0 ? (
        <>
          <Path d={paths.beadsPath} fill={color} />
          <Path d={paths.beadHighlightsPath} fill="#FFFFFF" fillOpacity={0.6} />
        </>
      ) : null}
      {outline && paths.outlinePath ? (
        <Path d={paths.outlinePath} fill="none" stroke={outline} strokeWidth={1} />
      ) : null}
      {lipColor ? <Path d={paths.lipPath} fill="none" stroke={lipColor} strokeWidth={2} /> : null}
      <Path d={paths.matPath} fill={colors.frameMat} />
    </Svg>
  );
});

function ArtworkFrameBase({
  artWidth,
  aspectRatio,
  kind,
  color,
  tilt = 0,
  nail = false,
  children,
  testID,
  style,
}: ArtworkFrameProps) {
  const { width, height, artWidth: artW, artHeight: artH, inset } = getArtworkFrameSize(
    artWidth,
    aspectRatio,
  );
  // Memoized per (kind, artW, artH) inside framePaths; useMemo only skips the
  // key build + Map lookup on re-render.
  const paths = useMemo(() => framePaths(kind, frameMetrics(artW, artH)), [kind, artW, artH]);

  const containerStyle: ViewStyle = {
    height,
    transform: [{ rotate: `${tilt}deg` }],
    // Nail: swing about the nail. Otherwise hang from the top-center (the
    // Timeline reveal pivots there).
    transformOrigin: nail ? [width / 2, NAIL_Y, 0] : ['50%', 0, 0],
    width,
  };

  return (
    <View style={[containerStyle, style]} testID={testID}>
      <FrameSvg color={color} nail={nail} paths={paths} />
      <View
        style={[styles.opening, { height: artH, left: inset, top: inset, width: artW }]}
        testID={testID ? `${testID}-opening` : undefined}
      >
        {children}
        {/* Hairline inner shadow: the mat overhangs the art. */}
        <View
          pointerEvents="none"
          style={styles.innerShadow}
          testID={testID ? `${testID}-inner-shadow` : undefined}
        />
      </View>
    </View>
  );
}

export const ArtworkFrame = memo(ArtworkFrameBase);

const styles = StyleSheet.create({
  opening: {
    backgroundColor: ART_BACKDROP,
    overflow: 'hidden',
    position: 'absolute',
  },
  innerShadow: {
    ...StyleSheet.absoluteFill,
    borderBottomColor: 'rgba(60,40,20,0.10)',
    borderBottomWidth: 1,
    borderLeftColor: 'rgba(60,40,20,0.14)',
    borderLeftWidth: 1,
    borderRightColor: 'rgba(60,40,20,0.10)',
    borderRightWidth: 1,
    borderTopColor: 'rgba(60,40,20,0.30)',
    borderTopWidth: 2,
  },
});
