// Pure layout math behind `HolidayCardFront` (src/components/keepsakes/
// holiday-card-front.tsx): a port of the PRINT layout of the holiday card's
// front, so the app's thumbnail looks like the card the family designed.
//
// Sources of truth (book-renderer/ is excluded from the app's tsconfig/Metro,
// so the constants and math are copied here, with these pointers):
//   book-renderer/src/card/geometry.ts   CARD (177.8 x 127 mm 5R trim),
//                                        fitBoxToImage, ptToMm, cardGeometry
//   book-renderer/src/card/document.ts   buildFront: full-bleed (L202-252),
//                                        bordered (L254-299), FRONT_MARGIN_MM,
//                                        BAND_*_MM, CARD_STYLE
//   book-renderer/src/card/CardFront.tsx scrim gradient, stacked vs inline text
//   book-renderer/src/card/fromData.ts   text sources (greeting, subline)
//   book-renderer/src/card/greetings.ts  default greetings
//                                        (mirrored by HOLIDAY_CARD_GREETING_TEXT)
//
// We render the TRIM only (the 4 mm bleed is dropped) and scale every
// millimetre by `pxPerMm = width / trimW`. The print files carry an A5 variant
// for Europe (148 x 210 mm); `keepsakes_overview.card_front` does not say which
// format a card has, and 5R vs A5 differ by ~1.4% in aspect, so 5R is used.
import {
  HOLIDAY_CARD_GREETING_TEXT,
  type HolidayCardGreeting,
  type HolidayCardLanguage,
} from '@/services/holiday-cards';
import type { KeepsakesCardFront, KeepsakesCardOrientation } from '@/services/keepsakes';

// ---------------------------------------------------------------------------
// Constants (geometry.ts CARD, document.ts, CARD_STYLE)
// ---------------------------------------------------------------------------

export const CARD_TRIM_LONG_MM = 177.8;
export const CARD_TRIM_SHORT_MM = 127;
/** The print files add this on every side; the app render drops it. */
export const CARD_BLEED_MM = 4;
export const PT_TO_MM = 25.4 / 72;

export const FRONT_MARGIN_MM = 12;
export const BAND_MARGIN_MM = 8;
export const BAND_H_MM = 21;
export const BAND_TEXT_BOTTOM_MM = 8.5;
/** `maxCrop` for the bordered layout's picture box. */
export const BORDERED_MAX_CROP = 0.15;
export const SUBLINE_PT = 7;
export const SUBLINE_SPACING_EM = 0.32;
/** The scrim covers this share of the PAGE height (trim + bleed). */
export const SCRIM_PAGE_FRACTION = 0.42;
export const GREETING_LINE_HEIGHT = 1.15;
export const SUBLINE_LINE_HEIGHT = 1.2;

export const CARD_FRONT_STYLE = {
  paper: '#FAF8FC',
  accent: '#8E7FB8',
  accentInk: '#4A3F6B',
  light: '#FFFFFF',
  lightSoft: 'rgba(255,255,255,0.88)',
} as const;

/** The scrim's colour stops (CardFront.tsx): 0.36 at the greeting edge, 0.15 at 45%, 0 at the end. */
export const SCRIM_COLORS = ['rgba(24,20,40,0.36)', 'rgba(24,20,40,0.15)', 'rgba(24,20,40,0)'] as const;
export const SCRIM_LOCATIONS = [0, 0.45, 1] as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rounds to 2 decimals (geometry.ts `round`; `+ 0` turns -0 into 0). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

export function ptToMm(pt: number): number {
  return pt * PT_TO_MM;
}

export function cardTrimMm(orientation: KeepsakesCardOrientation): { w: number; h: number } {
  return orientation === 'landscape'
    ? { w: CARD_TRIM_LONG_MM, h: CARD_TRIM_SHORT_MM }
    : { w: CARD_TRIM_SHORT_MM, h: CARD_TRIM_LONG_MM };
}

/** Height / width of the card's trim: 0.714 landscape, 1.4 portrait. */
export function cardAspectRatio(orientation: KeepsakesCardOrientation): number {
  const trim = cardTrimMm(orientation);
  return trim.h / trim.w;
}

// ---------------------------------------------------------------------------
// fitBoxToImage (geometry.ts L140-159), exact port
// ---------------------------------------------------------------------------

/**
 * The largest box inside `area` that frames an image of `imgAspect` (w/h)
 * while cropping at most `maxCrop` (fraction) of it on one axis. Centred
 * horizontally, at the TOP of the area (the band below belongs to the
 * greeting).
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
  return { x: round2(area.x + (area.w - w) / 2), y: round2(area.y), w: round2(w), h: round2(h) };
}

// ---------------------------------------------------------------------------
// Focal point -> expo-image contentPosition
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * `object-fit: cover` + CSS `object-position` semantics (geometry.ts
 * `coverCrop`): the focal point is where the visible window sits in the slack
 * the crop leaves (0 = top/left edge kept, 1 = bottom/right). expo-image's
 * `contentPosition` percentages mean the same thing, so the focal maps 1:1.
 * No focal = the centre.
 */
