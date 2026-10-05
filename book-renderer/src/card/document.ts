import { colors, lavender } from '../theme';
import { needsReposition } from '../web/overlay/repositionGate';
import {
  CARD,
  cardGeometry,
  coverCrop,
  fitBoxToImage,
  orientationFromImage,
  ptToMm,
  round,
  safeViolations,
  trimToPage,
  type CardGeometry,
  type Rect,
  type SafeViolation,
} from './geometry';
import { fitLetter, wrapBalanced, type FontSpec, type LetterFit, type MeasureFn } from './textFit';
import type { CardImage, CardLayout, CardOrientation, GreetingPosition } from './types';

/**
 * The fitted card document: everything the presentational components need,
 * computed once from plain inputs (pure, no DOM; the browser passes a canvas
 * `MeasureFn`). The P2 web editor reuses `buildCardDocument` as is.
 */

// ── Style constants (one place to tune the design) ───────────────────────

export const CARD_STYLE = {
  /** Warm paper tint of the bordered/illustrated fronts (the back is bare white stock). */
  paper: '#FAF8FC',
  backPaper: '#FFFFFF',
  /** The one accent: the book's lavender. */
  accent: lavender.deep,
  accentInk: lavender.ink,
  ink: colors.ink2,
  inkSoft: colors.ink3,
  hairline: lavender.mid,
  /** The Momora wordmark's dot (src/components/wordmark.tsx: the app's primary). */
  wordmarkDot: colors.primary,
  fonts: {
    heading: { family: 'Newsreader', weight: 400, style: 'italic' } as FontSpec,
    letter: { family: 'Newsreader', weight: 400, style: 'normal' } as FontSpec,
    signature: { family: 'Caveat', weight: 600, style: 'normal' } as FontSpec,
    caption: { family: 'Plus Jakarta Sans', weight: 500, style: 'normal' } as FontSpec,
    frontGreeting: { family: 'Newsreader', weight: 400, style: 'italic' } as FontSpec,
    subline: { family: 'Plus Jakarta Sans', weight: 600, style: 'normal' } as FontSpec,
    /** The app's wordmark face: Newsreader Medium. */
    wordmark: { family: 'Newsreader', weight: 500, style: 'normal' } as FontSpec,
  },
  letter: { minPt: 9, maxPt: 12, lineHeight: 1.45, paragraphGap: 0.55 },
  /** Below this the photo is too soft for 5x7 print. */
  minDpi: 200,
  qrMm: 26,
  wordmarkPt: 8,
  /** Wordmark letter-spacing, em (src/components/wordmark.tsx: size * -0.025). */
  wordmarkSpacingEm: -0.025,
  sublineSpacingEm: 0.32,
} as const;

// ── Input / output shapes ────────────────────────────────────────────────

export interface CardPortraitInput {
  url: string;
  name: string;
  width: number;
  height: number;
}

export interface CardInput {
  /** `null` = follow the front picture. */
  orientation: CardOrientation | null;
  frontLayout: CardLayout;
  frontImage: CardImage;
  /** The id of the chosen front picture (focal points and the picker are keyed by it). */
  imageId: string;
  greetingPosition: GreetingPosition;
  greeting: string;
  /** The small line under (or beside) the greeting: the year by default; empty hides it. */
  subline: string;
  /** The back heading. */
  backHeading: string;
  letter: string;
  /** The sign-off; empty hides it. */
  signature: string;
  qr: { url: string } | null;
  /** The text next to the QR; empty/null hides it. */
  qrCaption: string | null;
  /** The family's illustrated portraits by the signature (empty = none). */
  portraits: CardPortraitInput[];
}

export type RegionTarget = 'front.greeting' | 'front.subline' | 'back.heading' | 'letter' | 'back.signature' | 'back.qrCaption';

/** A clickable text field on the card (page coordinates, mm). */
export interface TextRegion {
  target: RegionTarget;
  side: 'front' | 'back';
  label: string;
  rect: Rect;
  multiline: boolean;
  /** Required fields cannot be saved empty. */
  required: boolean;
}

