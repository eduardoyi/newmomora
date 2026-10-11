import { getArtworkFrameSize } from '@/components/artwork-frame';
import { frameBodyBounds, frameVisualBounds } from '@/components/artwork/artwork-bounds';
import {
  ARTWORK_CANVAS_WIDTH,
  DECK_BACK_TILTS,
  DECK_EXIT_TILT_DEG,
  DECK_SIDE_BLEED,
  DECK_SLOT_OFFSETS,
  DECK_VISIBLE_SLOTS,
  REVEAL_DROP_PX,
  REVEAL_START_TILT,
  SINGLE_FRAME_MAX_HEIGHT,
  SINGLE_TOP_PAD,
  artworkContentWidth,
  artworkRatio,
  deckArtWidth,
  deckLayout,
  deckSlotBounds,
  deckSlotPose,
  singleArtWidth,
  singleLayout,
} from '@/components/artwork/artwork-layout';
import { FRAME_TILT_MAX } from '@/components/artwork/frame-style';

const WIDTHS = [296, 328, 358, 382, 414, 600];
const RATIO_SETS: number[][] = [
  [1],
  [0.5, 0.5, 0.5],
  [2, 2, 2],
  [0.75, 0.75, 0.75, 0.75],
  [1, 1.5, 0.667],
  [0.5, 2, 1, 0.8, 1.3],
  [0.667, 0.667],
];
const RATIOS = [0.5, 0.667, 0.75, 1, 1.33, 1.5, 2];

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
      // Taller pieces never shorten the row below a shorter set's.
      expect(a.height).toBeGreaterThan(deckLayout(358, [1]).height - 1);
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

  describe('reserved bounds (nothing draws outside the card on iOS)', () => {
    describe('single piece', () => {
      it('reserves the canvas gap at minimum', () => {
        for (const ratio of RATIOS) {
          expect(singleLayout(358, ratio).topPad).toBeGreaterThanOrEqual(SINGLE_TOP_PAD);
        }
      });

      it('keeps the tilted frame and its shadow inside the top reserve', () => {
        for (const width of WIDTHS) {
          for (const ratio of RATIOS) {
            const layout = singleLayout(width, ratio);
            for (const tilt of [-FRAME_TILT_MAX, 0, FRAME_TILT_MAX]) {
              const bounds = frameVisualBounds(layout.frameWidth, layout.frameHeight, tilt, false);
              expect(-bounds.top).toBeLessThanOrEqual(layout.topPad);
            }
          }
        }
      });

      it('does not reserve the transient reveal: it may overflow upward (accepted)', () => {
        for (const width of WIDTHS) {
          for (const ratio of RATIOS) {
            const layout = singleLayout(width, ratio);
            const bounds = frameVisualBounds(layout.frameWidth, layout.frameHeight, REVEAL_START_TILT, false);
            const revealReach = -(bounds.top - REVEAL_DROP_PX);
            // The static reserve is far below the reveal's reach...
            expect(layout.topPad).toBeLessThan(revealReach);
            // ...and equals the canvas gap or the resting tilt's own reach, nothing more.
            const rest = Math.max(
              -frameVisualBounds(layout.frameWidth, layout.frameHeight, FRAME_TILT_MAX, false).top,
              -frameVisualBounds(layout.frameWidth, layout.frameHeight, -FRAME_TILT_MAX, false).top,
            );
            expect(layout.topPad).toBe(Math.max(SINGLE_TOP_PAD, Math.ceil(rest)));
          }
        }
        expect(REVEAL_DROP_PX).toBe(40);
      });

      it('leaves the art width alone (no shrinking for the reveal swing)', () => {
        for (const width of [288, ...WIDTHS]) {
          for (const ratio of RATIOS) {
            expect(singleLayout(width, ratio).artWidth).toBe(singleArtWidth(width, ratio));
          }
        }
      });
    });

    describe('deck', () => {
      it('puts every slot pose (frame + shadow, rotated) inside the container vertically', () => {
        for (const width of WIDTHS) {
          for (const ratios of RATIO_SETS) {
            const layout = deckLayout(width, ratios);
            for (const piece of layout.pieces) {
              for (let slot = 0; slot < DECK_VISIBLE_SLOTS; slot += 1) {
                const tilts = slot === 0 ? [-FRAME_TILT_MAX, FRAME_TILT_MAX] : [DECK_BACK_TILTS[slot - 1]];
                for (const tilt of tilts) {
                  const bounds = deckSlotBounds(piece, slot, tilt, layout.scale);
                  expect(layout.centerY + bounds.top).toBeGreaterThanOrEqual(0);
                  expect(layout.centerY + bounds.bottom).toBeLessThanOrEqual(layout.height);
                }
              }
            }
          }
        }
      });

      it('does not reserve the transients: the exit tilt and the reveal drop may overflow upward', () => {
        const layout = deckLayout(390, [0.75, 0.75, 0.75]);
        const piece = layout.pieces[0];
        // The row height is exactly the static envelope: unchanged by the exit
        // tilt (its bottom reach) and the reveal (its top reach).
        const exit = deckSlotBounds(piece, 0, DECK_EXIT_TILT_DEG, layout.scale);
        expect(layout.centerY + exit.bottom).toBeGreaterThan(
          layout.centerY + deckSlotBounds(piece, 0, FRAME_TILT_MAX, layout.scale).bottom,
        );
        expect(layout.height).toBe(
          Math.ceil(
            layout.centerY +
              Math.max(
                ...layout.pieces.flatMap((p) =>
                  [0, 1, 2].flatMap((slot) =>
                    (slot === 0 ? [-FRAME_TILT_MAX, FRAME_TILT_MAX] : [DECK_BACK_TILTS[slot - 1]]).map(
                      (tilt) => deckSlotBounds(p, slot, tilt, layout.scale).bottom,
                    ),
                  ),
                ),
              ) + 2,
          ),
        );
      });

      it('keeps every clamped slot pose inside the side bleed', () => {
        for (const width of WIDTHS) {
          for (const ratios of RATIO_SETS) {
            const layout = deckLayout(width, ratios);
            for (const piece of layout.pieces) {
              for (let slot = 0; slot < DECK_VISIBLE_SLOTS; slot += 1) {
                const tilts = slot === 0 ? [-FRAME_TILT_MAX, FRAME_TILT_MAX] : [DECK_BACK_TILTS[slot - 1]];
                for (const tilt of tilts) {
                  const rawX = DECK_SLOT_OFFSETS[slot].x * layout.scale;
                  const x = Math.min(piece.maxShiftX, Math.max(-piece.maxShiftX, rawX));
                  const body = frameBodyBounds(piece.width, piece.height, tilt, false);
                  // frameBodyBounds pivots about the top-center; re-center on the box.
                  const rotatedHalfWidth = (body.right - body.left) / 2;
                  const centerX = layout.centerX + x;
                  const halfWidth = Math.max(rotatedHalfWidth, piece.width / 2);
                  expect(centerX - halfWidth).toBeGreaterThanOrEqual(-DECK_SIDE_BLEED - 1);
                  expect(centerX + halfWidth).toBeLessThanOrEqual(layout.width + DECK_SIDE_BLEED + 1);
                }
              }
            }
          }
        }
      });

      it('has the same height whatever order the pieces are in', () => {
        const ratios = [0.5, 2, 1, 0.8, 1.3];
        const forward = deckLayout(358, ratios);
        const reversed = deckLayout(358, [...ratios].reverse());
        const rotated = deckLayout(358, [...ratios.slice(2), ...ratios.slice(0, 2)]);
        expect(reversed.height).toBe(forward.height);
        expect(rotated.height).toBe(forward.height);
        expect(reversed.centerY).toBe(forward.centerY);
      });
    });
  });
});