export function focalToContentPosition(focal: { x: number; y: number } | null): {
  left: `${number}%`;
  top: `${number}%`;
} {
  const x = clamp01(focal?.x ?? 0.5);
  const y = clamp01(focal?.y ?? 0.5);
  return { left: `${round2(x * 100)}%`, top: `${round2(y * 100)}%` };
}

// ---------------------------------------------------------------------------
// Text sources (fromData.ts)
// ---------------------------------------------------------------------------

/** The default greeting of a language ("Happy Holidays" / "Felices fiestas"). */
export function defaultGreetingText(language: HolidayCardLanguage, key: HolidayCardGreeting): string {
  return HOLIDAY_CARD_GREETING_TEXT[language][key];
}

/**
 * greeting = the edited text, else the language default; subline = the edited
 * line, else the year, and hidden (null) when empty. A blank edited greeting
 * falls back to the default (the editor never saves a required field empty).
 */
export function holidayCardFrontText(front: KeepsakesCardFront): { greeting: string; subline: string | null } {
  const edited = front.greeting_text;
  const greeting = edited !== null && edited.trim() !== '' ? edited : defaultGreetingText(front.language, front.greeting);
  const rawSubline = front.subline_text ?? String(front.year);
  return { greeting, subline: rawSubline.trim() === '' ? null : rawSubline };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The rendered card's size for a given width (the trim's aspect). */
export function holidayCardFrontSize(
  front: Pick<KeepsakesCardFront, 'orientation'>,
  width: number,
): { width: number; height: number } {
  return { width, height: Math.round(width * cardAspectRatio(front.orientation)) };
}

export type FrontAlign = 'left' | 'center' | 'right';

export interface FrontTextMetrics {
  /** Font sizes and line boxes in px. */
  greetingFontPx: number;
  greetingLinePx: number;
  sublineFontPx: number;
  sublineLinePx: number;
  /** The subline's letter spacing in px (0.32em). */
  sublineSpacingPx: number;
}

export interface FullBleedFrontLayout {
  kind: 'full-bleed';
  width: number;
  height: number;
  /** px per mm. */
  scale: number;
  greeting: string;
  subline: string | null;
  text: FrontTextMetrics;
  /** The picture fills the whole trim. */
  image: Rect;
  scrim: { edge: 'top' | 'bottom'; heightPx: number };
  /** `top` = the text block hangs from the top margin; else it sits on the bottom margin. */
  edge: 'top' | 'bottom';
  align: FrontAlign;
  marginPx: number;
  /** Gap between greeting and subline (0 without a subline). */
  gapPx: number;
}

export interface BorderedFrontLayout {
  kind: 'bordered';
  width: number;
  height: number;
  scale: number;
  greeting: string;
  subline: string | null;
  text: FrontTextMetrics;
  /** The picture box (fitBoxToImage), square corners. */
  image: Rect;
  /** The same box in millimetres from the trim's top-left. */
  imageMm: Rect;
  /** The inline row's line box: bottom edge 8.5 mm above the trim bottom. */
  rowBottomPx: number;
  rowHeightPx: number;
  gapPx: number;
}

export type HolidayCardFrontLayout = FullBleedFrontLayout | BorderedFrontLayout;

function textMetrics(scale: number, greetingPt: number): FrontTextMetrics {
  const greetingMm = ptToMm(greetingPt);
  const sublineMm = ptToMm(SUBLINE_PT);
  return {
    greetingFontPx: greetingMm * scale,
    greetingLinePx: greetingMm * GREETING_LINE_HEIGHT * scale,
    sublineFontPx: sublineMm * scale,
    sublineLinePx: sublineMm * SUBLINE_LINE_HEIGHT * scale,
    sublineSpacingPx: sublineMm * SUBLINE_SPACING_EM * scale,
  };
}

function alignOf(position: KeepsakesCardFront['greeting_position']): FrontAlign {
  return position.endsWith('left') ? 'left' : position.endsWith('right') ? 'right' : 'center';
}

/**
 * Everything `HolidayCardFront` draws, in px, from the card_front and the
 * rendered width. Mirrors `buildFront` (document.ts): the picture's aspect
 * defaults to the card's own when the size is unknown.
 */