export interface FrontDoc {
  layout: CardLayout;
  /** Page background (also fills the bleed). */
  paper: string;
  image: {
    id: string;
    url: string;
    /** The visible window of the picture, page coordinates. */
    clip: Rect;
    /** Where the whole picture is drawn, page coordinates. */
    draw: Rect;
    radiusMm: number;
    dpi: number;
    cropX: number;
    cropY: number;
    widthPx: number;
    heightPx: number;
    /** Worth offering "Reposition" (the crop is more than a sliver; mirrors the book's gate). */
    canReposition: boolean;
    /** The aspect of the visible window (the reposition modal's crop box). */
    boxAspect: number;
  };
  scrim: { edge: 'top' | 'bottom'; heightMm: number } | null;
  greeting: {
    text: string;
    subline: string;
    mode: 'stacked' | 'inline';
    /** The whole block. */
    rect: Rect;
    greetingRect: Rect;
    /** Null when there is no subline. */
    sublineRect: Rect | null;
    align: 'left' | 'center' | 'right';
    tone: 'light' | 'dark';
    fontPt: number;
    sublinePt: number;
    greetingH: number;
    sublineH: number;
    gapMm: number;
  };
}

export interface BackDoc {
  paper: string;
  hasQr: boolean;
  heading: { text: string; rect: Rect; fontPt: number };
  rule: Rect;
  letter: { rect: Rect; fit: LetterFit };
  /** Null when the sign-off is empty. */
  signature: { rect: Rect; fontPt: number; lines: string[]; lineHeightMm: number } | null;
  /** Round portraits by the signature (empty = none). */
  portraits: { rect: Rect; url: string; name: string }[];
  qr: { rect: Rect; url: string } | null;
  caption: { rect: Rect; fontPt: number; lines: string[]; lineHeightMm: number; align: 'center' | 'left' } | null;
  divider: Rect | null;
  /** A hairline above the QR block (portrait). */
  blockRule: Rect | null;
  /** The Momora wordmark, bottom right. */
  wordmark: { rect: Rect; fontPt: number };
}

export interface CardDocument {
  geometry: CardGeometry;
  front: FrontDoc;
  back: BackDoc;
  regions: TextRegion[];
  warnings: string[];
  safeViolations: SafeViolation[];
  /** Named boxes (page coordinates) the safe-area check runs on. */
  elements: { name: string; rect: Rect }[];
}

// ── Front ────────────────────────────────────────────────────────────────

const FRONT_MARGIN_MM = 12;
/** Bordered / illustrated: the picture sits this far from the trim on top and sides... */
const BAND_MARGIN_MM = 8;
/** ...and the greeting band below it is this tall (the text's bottom edge stays 8.5 mm from the trim). */
const BAND_H_MM = 21;
const BAND_TEXT_BOTTOM_MM = 8.5;

function sublineWidth(measure: MeasureFn, text: string, pt: number): number {
  return measure(text, CARD_STYLE.fonts.subline, pt) + text.length * ptToMm(pt) * CARD_STYLE.sublineSpacingEm;
}

