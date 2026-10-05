import type { CardOrientation, Focal } from './types';

/**
 * Card geometry (docs/plans/holiday-cards.md §3, C0 print spec): a flat 5x7
 * card, 177.8 x 127 mm trim, 4 mm bleed on every side INCLUDED in the file
 * (unlike the book files, whose bleed Prodigi adds). Coordinates throughout
 * the card code are millimetres from the top-left of the PAGE (bleed
 * included) unless a name says "trim".
 */
export const CARD = {
  trimLongMm: 177.8,
  trimShortMm: 127,
  bleedMm: 4,
  /** Gelato's hard minimum for text/QR inside the trim. */
  safeMinMm: 4,
  /** Our visual margin: nothing important sits closer than this to the trim. */
  safeMm: 8,
} as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardGeometry {
  orientation: CardOrientation;
  trimW: number;
  trimH: number;
  bleed: number;
  pageW: number;
  pageH: number;
  /** The trim box in page coordinates. */
  trim: Rect;
}

export function cardGeometry(orientation: CardOrientation): CardGeometry {
  const trimW = orientation === 'landscape' ? CARD.trimLongMm : CARD.trimShortMm;
  const trimH = orientation === 'landscape' ? CARD.trimShortMm : CARD.trimLongMm;
  const bleed = CARD.bleedMm;
  return {
    orientation,
    trimW,
    trimH,
    bleed,
    pageW: round(trimW + bleed * 2),
    pageH: round(trimH + bleed * 2),
    trim: { x: bleed, y: bleed, w: trimW, h: trimH },
  };
}

/** The card's orientation follows the chosen picture (a square counts as landscape). */
export function orientationFromImage(width: number, height: number): CardOrientation {
  return height > width ? 'portrait' : 'landscape';
}

/** Shifts a rect given in TRIM coordinates into page coordinates. */
export function trimToPage(g: CardGeometry, r: Rect): Rect {
  return { x: round(r.x + g.bleed), y: round(r.y + g.bleed), w: r.w, h: r.h };
}

/** The rect inset by `d` on every side. */
export function inset(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d };
}

/** Distance (mm) from each trim edge to the rect (negative = outside the trim). */
export function distancesToTrim(g: CardGeometry, r: Rect): { left: number; top: number; right: number; bottom: number } {
  return {
    left: round(r.x - g.trim.x),
    top: round(r.y - g.trim.y),
    right: round(g.trim.x + g.trim.w - (r.x + r.w)),
    bottom: round(g.trim.y + g.trim.h - (r.y + r.h)),
  };
}

export interface SafeViolation {
  name: string;
  minDistanceMm: number;
}

/** Elements (text boxes, QR) closer to the trim than `minMm` (default: the visual margin). */
export function safeViolations(g: CardGeometry, elements: { name: string; rect: Rect }[], minMm: number = CARD.safeMm): SafeViolation[] {
  const out: SafeViolation[] = [];
  for (const { name, rect } of elements) {
    const d = distancesToTrim(g, rect);
    const min = Math.min(d.left, d.top, d.right, d.bottom);
    if (min < minMm - 1e-6) out.push({ name, minDistanceMm: min });
  }
  return out;
}

export interface CoverCrop {
  /** The image's drawn rect in the box's own coordinates (x/y <= 0 when cropped). */
  draw: Rect;
  /** Fractions (0..1) of the source image cut off on each axis. */
  cropX: number;
  cropY: number;
  /** Source pixels per inch at the placed size. */
  dpi: number;
}

/**
 * `object-fit: cover` with a focal point, using CSS `object-position`
 * semantics: the focal point (0..1 on each axis) is where the visible window
 * sits in the slack the crop leaves (0 = top/left edge kept, 0.5 = centred, 1 =
 * bottom/right edge kept). That is exactly what the book's reposition modal
 * previews (`FocalPointModal`: `object-position: x% y%`), so what the user sees
 * while dragging is what prints. Never crops past the image. Default = centre.
 */
export function coverCrop(imgW: number, imgH: number, boxW: number, boxH: number, focal?: Focal | null): CoverCrop {
  const scale = Math.max(boxW / imgW, boxH / imgH);
  const dw = imgW * scale;
  const dh = imgH * scale;
  const f = { x: clamp01(focal?.x ?? 0.5), y: clamp01(focal?.y ?? 0.5) };
  const x = -(dw - boxW) * f.x;
  const y = -(dh - boxH) * f.y;
  return {
    draw: { x: round(x), y: round(y), w: round(dw), h: round(dh) },
    cropX: round4(1 - boxW / dw),
    cropY: round4(1 - boxH / dh),
    dpi: round(imgW / (dw / 25.4)),
  };
}

/**
 * The largest box inside `area` that frames an image of `imgAspect` (w/h)
 * while cropping at most `maxCrop` (fraction) of it on one axis. maxCrop 0 =
 * the whole picture, letterboxed into the area; larger values let the box
 * follow the area's shape more. The box is centred horizontally and sits at
 * the TOP of the area (the band below belongs to the greeting).
 */
export function fitBoxToImage(area: Rect, imgAspect: number, maxCrop: number): Rect {
  const areaAspect = area.w / area.h;
  let boxAspect = areaAspect;
  if (areaAspect > imgAspect) boxAspect = Math.min(areaAspect, imgAspect / (1 - maxCrop));
  else boxAspect = Math.max(areaAspect, imgAspect * (1 - maxCrop));
  let w = Math.min(area.w, area.h * boxAspect);
  let h = w / boxAspect;
  if (h > area.h) {
    h = area.h;
    w = h * boxAspect;
  }
  return { x: round(area.x + (area.w - w) / 2), y: round(area.y), w: round(w), h: round(h) };
}

export const PT_TO_MM = 25.4 / 72;
export function ptToMm(pt: number): number {
  return pt * PT_TO_MM;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
export function round(v: number): number {
  return Math.round(v * 100) / 100 + 0; // + 0 turns -0 into 0
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
