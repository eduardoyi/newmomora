// Pure layout math for the Timeline artwork wall card and deck
// (docs/plans/artwork-scanning-v2.md B1/B2). Sizes come from the approved
// canvas (Timeline.dc.html / ClusterDeck.dc.html, a 358px-wide card) and are
// scaled to the real content width, so row heights are deterministic: the
// width is `useWindowDimensions().width` minus the list's horizontal padding,
// never a measured value.
//
// Each card reserves its FULL visual extent inside its own layout: every slot
// pose (frame box + SVG shadow padding, rotated by its tilt), plus the reveal's
// drop and swing. iOS clips what a cell draws outside its bounds and the
// Timeline's opaque pinned control row paints over anything that pokes above
// the first cell, so nothing may overflow vertically (the deck's off-screen
// exit may overflow horizontally; that is expected). `artwork-bounds.ts` holds
// the rotation math; the tests assert the bounds never exceed the reserved box.

import { getArtworkFrameSize } from '@/components/artwork-frame';
import {
  frameVisualBounds,
  frameVisualRect,
  rotatedRectBounds,
  shiftBounds,
  type Bounds,
} from '@/components/artwork/artwork-bounds';
import { FRAME_TILT_MAX } from '@/components/artwork/frame-style';
import { DEFAULT_MEDIA_ASPECT_RATIO } from '@/utils/media-aspect';

/** The canvas's card width; every canvas number below is relative to it. */
export const ARTWORK_CANVAS_WIDTH = 358;

/** Timeline `cardItem` horizontal padding is `spacing.md` (16) on each side. */
export const TIMELINE_CARD_SIDE_PADDING = 16;

/** Single piece: art width as a fraction of the content width (196 / 358). */
export const SINGLE_ART_WIDTH_FRACTION = 196 / ARTWORK_CANVAS_WIDTH;
/** Single piece: tall art shrinks until the whole frame is at most this tall. */
export const SINGLE_FRAME_MAX_HEIGHT = 420;

/** Deck: art is fitted into this box (170 x 180 on the canvas). */
export const DECK_ART_BOX_WIDTH = 170 / ARTWORK_CANVAS_WIDTH;
export const DECK_ART_BOX_HEIGHT = 180 / ARTWORK_CANVAS_WIDTH;
/** Deck: at most this many frames are drawn in the stack. */
export const DECK_VISIBLE_SLOTS = 3;

/** A (rotated) frame may poke this far into the list's side padding (px)
 * before it is pulled back toward the center. */
export const DECK_SIDE_BLEED = 12;
/** Air between the deck's drawn extent and its container edge. */
const DECK_TOP_PAD = 2;
const DECK_BOTTOM_PAD = 2;
/** Tilt a front card reaches while it is flung off (see artwork-deck.tsx). */
export const DECK_EXIT_TILT_DEG = 16;

/** The reveal (artwork-reveal.tsx): a fresh piece drops in from this far above
 * and is tilted this many degrees before it swings down to its own tilt. This
 * is a ~1s transient and is deliberately NOT reserved in any layout: the
 * dropping frame may briefly overlap the area above the card or slide out from
 * under the pinned control row. Only static extents are reserved. */
export const REVEAL_DROP_PX = 40;
export const REVEAL_START_TILT = 9;

/** Single piece: the gap under the previous card (canvas padding above the
 * frame); the reveal allowance replaces it when larger. */
export const SINGLE_TOP_PAD = 18;

/** Slot offsets from the front card's center on the canvas (px at 358 wide),
 * and the back slots' fixed tilts. Slot 0 uses the piece's own tilt. */
export const DECK_SLOT_OFFSETS = [
  { x: 0, y: 0 },
  { x: 70, y: -85 },
  { x: -89, y: -31 },
] as const;
export const DECK_BACK_TILTS = [6, -7] as const;

const MIN_RATIO = 0.5;
const MAX_RATIO = 2;

/** The aspect ratio a piece is laid out with: the stored one (clamped so a
 * freak scan can't make a sliver) or the app default for a legacy null. */