function buildFront(g: CardGeometry, input: CardInput, measure: MeasureFn): FrontDoc {
  const img = input.frontImage;
  const portrait = g.orientation === 'portrait';
  const hasSubline = input.subline.trim() !== '';
  const sublinePt = 7;
  const gp = input.greetingPosition;
  const common = { layout: input.frontLayout };
  const imageBase = { id: input.imageId, url: img.url, widthPx: img.width, heightPx: img.height };

  if (input.frontLayout === 'full-bleed') {
    const fontPt = portrait ? 24 : 27;
    const crop = coverCrop(img.width, img.height, g.pageW, g.pageH, img.focal);
    const wG = round(measure(input.greeting, CARD_STYLE.fonts.frontGreeting, fontPt));
    const wS = hasSubline ? round(sublineWidth(measure, input.subline, sublinePt)) : 0;
    const gH = round(ptToMm(fontPt) * 1.15);
    const sH = hasSubline ? round(ptToMm(sublinePt) * 1.2) : 0;
    const gap = hasSubline ? 2 : 0;
    const blockW = Math.max(wG, wS);
    const blockH = round(gH + gap + sH);
    const top = gp.startsWith('top');
    const align = gp.endsWith('left') ? 'left' : gp.endsWith('right') ? 'right' : 'center';
    const trim = g.trim;
    const xFor = (w: number) =>
      align === 'left' ? trim.x + FRONT_MARGIN_MM : align === 'right' ? trim.x + trim.w - FRONT_MARGIN_MM - w : trim.x + (trim.w - w) / 2;
    const y = top ? trim.y + FRONT_MARGIN_MM : trim.y + trim.h - FRONT_MARGIN_MM - blockH;
    const greetingRect = { x: round(xFor(wG)), y: round(y), w: wG, h: gH };
    const sublineRect = hasSubline ? { x: round(xFor(wS)), y: round(y + gH + gap), w: wS, h: sH } : null;
    const aspect = g.pageW / g.pageH;
    return {
      ...common,
      paper: '#000000',
      image: {
        ...imageBase,
        clip: { x: 0, y: 0, w: g.pageW, h: g.pageH },
        draw: crop.draw,
        radiusMm: 0,
        dpi: crop.dpi,
        cropX: crop.cropX,
        cropY: crop.cropY,
        canReposition: needsReposition(img.width / img.height, aspect),
        boxAspect: round(aspect),
      },
      scrim: { edge: top ? 'top' : 'bottom', heightMm: round(g.pageH * 0.42) },
      greeting: {
        text: input.greeting,
        subline: input.subline,
        mode: 'stacked',
        rect: { x: round(xFor(blockW)), y: round(y), w: blockW, h: blockH },
        greetingRect,
        sublineRect,
        align,
        tone: 'light',
        fontPt,
        sublinePt,
        greetingH: gH,
        sublineH: sH,
        gapMm: gap,
      },
    };
  }

  // Bordered photo / illustrated art: a picture on paper, the greeting on one line in the band below.
  const bordered = input.frontLayout === 'bordered';
  const area = trimToPage(g, { x: BAND_MARGIN_MM, y: BAND_MARGIN_MM, w: g.trimW - 2 * BAND_MARGIN_MM, h: g.trimH - BAND_MARGIN_MM - BAND_H_MM });
  const box = fitBoxToImage(area, img.width / img.height, bordered ? 0.15 : 0);
  const crop = coverCrop(img.width, img.height, box.w, box.h, img.focal);
  const fontPt = portrait ? 21 : 20;
  const wG = round(measure(input.greeting, CARD_STYLE.fonts.frontGreeting, fontPt));
  const wS = hasSubline ? round(sublineWidth(measure, input.subline, sublinePt)) : 0;
  const gapX = hasSubline ? 4 : 0;
  const gH = round(ptToMm(fontPt) * 1.15);
  const sH = hasSubline ? round(ptToMm(sublinePt) * 1.2) : 0;
  const rowW = round(wG + gapX + wS);
  const rowX = g.trim.x + (g.trimW - rowW) / 2;
  const rowY = g.trim.y + g.trim.h - BAND_TEXT_BOTTOM_MM - gH;
  const aspect = box.w / box.h;
  return {
    ...common,
    paper: CARD_STYLE.paper,
    image: {
      ...imageBase,
      clip: box,
      draw: { x: round(box.x + crop.draw.x), y: round(box.y + crop.draw.y), w: crop.draw.w, h: crop.draw.h },
      radiusMm: bordered ? 0 : 1.2,
      dpi: crop.dpi,
      cropX: crop.cropX,
      cropY: crop.cropY,
      canReposition: needsReposition(img.width / img.height, aspect),
      boxAspect: round(aspect),
    },
    scrim: null,
    greeting: {
      text: input.greeting,
      subline: input.subline,
      mode: 'inline',
      rect: { x: round(rowX), y: round(rowY), w: rowW, h: gH },
      greetingRect: { x: round(rowX), y: round(rowY), w: wG, h: gH },
      sublineRect: hasSubline ? { x: round(rowX + wG + gapX), y: round(rowY + gH - sH - 1), w: wS, h: sH } : null,
      align: 'center',
      tone: 'dark',
      fontPt,
      sublinePt,
      greetingH: gH,
      sublineH: sH,
      gapMm: gapX,
    },
  };
}

/** The sign-off on one line if it fits, else broken after its first comma ("Con cariño," / "la familia …"), else balanced. */
export function wrapSignature(text: string, font: FontSpec, pt: number, maxW: number, measure: MeasureFn): string[] {
  if (measure(text, font, pt) <= maxW) return [text];
  const comma = text.indexOf(',');
  if (comma > 0 && comma < text.length - 1) {
    const parts = [text.slice(0, comma + 1).trim(), text.slice(comma + 1).trim()];
    if (parts.every((t) => measure(t, font, pt) <= maxW)) return parts;
  }
  return wrapBalanced(text, font, pt, maxW, measure);
}

// ── Back ─────────────────────────────────────────────────────────────────