export function buildHolidayCardFrontLayout(front: KeepsakesCardFront, width: number): HolidayCardFrontLayout {
  const trim = cardTrimMm(front.orientation);
  const scale = width / trim.w;
  const { width: boxWidth, height } = holidayCardFrontSize(front, width);
  const { greeting, subline } = holidayCardFrontText(front);
  const portrait = front.orientation === 'portrait';

  if (front.layout === 'full-bleed') {
    const text = textMetrics(scale, portrait ? 24 : 27);
    const edge = front.greeting_position.startsWith('top') ? 'top' : 'bottom';
    // The print scrim is 42% of the PAGE (trim + 2 bleeds) measured from the
    // page edge; the trim shows everything past the first bleed.
    const scrimMm = SCRIM_PAGE_FRACTION * (trim.h + 2 * CARD_BLEED_MM) - CARD_BLEED_MM;
    return {
      kind: 'full-bleed',
      width: boxWidth,
      height,
      scale,
      greeting,
      subline,
      text,
      image: { x: 0, y: 0, w: boxWidth, h: height },
      scrim: { edge, heightPx: scrimMm * scale },
      edge,
      align: alignOf(front.greeting_position),
      marginPx: FRONT_MARGIN_MM * scale,
      gapPx: subline !== null ? 2 * scale : 0,
    };
  }

  // Bordered: the picture box sits in the area left by an 8 mm margin (top and
  // sides) and a 21 mm greeting band at the bottom.
  // Computed in PAGE coordinates like the print code (so the 2-decimal
  // rounding matches), then shifted back by the bleed into the trim.
  const area: Rect = {
    x: BAND_MARGIN_MM + CARD_BLEED_MM,
    y: BAND_MARGIN_MM + CARD_BLEED_MM,
    w: trim.w - 2 * BAND_MARGIN_MM,
    h: trim.h - BAND_MARGIN_MM - BAND_H_MM,
  };
  const imageAspect = front.width !== null && front.height !== null ? front.width / front.height : trim.w / trim.h;
  const pageBox = fitBoxToImage(area, imageAspect, BORDERED_MAX_CROP);
  const box: Rect = { x: round2(pageBox.x - CARD_BLEED_MM), y: round2(pageBox.y - CARD_BLEED_MM), w: pageBox.w, h: pageBox.h };
  const text = textMetrics(scale, portrait ? 21 : 20);
  return {
    kind: 'bordered',
    width: boxWidth,
    height,
    scale,
    greeting,
    subline,
    text,
    image: { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale },
    imageMm: box,
    rowBottomPx: BAND_TEXT_BOTTOM_MM * scale,
    rowHeightPx: text.greetingLinePx,
    gapPx: subline !== null ? 4 * scale : 0,
  };
}

// ---------------------------------------------------------------------------
// Card + envelope object geometry
// ---------------------------------------------------------------------------

/** The envelope sticks out this far to the right / above, in units of the card's SHORTER side. */
export const ENVELOPE_PEEK_RIGHT = 0.27;
export const ENVELOPE_PEEK_TOP = 0.14;
/** The envelope body's height as a share of the card's (1.15 / 1.4 on the portrait 5:7 card). */
export const ENVELOPE_HEIGHT_SHARE = 1.15 / 1.4;

export interface HolidayCardObjectLayout {
  outer: { width: number; height: number };
  card: { left: number; top: number; width: number; height: number };
  envelope: { left: number; top: number; width: number; height: number };
}

/**
 * The card (any aspect) with a kraft envelope peeking out behind it at the top
 * right. On the portrait 5:7 card this is exactly the old object (outer
 * 1.27 x 1.54 of the card width); landscape cards peek by their shorter side.
 */
export function holidayCardObjectLayout(cardWidth: number, cardHeight: number): HolidayCardObjectLayout {
  const unit = Math.min(cardWidth, cardHeight);
  const peekRight = Math.round(unit * ENVELOPE_PEEK_RIGHT);
  const peekTop = Math.round(unit * ENVELOPE_PEEK_TOP);
  return {
    outer: { width: cardWidth + peekRight, height: cardHeight + peekTop },
    card: { left: 0, top: peekTop, width: cardWidth, height: cardHeight },
    envelope: {
      left: peekRight,
      top: 0,
      width: cardWidth,
      height: Math.round(cardHeight * ENVELOPE_HEIGHT_SHARE),
    },
  };
}

/**
 * The widest card (whole numbers) whose card + envelope object fits in
 * `maxWidth` x `maxHeight`, for an orientation.
 */
export function holidayCardWidthToFit(
  orientation: KeepsakesCardOrientation,
  maxWidth: number,
  maxHeight: number,
): number {
  const aspect = cardAspectRatio(orientation);
  const unitShare = Math.min(1, aspect);
  const fromHeight = maxHeight / (aspect + ENVELOPE_PEEK_TOP * unitShare);
  const fromWidth = maxWidth / (1 + ENVELOPE_PEEK_RIGHT * unitShare);
  // The estimate ignores whole-px rounding of the card height and peeks: start
  // a little above it and step down to the widest width that really fits.
  let width = Math.floor(Math.min(fromHeight, fromWidth)) + 2;
  while (width > 1) {
    const { outer } = holidayCardObjectLayout(width, Math.round(width * aspect));
    if (outer.width <= maxWidth && outer.height <= maxHeight) break;
    width -= 1;
  }
  return width;
}
