import {
  ARTWORK_FRAME_PAD,
  ARTWORK_NAIL_HEIGHT,
  ARTWORK_NAIL_Y,
} from '@/components/artwork-frame';

// Pure bounding-box math for a (possibly rotated) artwork frame. The Timeline
// card and the detail track must reserve a frame's FULL visual extent inside
// their own layout: iOS clips what a cell draws outside its bounds (and the
// Timeline's opaque pinned control row paints over whatever pokes above the
// first cell), so anything past the layout box is at best cut off.
//
// Coordinates: x right, y down, origin at the frame's layout box top-left.
// Rotation follows React Native: positive degrees turn clockwise.

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned bounds of `rect` rotated `degrees` about `pivot`. */
export function rotatedRectBounds(rect: Bounds, pivot: Point, degrees: number): Bounds {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const corner of [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ]) {
    const dx = corner.x - pivot.x;
    const dy = corner.y - pivot.y;
    const x = pivot.x + dx * cos - dy * sin;
    const y = pivot.y + dx * sin + dy * cos;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom };
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

export function shiftBounds(bounds: Bounds, dx: number, dy: number): Bounds {
  return {
    left: bounds.left + dx,
    top: bounds.top + dy,
    right: bounds.right + dx,
    bottom: bounds.bottom + dy,
  };
}

/** The frame's layout box. */
export function frameBoxRect(width: number, height: number): Bounds {
  return { left: 0, top: 0, right: width, bottom: height };
}

/** Everything the frame can draw: the layout box plus its SVG padding (cast
 * shadow below / right, and the nail + string above a nailed frame). The SVG
 * viewport clips to this, so it is a hard upper bound. */
export function frameVisualRect(width: number, height: number, nail: boolean): Bounds {
  return {
    left: -ARTWORK_FRAME_PAD.left,
    top: -(nail ? ARTWORK_NAIL_HEIGHT : ARTWORK_FRAME_PAD.top),
    right: width + ARTWORK_FRAME_PAD.right,
    bottom: height + ARTWORK_FRAME_PAD.bottom,
  };
}

/** Where `ArtworkFrame` rotates: top-center, or the nail when nailed. */
export function framePivot(width: number, nail: boolean): Point {
  return { x: width / 2, y: nail ? ARTWORK_NAIL_Y : 0 };
}

/** Visual bounds of a frame hung (or Timeline-pinned) at `tilt` degrees, in
 * its own layout box coordinates. */
export function frameVisualBounds(
  width: number,
  height: number,
  tilt: number,
  nail: boolean,
): Bounds {
  return rotatedRectBounds(frameVisualRect(width, height, nail), framePivot(width, nail), tilt);
}

/** The same for the frame body only (no shadow / string): what a neighbour or
 * a screen edge must not be overlapped by. */
export function frameBodyBounds(
  width: number,
  height: number,
  tilt: number,
  nail: boolean,
): Bounds {
  return rotatedRectBounds(frameBoxRect(width, height), framePivot(width, nail), tilt);
}

/** Union of `frameVisualBounds` over a set of tilts. */
export function frameVisualBoundsOverTilts(
  width: number,
  height: number,
  tilts: readonly number[],
  nail: boolean,
): Bounds {
  let result = frameVisualBounds(width, height, tilts[0] ?? 0, nail);
  for (let i = 1; i < tilts.length; i += 1) {
    result = unionBounds(result, frameVisualBounds(width, height, tilts[i], nail));
  }
  return result;
}