const BACK_MARGIN_MM = 14;
const FOOTER_BOTTOM_MM = 10; // the wordmark's bottom edge, from the trim

function buildBack(g: CardGeometry, input: CardInput, measure: MeasureFn, warnings: string[]): BackDoc {
  const portrait = g.orientation === 'portrait';
  const M = BACK_MARGIN_MM;
  const hasQr = input.qr !== null;
  const fonts = CARD_STYLE.fonts;

  // The Momora wordmark: small, muted, bottom right, inside the safe area.
  const wmPt = CARD_STYLE.wordmarkPt;
  const wmH = 3.4;
  const wmW = round(measure('Momora.', fonts.wordmark, wmPt) + 'Momora.'.length * ptToMm(wmPt) * CARD_STYLE.wordmarkSpacingEm);
  const wordmarkRect = trimToPage(g, { x: g.trimW - M - wmW, y: g.trimH - FOOTER_BOTTOM_MM - wmH, w: wmW, h: wmH });

  // Content area (trim coordinates): above the wordmark.
  const contentTop = M;
  const contentBottom = g.trimH - FOOTER_BOTTOM_MM - wmH - 4;
  const contentH = contentBottom - contentTop;

  let stack: Rect; // trim coords
  let qrRect: Rect | null = null;
  let captionRect: Rect | null = null;
  let captionLines: string[] = [];
  const capPt = 7;
  const capLineH = round(ptToMm(capPt) * 1.35);
  const caption = hasQr && input.qrCaption && input.qrCaption.trim() !== '' ? input.qrCaption.trim() : null;
  let divider: Rect | null = null;
  let blockRule: Rect | null = null;

  const qrMm = CARD_STYLE.qrMm;
  if (!hasQr) {
    const w = portrait ? g.trimW - 2 * M : 120;
    stack = { x: (g.trimW - w) / 2, y: contentTop, w, h: contentH };
  } else if (!portrait) {
    const colW = 36;
    const gutter = 11;
    const colX = g.trimW - M - colW;
    const textW = colX - gutter - M;
    stack = { x: M, y: contentTop, w: textW, h: contentH };
    captionLines = caption ? wrapBalanced(caption, fonts.caption, capPt, colW, measure) : [];
    const capH = captionLines.length * capLineH;
    const blockH = qrMm + (capH ? 3.5 + capH : 0);
    const blockY = contentTop + (contentH - blockH) / 2;
    qrRect = { x: colX + (colW - qrMm) / 2, y: blockY, w: qrMm, h: qrMm };
    if (capH) captionRect = { x: colX, y: blockY + qrMm + 3.5, w: colW, h: capH };
    const dividerH = round(contentH * 0.62);
    divider = { x: colX - gutter / 2, y: contentTop + (contentH - dividerH) / 2, w: 0.25, h: dividerH };
  } else {
    // Portrait: the QR block sits at the bottom, caption to its right.
    const capW = g.trimW - 2 * M - qrMm - 6;
    captionLines = caption ? wrapBalanced(caption, fonts.caption, capPt, capW, measure) : [];
    const capH = captionLines.length * capLineH;
    const blockH = Math.max(qrMm, capH);
    const blockY = contentBottom - blockH;
    qrRect = { x: M, y: blockY + (blockH - qrMm) / 2, w: qrMm, h: qrMm };
    if (capH) captionRect = { x: M + qrMm + 6, y: blockY + (blockH - capH) / 2, w: capW, h: capH };
    blockRule = { x: M, y: blockY - 7, w: g.trimW - 2 * M, h: 0.25 };
    stack = { x: M, y: contentTop, w: g.trimW - 2 * M, h: blockY - 7 - 6 - contentTop };
  }

  // The text stack: heading, rule, letter, then the sign-off row (signature + portraits).
  const headingPt = portrait ? 19 : 21;
  const headingH = round(ptToMm(headingPt) * 1.2);
  const ruleGap = 3.2;
  const afterRule = 4.5;
  const sigPt = 17;
  const sigLineH = round(ptToMm(sigPt) * 1.05);
  const sig = input.signature.trim();
  const portraitD = portrait ? 13 : 12;
  const portraitStep = portraitD + 1.5;
  const portraits = input.portraits.slice(0, 6);
  const rowPortraitsW = portraits.length ? portraits.length * portraitStep - 1.5 : 0;

  // Signature next to the portraits when it fits in two lines, else the portraits sit above it.
  let sigLines: string[] = [];
  let sideBySide = false;
  if (sig) {
    if (rowPortraitsW > 0) {
      const narrow = wrapSignature(sig, fonts.signature, sigPt, stack.w - rowPortraitsW - 6, measure);
      if (narrow.length <= 2) {
        sigLines = narrow;
        sideBySide = true;
      }
    }
    if (!sideBySide) sigLines = wrapSignature(sig, fonts.signature, sigPt, stack.w, measure);
  }
  const sigH = round(sigLines.length * sigLineH);
  const hasRow = sig !== '' || rowPortraitsW > 0;
  const rowH = !hasRow ? 0 : sideBySide ? Math.max(sigH, portraitD) : sigH + (rowPortraitsW > 0 ? portraitD + 3 : 0);
  const gapRow = hasRow ? 5.5 : 0;
  const fixed = headingH + ruleGap + 0.3 + afterRule + gapRow + rowH;
  const fit = fitLetter({
    text: input.letter,
    font: fonts.letter,
    widthMm: stack.w,
    heightMm: stack.h - fixed,
    minPt: CARD_STYLE.letter.minPt,
    maxPt: CARD_STYLE.letter.maxPt,
    lineHeight: CARD_STYLE.letter.lineHeight,
    paragraphGap: CARD_STYLE.letter.paragraphGap,
    measure,
  });
  if (!fit.fits) warnings.push(`letter does not fit at the ${CARD_STYLE.letter.minPt} pt minimum (needs ${round(fit.heightMm)} mm, has ${round(stack.h - fixed)} mm)`);

  const stackH = fixed + fit.heightMm;
  const top = stack.y + Math.max(0, (stack.h - stackH) / 2);
  const headingRect = trimToPage(g, { x: stack.x, y: top, w: stack.w, h: headingH });
  const ruleRect = trimToPage(g, { x: stack.x, y: top + headingH + ruleGap, w: 9, h: 0.3 });
  const letterTop = top + headingH + ruleGap + 0.3 + afterRule;
  const letterRect = trimToPage(g, { x: stack.x, y: letterTop, w: stack.w, h: fit.heightMm });
  const rowTop = letterTop + fit.heightMm + gapRow;

  // Signature and portraits rects.
  let signature: BackDoc['signature'] = null;
  const portraitRects: BackDoc['portraits'] = [];
  if (sig) {
    const sigY = sideBySide ? rowTop + (rowH - sigH) / 2 : rowTop + (rowPortraitsW > 0 ? portraitD + 3 : 0);
    const sigW = sideBySide ? stack.w - rowPortraitsW - 6 : stack.w;
    signature = { rect: trimToPage(g, { x: stack.x, y: sigY, w: sigW, h: sigH }), fontPt: sigPt, lines: sigLines, lineHeightMm: sigLineH };
  }
  if (rowPortraitsW > 0) {
    const startX = sideBySide ? stack.x + stack.w - rowPortraitsW : stack.x;
    const y = sideBySide ? rowTop + (rowH - portraitD) / 2 : rowTop;
    portraits.forEach((p, i) => {
      portraitRects.push({ rect: trimToPage(g, { x: startX + i * portraitStep, y, w: portraitD, h: portraitD }), url: p.url, name: p.name });
    });
  }

  return {
    paper: CARD_STYLE.backPaper,
    hasQr,
    heading: { text: input.backHeading, rect: headingRect, fontPt: headingPt },
    rule: ruleRect,
    letter: { rect: letterRect, fit },
    signature,
    portraits: portraitRects,
    qr: qrRect && input.qr ? { rect: trimToPage(g, qrRect), url: input.qr.url } : null,
    caption: captionRect && captionLines.length
      ? { rect: trimToPage(g, captionRect), fontPt: capPt, lines: captionLines, lineHeightMm: capLineH, align: portrait ? ('left' as const) : ('center' as const) }
      : null,
    divider: divider ? trimToPage(g, divider) : null,
    blockRule: blockRule ? trimToPage(g, blockRule) : null,
    wordmark: { rect: wordmarkRect, fontPt: wmPt },
  };
}

