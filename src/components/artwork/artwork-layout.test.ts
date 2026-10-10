import { getArtworkFrameSize } from '@/components/artwork-frame';
import {
  ARTWORK_CANVAS_WIDTH,
  SINGLE_FRAME_MAX_HEIGHT,
  artworkContentWidth,
  artworkRatio,
  deckArtWidth,
  deckLayout,
  deckSlotPose,
  singleArtWidth,
} from '@/components/artwork/artwork-layout';

describe('artwork layout', () => {
  it('derives the content width from the window minus the list padding', () => {
    expect(artworkContentWidth(390)).toBe(358);
  });

  it('clamps freak ratios and defaults a missing one', () => {
    expect(artworkRatio(0.1)).toBe(0.5);
    expect(artworkRatio(9)).toBe(2);
    expect(artworkRatio(0.75)).toBe(0.75);
    expect(artworkRatio(null)).toBeCloseTo(4 / 3);
  });

  describe('singleArtWidth', () => {
    it('matches the canvas (196 of 358) for ordinary art', () => {
      expect(singleArtWidth(358, 0.77)).toBe(196);
    });

    it('shrinks tall art so the frame fits the max height', () => {
      const artW = singleArtWidth(358, 0.5);
      expect(artW).toBeLessThan(196);
      const size = getArtworkFrameSize(artW, 0.5);
      expect(size.height).toBeLessThanOrEqual(SINGLE_FRAME_MAX_HEIGHT);
      // ...and not by a lot more than needed.
      expect(size.height).toBeGreaterThan(SINGLE_FRAME_MAX_HEIGHT - 20);
    });

    it('is deterministic for a width and ratio', () => {
      expect(singleArtWidth(343, 1.3)).toBe(singleArtWidth(343, 1.3));
    });
  });

  describe('deck', () => {
    it('fits art into the canvas box: squares and landscapes 170 wide, portraits height-limited', () => {
      expect(deckArtWidth(358, 1)).toBe(170);
      expect(deckArtWidth(358, 1.5)).toBe(170);
      expect(deckArtWidth(358, 0.667)).toBe(120);
    });

    it('is as tall as the worst case over all pieces, whatever the order', () => {
      const a = deckLayout(358, [1, 1.5, 0.667]);
      const b = deckLayout(358, [0.667, 1, 1.5]);
      expect(a.height).toBe(b.height);
      // The square (238 tall) sets the envelope: back-right slot 85px up.
      expect(a.centerY).toBe(8 + 85 + 119);
      expect(a.height).toBe(a.centerY + 119 + 12);
    });

    it('scales offsets with the content width', () => {
      expect(deckLayout(358, [1]).scale).toBe(1);
      expect(deckLayout(179, [1]).scale).toBeCloseTo(0.5);
      expect(ARTWORK_CANVAS_WIDTH).toBe(358);
    });

    it('lays out every piece with its own frame size', () => {
      const layout = deckLayout(358, [1, 1.5, 0.667]);
      expect(layout.pieces.map((p) => [p.width, p.height])).toEqual([
        [238, 238],
        [222, 165],
        [172, 232],
      ]);
    });
  });

  describe('deckSlotPose', () => {
    it('puts the front card at the center with its own tilt', () => {
      expect(deckSlotPose(0, -2.2, 1)).toEqual({ x: 0, y: 0, rotate: -2.2 });
    });

    it('puts back slots at the canvas offsets and tilts', () => {
      expect(deckSlotPose(1, -2.2, 1)).toEqual({ x: 70, y: -85, rotate: 6 });
      expect(deckSlotPose(2, -2.2, 1)).toEqual({ x: -89, y: -31, rotate: -7 });
    });

    it('blends between slots and scales the offsets', () => {
      const mid = deckSlotPose(0.5, 2, 0.5);
      expect(mid.x).toBeCloseTo(17.5);
      expect(mid.y).toBeCloseTo(-21.25);
      expect(mid.rotate).toBeCloseTo(4);
    });

    it('clamps out-of-range depths', () => {
      expect(deckSlotPose(-1, 1, 1).x).toBe(0);
      expect(deckSlotPose(5, 1, 1).x).toBe(-89);
    });
  });
});
