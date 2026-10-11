import { ARTWORK_FRAME_PAD, ARTWORK_NAIL_HEIGHT, ARTWORK_NAIL_Y } from '@/components/artwork-frame';
import {
  frameBodyBounds,
  frameBoxRect,
  frameVisualBounds,
  frameVisualBoundsOverTilts,
  frameVisualRect,
  rotatedRectBounds,
  shiftBounds,
  unionBounds,
} from '@/components/artwork/artwork-bounds';

describe('artwork bounds', () => {
  it('leaves an unrotated rect alone', () => {
    const rect = { left: -4, top: -2, right: 10, bottom: 20 };
    expect(rotatedRectBounds(rect, { x: 3, y: 5 }, 0)).toEqual(rect);
  });

  it('rotates clockwise for positive degrees (a point to the right swings down)', () => {
    const bounds = rotatedRectBounds({ left: 0, top: 0, right: 10, bottom: 0 }, { x: 0, y: 0 }, 90);
    expect(bounds.bottom).toBeCloseTo(10);
    expect(bounds.right).toBeCloseTo(0);
  });

  it('lifts the left corner of a top-pivoted box when tilted clockwise', () => {
    const bounds = frameBodyBounds(200, 300, 10, false);
    // (-100, 0) -> y = -100 * sin(10deg)
    expect(bounds.top).toBeCloseTo(-100 * Math.sin((10 * Math.PI) / 180), 5);
    expect(frameBodyBounds(200, 300, -10, false).top).toBeCloseTo(bounds.top, 5);
  });

  it('covers the SVG padding and the nail when nailed', () => {
    expect(frameVisualRect(100, 150, false)).toEqual({
      left: -ARTWORK_FRAME_PAD.left,
      top: -ARTWORK_FRAME_PAD.top,
      right: 100 + ARTWORK_FRAME_PAD.right,
      bottom: 150 + ARTWORK_FRAME_PAD.bottom,
    });
    expect(frameVisualRect(100, 150, true).top).toBe(-ARTWORK_NAIL_HEIGHT);
    // The nail itself sits inside the reserved height.
    expect(ARTWORK_NAIL_Y).toBeGreaterThan(-ARTWORK_NAIL_HEIGHT);
  });

  it('is never smaller than the box, and tilting only grows it', () => {
    const box = frameBoxRect(200, 300);
    for (const tilt of [0, 1.5, 4, -4]) {
      const bounds = frameVisualBounds(200, 300, tilt, true);
      expect(bounds.left).toBeLessThanOrEqual(box.left);
      expect(bounds.right).toBeGreaterThanOrEqual(box.right - 300 * Math.sin((4 * Math.PI) / 180));
      expect(bounds.bottom).toBeGreaterThan(box.bottom);
    }
    const rest = frameVisualBounds(200, 300, 0, true);
    const tilted = frameVisualBoundsOverTilts(200, 300, [0, 4, -4], true);
    expect(tilted.top).toBeLessThan(rest.top);
    expect(tilted.right).toBeGreaterThan(rest.right);
  });

  it('unions and shifts', () => {
    const a = { left: 0, top: 0, right: 5, bottom: 5 };
    const b = { left: -2, top: 1, right: 3, bottom: 9 };
    expect(unionBounds(a, b)).toEqual({ left: -2, top: 0, right: 5, bottom: 9 });
    expect(shiftBounds(a, 1, -1)).toEqual({ left: 1, top: -1, right: 6, bottom: 4 });
  });
});