// ── The document ─────────────────────────────────────────────────────────

export function buildCardDocument(input: CardInput, measure: MeasureFn): CardDocument {
  const orientation = input.orientation ?? orientationFromImage(input.frontImage.width, input.frontImage.height);
  const geometry = cardGeometry(orientation);
  const warnings: string[] = [];
  const front = buildFront(geometry, input, measure);
  const back = buildBack(geometry, input, measure, warnings);

  if (front.image.dpi < CARD_STYLE.minDpi) warnings.push(`front picture is ${front.image.dpi} dpi at the placed size (min ${CARD_STYLE.minDpi})`);
  if (Math.max(front.image.cropX, front.image.cropY) > 0.3) {
    warnings.push(`front picture is cropped by ${Math.round(Math.max(front.image.cropX, front.image.cropY) * 100)}%: check faces (set a focal point)`);
  }

  const elements: { name: string; rect: Rect }[] = [
    { name: 'front greeting', rect: front.greeting.rect },
    { name: 'back heading', rect: back.heading.rect },
    { name: 'letter', rect: back.letter.rect },
    { name: 'wordmark', rect: back.wordmark.rect },
  ];
  if (back.signature) elements.push({ name: 'signature', rect: back.signature.rect });
  for (const [i, p] of back.portraits.entries()) elements.push({ name: `portrait ${i + 1}`, rect: p.rect });
  if (back.qr) elements.push({ name: 'qr', rect: back.qr.rect });
  if (back.caption) elements.push({ name: 'qr caption', rect: back.caption.rect });

  const violations = safeViolations(geometry, elements, CARD.safeMm);
  // The picture of a bordered/illustrated front only needs the hard 4 mm.
  if (front.layout !== 'full-bleed') violations.push(...safeViolations(geometry, [{ name: 'front picture', rect: front.image.clip }], CARD.safeMinMm));

  const regions: TextRegion[] = [
    { target: 'front.greeting', side: 'front', label: 'Greeting', rect: front.greeting.greetingRect, multiline: false, required: true },
    ...(front.greeting.sublineRect ? [{ target: 'front.subline' as const, side: 'front' as const, label: 'Year', rect: front.greeting.sublineRect, multiline: false, required: false }] : []),
    { target: 'back.heading', side: 'back', label: 'Heading', rect: back.heading.rect, multiline: false, required: true },
    { target: 'letter', side: 'back', label: 'Letter', rect: back.letter.rect, multiline: true, required: true },
    { target: 'back.signature', side: 'back', label: 'Sign-off', rect: back.signature ? back.signature.rect : { x: back.letter.rect.x, y: back.letter.rect.y + back.letter.rect.h + 4, w: back.letter.rect.w, h: 8 }, multiline: false, required: false },
    ...(back.caption ? [{ target: 'back.qrCaption' as const, side: 'back' as const, label: 'Caption next to the QR code', rect: back.caption.rect, multiline: true, required: false }] : []),
  ];
  // A heading rect spans the whole column; shrink its hotspot to the text.
  const headingRegion = regions.find((r) => r.target === 'back.heading');
  if (headingRegion) {
    const w = Math.min(headingRegion.rect.w, round(measure(input.backHeading, CARD_STYLE.fonts.heading, back.heading.fontPt)));
    headingRegion.rect = { ...headingRegion.rect, w: Math.max(w, 14) };
  }

  return { geometry, front, back, regions, warnings, safeViolations: violations, elements };
}