export function artworkRatio(aspectRatio: number | null | undefined): number {
  const ratio = aspectRatio != null && aspectRatio > 0 ? aspectRatio : DEFAULT_MEDIA_ASPECT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function artworkContentWidth(windowWidth: number): number {
  return Math.max(1, windowWidth - TIMELINE_CARD_SIDE_PADDING * 2);
}

/** Art width for the single wall piece: ~55% of the content width, shrunk for
 * tall art so the frame never exceeds `SINGLE_FRAME_MAX_HEIGHT`. */
export function singleArtWidth(contentWidth: number, ratio: number): number {
  let artW = Math.max(1, Math.round(contentWidth * SINGLE_ART_WIDTH_FRACTION));
  for (let i = 0; i < 6; i += 1) {
    const size = getArtworkFrameSize(artW, ratio);
    if (size.height <= SINGLE_FRAME_MAX_HEIGHT) break;
    artW = Math.max(1, Math.floor((SINGLE_FRAME_MAX_HEIGHT - 2 * size.inset) * ratio));
  }
  while (artW > 1 && getArtworkFrameSize(artW, ratio).height > SINGLE_FRAME_MAX_HEIGHT) {
    artW -= 1;
  }
  return artW;
}

/** Art width for one deck piece: fitted into the canvas art box (170 x 180),
 * so squares and landscapes are 170 wide and tall portraits are height-limited. */
export function deckArtWidth(contentWidth: number, ratio: number): number {
  const maxW = contentWidth * DECK_ART_BOX_WIDTH;
  const maxH = contentWidth * DECK_ART_BOX_HEIGHT;
  return Math.max(1, Math.round(Math.min(maxW, maxH * ratio)));
}

export interface SingleLayout {
  artWidth: number;
  /** Frame box. */
  frameWidth: number;
  frameHeight: number;
  /** Space reserved above the frame box: the canvas gap at minimum, and the
   * resting tilt's lift plus the SVG's top padding when that is more. The
   * reveal's transient drop and swing are NOT included. */
  topPad: number;
}

/** Single-piece layout. The frame rests at up to FRAME_TILT_MAX either way
 * (pivoting about its top-center), so the top reserve covers the highest point
 * its tilted body + SVG padding reach. (Sides and bottom have room: the frame
 * is ~55% of the width and the label sits 26px below.) */
export function singleLayout(contentWidth: number, ratio: number): SingleLayout {
  const artWidth = singleArtWidth(contentWidth, ratio);
  const size = getArtworkFrameSize(artWidth, ratio);
  const restTop = Math.min(
    frameVisualBounds(size.width, size.height, FRAME_TILT_MAX, false).top,
    frameVisualBounds(size.width, size.height, -FRAME_TILT_MAX, false).top,
  );
  return {
    artWidth,
    frameWidth: size.width,
    frameHeight: size.height,
    topPad: Math.max(SINGLE_TOP_PAD, Math.ceil(-Math.min(restTop, 0))),
  };
}

export interface DeckPieceLayout {
  artWidth: number;
  ratio: number;
  /** Frame box. */
  width: number;
  height: number;
  /** Largest |x| the slot offset may reach before the rotated frame would
   * poke further than DECK_SIDE_BLEED past the container. */
  maxShiftX: number;
}

export interface DeckLayout {
  /** Container size (deterministic for a given width + ratio set). */
  width: number;
  height: number;
  /** Where the front slot's center sits in the container. */
  centerX: number;
  centerY: number;
  /** contentWidth / canvas width: applies to the slot offsets. */
  scale: number;
  /** Where the "n of N" tag sits (container coordinates). */
  tagLeft: number;
  tagTop: number;
  pieces: DeckPieceLayout[];
}

/** Tilts a piece can have in each slot (slot 0 wears the piece's own tilt,
 * |tilt| <= FRAME_TILT_MAX, either sign). */
function slotTilts(slot: number): readonly number[] {
  if (slot === 0) return [-FRAME_TILT_MAX, FRAME_TILT_MAX];
  return [DECK_BACK_TILTS[slot - 1]];
}

/** Visual bounds (frame + shadow padding, rotated) of a piece in `slot`,
 * relative to the FRONT slot's center. Frames rotate about their own center
 * in the deck. */
export function deckSlotBounds(
  piece: { width: number; height: number },
  slot: number,
  tilt: number,
  scale: number,
): Bounds {
  const rect = frameVisualRect(piece.width, piece.height, false);
  const centered: Bounds = {
    left: rect.left - piece.width / 2,
    top: rect.top - piece.height / 2,
    right: rect.right - piece.width / 2,
    bottom: rect.bottom - piece.height / 2,
  };
  const rotated = rotatedRectBounds(centered, { x: 0, y: 0 }, tilt);
  const offset = DECK_SLOT_OFFSETS[slot];
  return shiftBounds(rotated, offset.x * scale, offset.y * scale);
}

/** Lays out the deck for the given piece ratios. The container is as tall as
 * the worst case over ALL pieces and ALL slots (any piece may be in any slot
 * as the deck cycles), so the row never changes height while cycling, and
 * every STATIC slot pose's visual extent sits inside it vertically. Transients
 * are not reserved: the front card's exit / tuck (swipe) and the reveal's drop
 * may overlap outside the row for their duration. */
export function deckLayout(contentWidth: number, ratios: readonly number[]): DeckLayout {
  const scale = contentWidth / ARTWORK_CANVAS_WIDTH;
  const sizes = ratios.map((ratio) => {
    const artWidth = deckArtWidth(contentWidth, ratio);
    const size = getArtworkFrameSize(artWidth, ratio);
    return { artWidth, ratio, width: size.width, height: size.height };
  });
  const maxHalfHeight = Math.max(0, ...sizes.map((p) => p.height / 2));

  // Vertical envelope relative to the front slot's center.
  let minTop = 0;
  let maxBottom = 0;
  for (const piece of sizes) {
    for (let slot = 0; slot < DECK_VISIBLE_SLOTS; slot += 1) {
      for (const tilt of slotTilts(slot)) {
        const bounds = deckSlotBounds(piece, slot, tilt, scale);
        minTop = Math.min(minTop, bounds.top);
        maxBottom = Math.max(maxBottom, bounds.bottom);
      }
    }
  }
  const centerY = Math.ceil(DECK_TOP_PAD - minTop);
  const height = Math.ceil(centerY + maxBottom + DECK_BOTTOM_PAD);

  const pieces = sizes.map((piece): DeckPieceLayout => {
    let halfExtentX = piece.width / 2;
    for (let slot = 0; slot < DECK_VISIBLE_SLOTS; slot += 1) {
      for (const tilt of slotTilts(slot)) {
        const body = rotatedRectBounds(
          { left: -piece.width / 2, top: -piece.height / 2, right: piece.width / 2, bottom: piece.height / 2 },
          { x: 0, y: 0 },
          tilt,
        );
        halfExtentX = Math.max(halfExtentX, body.right);
      }
    }
    return {
      ...piece,
      maxShiftX: Math.max(0, contentWidth / 2 + DECK_SIDE_BLEED - halfExtentX),
    };
  });

  return {
    width: contentWidth,
    height,
    centerX: contentWidth / 2,
    centerY,
    scale,
    // Overlaps the front frame's lower-right corner (canvas: left 268, 64 above
    // the front frame's bottom edge).
    tagLeft: Math.round((268 / ARTWORK_CANVAS_WIDTH) * contentWidth),
    tagTop: Math.round(centerY + maxHalfHeight - 64 * scale),
    pieces,
  };
}

export interface DeckPose {
  x: number;
  y: number;
  /** Degrees. */
  rotate: number;
}

/** Pose of a card at a (possibly fractional) depth. Depth 0 = front (the
 * piece's own tilt), 1 = back-right, 2 = back-left; fractional depths blend
 * linearly, which is what animates a card from one slot to the next. */
export function deckSlotPose(depth: number, frontTilt: number, scale: number): DeckPose {
  'worklet';
  const clamped = Math.min(2, Math.max(0, depth));
  const lower = Math.floor(clamped);
  const upper = Math.min(2, lower + 1);
  const t = clamped - lower;
  const tilt = (slot: number) => (slot === 0 ? frontTilt : DECK_BACK_TILTS[slot - 1]);
  const offsetX = (slot: number) => DECK_SLOT_OFFSETS[slot].x;
  const offsetY = (slot: number) => DECK_SLOT_OFFSETS[slot].y;
  return {
    x: (offsetX(lower) + (offsetX(upper) - offsetX(lower)) * t) * scale,
    y: (offsetY(lower) + (offsetY(upper) - offsetY(lower)) * t) * scale,
    rotate: tilt(lower) + (tilt(upper) - tilt(lower)) * t,
  };
}