/** Plain numbers for reports (no text content). */
export function cardStats(doc: CardDocument) {
  const { front, back, geometry } = doc;
  const area = front.image.clip.w * front.image.clip.h;
  return {
    pageMm: [geometry.pageW, geometry.pageH],
    trimMm: [geometry.trimW, geometry.trimH],
    orientation: geometry.orientation,
    frontLayout: front.layout,
    frontDpi: front.image.dpi,
    frontCrop: [front.image.cropX, front.image.cropY],
    frontPixels: [front.image.widthPx, front.image.heightPx],
    placedMm: [front.image.draw.w, front.image.draw.h],
    /** Share of the TRIM area the visible picture covers (full-bleed is > 1 because it runs into the bleed). */
    pictureShareOfTrim: round(Math.min(1, area / (geometry.trimW * geometry.trimH))),
    letterPt: back.letter.fit.fontPt,
    letterLines: back.letter.fit.lineCount,
    letterFits: back.letter.fit.fits,
    letterCappedByMax: back.letter.fit.cappedByMax,
    qrMm: back.qr ? back.qr.rect.w : null,
    portraitMm: back.portraits.length ? back.portraits[0].rect.w : null,
    portraitCount: back.portraits.length,
    warnings: doc.warnings,
    safeViolations: doc.safeViolations,
  };
}
