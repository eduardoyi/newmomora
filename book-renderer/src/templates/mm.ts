import { PHYSICAL } from '../model/types';

/** Full-bleed single page: 210mm trim + 3mm bleed on all four sides = 216mm square. */
export const FULL_PAGE_MM = PHYSICAL.pageSizeMm + PHYSICAL.bleedMm * 2;
/** Spread = two facing pages, bleed only on the two outer edges (none at the gutter). */
export const SPREAD_WIDTH_MM = PHYSICAL.pageSizeMm * 2 + PHYSICAL.bleedMm * 2;
export const SPREAD_HEIGHT_MM = FULL_PAGE_MM;
/** Safe margin is measured from the trim edge, so from the full-bleed edge it's bleed + margin. */
export const SAFE_INSET_MM = PHYSICAL.bleedMm + PHYSICAL.safeMarginMm;
/** Inline mini scan-mark target size (Momora Book Layout System: 13mm, credit-line placement). */
export const QR_SIZE_MM = 13;
/** Audio-note scan mark: the mark IS the page image, composed at 26mm. */
export const AUDIO_MARK_SIZE_MM = 26;
/** Print-polish round (owner decision 2026-09-14, item D1): the dedication page's sample scan mark — a decorative, non-functional-content size the owner-approved mock specified as "~9-10mm". */
// 8mm (owner-tuned 2026-09-15 alongside the -30% instruction text size —
// the 9mm mark read too large next to the smaller line; 7mm-at-28%-badge
// scanned fine on the owner's home-printer test sheet, so 8mm keeps margin).
export const DEDICATION_SAMPLE_MARK_SIZE_MM = 8;
/** Safe content box side (210 - 2*10mm margin) — matches the system's documented "caja 190x190mm". */
export const SAFE_BOX_MM = PHYSICAL.pageSizeMm - PHYSICAL.safeMarginMm * 2;
/** Safe content box in baseline units (190mm / 5mm = 38 lines/page, per the system board). */
export const SAFE_BOX_BASELINES = SAFE_BOX_MM / PHYSICAL.baselineMm;

// ---------------------------------------------------------------------------
// Printable caption sanitization (Task 2, round-17) — a parent can paste a
// URL into a memory's caption; the app renders it as a link CARD in-product,
// but a PRINTED book must never show a raw URL. `printableCaption` is the
// ONE shared, pure function every caption-LENGTH decision (the illustrated
// split threshold, digest/quote eligibility, caption-height estimates),
// every TEMPLATE render (IllustratedStory, IllustratedDigest,
// QuoteCollection, the footer index, TextPage), and the audit's own
// caption-height recomputation all route through — so none of them can
// ever measure or display a different string than what actually prints.
// A caption that sanitizes down to an empty string is caption-less, exactly
// like a memory with no text at all (photo-only path; isDigestEligible/text
// checks see empty).
// ---------------------------------------------------------------------------

/** A whitespace-delimited token that contains (not just starts with, so a leading paren/quote doesn't hide it) an http(s):// or www. URL. */
const URL_TOKEN_PATTERN = /(https?:\/\/|www\.)/i;

/**
 * A short connective word that reads as orphaned when a URL right next to
 * it, at the very EDGE of the caption, gets removed (e.g. "...video de
 * https://x.com" -> "...video de" once the URL — the LAST token — is gone)
 * — trimmed as part of the SAME conservative cleanup, and ONLY at the edge
 * a removed URL actually sat at, never elsewhere in the sentence (a URL in
 * the MIDDLE of a caption never touches its neighbors' words, only itself
 * — "Visit www.x.com for more" stays "Visit for more", not "Visit more":
 * "for" is real content here, not a dangling leftover, because the URL
 * wasn't the first or last token). English + Spanish (Momora families
 * write in both), kept deliberately short: only bare prepositions/
 * articles/conjunctions a URL would plausibly have been introducing or
 * following, nothing that could ever be a meaningful word on its own.
 */
const DANGLING_CONNECTIVES: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'at', 'in', 'on', 'to', 'of', 'for', 'from', 'via', 'and',
  'de', 'del', 'al', 'en', 'con', 'por', 'para', 'y', 'el', 'la', 'los', 'las', 'un', 'una',
]);

/** A word stripped of any punctuation wrapping it (for matching against `DANGLING_CONNECTIVES`), lowercased. */
function bareWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

/** Trims one dangling leading/trailing punctuation mark (a colon, dash, or comma left introducing/following a now-removed URL) at the very edges of the whole caption. */
function trimDanglingPunctuation(s: string): string {
  return s.replace(/^[,:;\-–—]+\s*/, '').replace(/\s*[,:;\-–—]+$/, '');
}

export function printableCaption(text: string): string {
  if (!text) return '';
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const isUrl = (w: string) => URL_TOKEN_PATTERN.test(w);
  if (!words.some(isUrl)) return text; // no URL token found — untouched, verbatim (never reworded)

  const remove = new Set<number>();
  words.forEach((w, i) => {
    if (isUrl(w)) remove.add(i);
  });
  // Trim ONE dangling connective word, but ONLY at whichever edge of the
  // WHOLE caption a removed URL actually sat at — a URL that was the very
  // LAST token can leave its preceding word orphaned; one that was the
  // very FIRST can leave its following word orphaned. A URL in the middle
  // never touches its neighbors: they still have real content on their
  // other side. Never recursive, never anywhere else in the sentence.
  for (const i of Array.from(remove)) {
    if (i === words.length - 1) {
      const prev = i - 1;
      if (prev >= 0 && !remove.has(prev) && !isUrl(words[prev]) && DANGLING_CONNECTIVES.has(bareWord(words[prev]))) {
        remove.add(prev);
      }
    }
    if (i === 0) {
      const next = i + 1;
      if (next < words.length && !remove.has(next) && !isUrl(words[next]) && DANGLING_CONNECTIVES.has(bareWord(words[next]))) {
        remove.add(next);
      }
    }
  }

  const kept = words.filter((_, i) => !remove.has(i));
  const out = trimDanglingPunctuation(kept.join(' ')).trim();
  return out;
}

/**
 * Vertical space a section header (kicker + title) reserves at the top of
 * whichever page renders it — shared by anchor-media/flex-grid,
 * illustrated-story, and audio-note so a month-opener's header height is
 * consistent everywhere it can appear. Round-4 item 2 tuning: the previous
 * per-template value (75mm in AnchorMedia) over-reserved relative to what a
 * kicker + title actually renders at, leaving a page's image looking boxed
 * into a "thumbnail" instead of the generously-filled composition a
 * month-opener should read as. Named constant — the owner may retune.
 *
 * Round-8 item 3 re-measurement (from `SectionHeader.tsx`'s own typography,
 * worst case = kicker present + a SPECIAL (birth-month) title wrapped to
 * its full 2 lines):
 *   - kicker row: 6.5pt at the browser default 'normal' line-height (~1.2)
 *     = 7.8pt (~2.75mm), plus its own 0.9em margin-bottom (0.9 * the
 *     16px/12pt default root size assumed for `em` here, since the kicker
 *     row itself sets no font-size of its own — ~3.8mm) ≈ 6.6mm.
 *   - title: up to 2 lines at up to 44pt (special) with the component's own
 *     explicit `lineHeight: 1.02` = 44 * 1.02 * 2 = 89.76pt (~31.7mm); an
 *     ordinary (non-special) 34pt title only needs ~24.5mm.
 *   - worst case totals ~38.2mm (6.6 + 31.7) — measured analytically from
 *     the component's own values (`ptCqw`'s `MM_PER_PT` conversion), not a
 *     live DOM render, so it carries a real margin for font-metric
 *     variance (Newsreader's actual glyph ascent/descent vs. the CSS
 *     line-height box) and wrap edge cases. 45mm was measurably more than
 *     needed even for the special-title worst case; lowered to 40mm
 *     (~2mm of headroom over the 38.2mm worst case) rather than shaving it
 *     all the way down, given the estimate is analytical, not rendered.
 */
export const SECTION_HEADER_RESERVE_MM = 40;

/**
 * Footer-index reserve, shared by anchor-media and flex-grid (previously
 * duplicated as a local constant in each template — round-5 integrity audit
 * needs the SAME value to recompute a page's own geometry, so this is now
 * the one source of truth both templates AND the audit import from).
 *
 * Owner round-10 ("do we have too much reserved space above the footer?"):
 * measured against every rendered page in both real books, the footer-index
 * block's worst case is 7.9mm tall — the old 22mm reserve left a ~14mm band
 * of dead white between every image bottom and the footer rule. 15mm =
 * a modeled 3-line footer worst case (~13mm: rule + padding + three 8pt
 * lines — current books max out at 2 lines, but a future entry-heavy page
 * could wrap one more) + breathing room, reclaiming 7mm of image height on
 * every footered page while keeping a deliberate ~7mm of air above the
 * rule. If footers ever grow past 3 lines, model footer height from entry
 * text lengths (the caption-estimator pattern above) instead of raising
 * this back.
 */
export const FOOTER_RESERVE_MM = 15;

/**
 * Owner round-10 follow-up: the 15mm reserve above assumes the only thing
 * between an image's bottom edge and the footer block is white space. A
 * VIDEO tile rendering its scan-to-watch strip BELOW the image (every
 * pair/grid video, and a solo video with no side room) needs the strip's
 * own ~13mm accommodated too, or the QR lands on the footer rule (owner
 * screenshot). +9mm: the old 22mm total turned out to be EXACTLY tangent
 * (strip bottom 195.6 vs footer top 195.1, measured) — 24mm gives the
 * strip a real ~1.5mm clearance instead of a coincidental graze. Use `footerReserveMm` wherever a page MIGHT hold a
 * below-scan video so templates, fitter, and audit stay in lockstep.
 */
export const VIDEO_BELOW_SCAN_FOOTER_EXTRA_MM = 9;

export function footerReserveMm(hasBelowScanVideo: boolean): number {
  return FOOTER_RESERVE_MM + (hasBelowScanVideo ? VIDEO_BELOW_SCAN_FOOTER_EXTRA_MM : 0);
}

/**
 * Round-5 amendment ("minimum image size" — owner screenshots showed pair
 * subordinates at ~25-35mm): the canvas already mandates a grid hole never
 * go below 40mm on its short side; this generalizes that into ONE shared
 * floor applied to EVERY photo slot in every composition (anchor-media
 * pairs, flex-grid holes, text-page photo companions) — not just grids —
 * and raises it slightly to 45mm. When a composition can't give every
 * photo at least this much with a clear hierarchy still intact, the fitter
 * splits it onto separate pages rather than shrinking below the floor (see
 * `anchorPairMeetsMinSize` in `layout/anchorMediaLayout.ts` and its call
 * sites in fitter.ts) — this constant is never used to silently clamp a
 * render smaller than intended. Owner-tunable.
 */
export const MIN_IMAGE_SIDE_MM = 45;

/**
 * Round-7 item 3a (integrity audit "fill-ratio" check) / item 1b (the
 * fitter's own pair-vs-split decision): a 1-2 photo anchor-media page's
 * total photo area, as a fraction of the FULL safe area (`SAFE_BOX_MM²`,
 * regardless of any header/footer reserve already eating into it — a
 * header-reduced page is still held to the same bar), must clear this
 * floor. Diagnosed live case: two same-aspect (~1.33) photos paired under
 * a section header both individually cleared `MIN_IMAGE_SIDE_MM` and the
 * subordinate floor/relative rule, yet the PAIR still only covered ~22% of
 * the page — passing every per-image check while still reading as "small
 * images floating in white". `anchorPairMeetsMinSize` now folds this
 * check in directly (so the fitter's split-instead-of-shrink rule catches
 * it BEFORE render), and the audit re-checks it as a permanent regression
 * backstop on the same real data. Owner-tunable.
 */
export const MIN_PAIR_FILL_RATIO = 0.28;

// ---------------------------------------------------------------------------
// Illustrated-story sizing (owner review round 3 item 12, round 4 item 7,
// round 5 item 6) — pulled out of IllustratedStory.tsx into shared, pure
// constants/functions so the fitter's own 1-vs-2-page split decision (round
// 5 item 6: force the split when the single-page illustration would render
// below ~110mm) can compute the EXACT same width/height the template
// actually renders, rather than approximating it and risking drift.
// ---------------------------------------------------------------------------

/** A short caption (<=200 chars) gets a BIG illustration (~150-170mm), same target band as a solo photo. */
export const ILLUSTRATED_SHORT_CAPTION_MAX_CHARS = 200;
export const ILLUSTRATED_BIG_ILLO_WIDTH_MM = 160;
/** Default illustration width for a longer "both"-mode caption, which needs more of the page for its own text. */
export const ILLUSTRATED_DEFAULT_ILLO_WIDTH_CANVAS_PX = 400;
/**
 * Round-4 item 7: a month-opener's header eats into the same vertical space
 * this template's text+illustration stack needs — the illustration shrinks
 * (never the type) so the composed page still reads as intentional. Applied
 * as a multiplier on whichever illustration width would otherwise be used.
 */
export const ILLUSTRATED_HEADER_ILLO_SHRINK = 0.72;

/** The illustration's own width in mm, at native page scale, for the "both" (single-page) mode — before any per-render aspect-ratio conversion to a height. */
export function illustratedIlloWidthMm(captionLen: number, hasSectionHeader: boolean): number {
  const isShort = captionLen > 0 && captionLen <= ILLUSTRATED_SHORT_CAPTION_MAX_CHARS;
  const baseWidthMm = isShort ? ILLUSTRATED_BIG_ILLO_WIDTH_MM : canvasPxToTrimMm(ILLUSTRATED_DEFAULT_ILLO_WIDTH_CANVAS_PX);
  return hasSectionHeader ? baseWidthMm * ILLUSTRATED_HEADER_ILLO_SHRINK : baseWidthMm;
}

/** The illustration's rendered HEIGHT in mm for the "both" (single-page) mode — what round-5 item 6's split threshold checks against ~110mm. */
export function illustratedIlloHeightMm(captionLen: number, hasSectionHeader: boolean, aspectRatio: number): number {
  return illustratedIlloWidthMm(captionLen, hasSectionHeader) / aspectRatio;
}

export function pageDims(isSpread: boolean): { widthMm: number; heightMm: number } {
  return isSpread
    ? { widthMm: SPREAD_WIDTH_MM, heightMm: SPREAD_HEIGHT_MM }
    : { widthMm: FULL_PAGE_MM, heightMm: FULL_PAGE_MM };
}

/** Convert an absolute mm measurement to a percentage of the page/spread width — for CSS sizing. */
export function mmToPctWidth(mm: number, isSpread: boolean): number {
  return (mm / pageDims(isSpread).widthMm) * 100;
}

export function mmToPctHeight(mm: number, isSpread: boolean): number {
  return (mm / pageDims(isSpread).heightMm) * 100;
}

export function getSafeInsetPct(isSpread: boolean): { x: number; y: number } {
  return { x: mmToPctWidth(SAFE_INSET_MM, isSpread), y: mmToPctHeight(SAFE_INSET_MM, isSpread) };
}

/** Whole-column width in mm for an N-column span (6 col / 27.5mm each, 5mm gutters). */
export function colSpanMm(nCols: number): number {
  return nCols * 27.5 + Math.max(0, nCols - 1) * PHYSICAL.gutterMm;
}

/** Snap a height (mm) to the 5mm baseline grid — every image height must land on a baseline. */
export function snapToBaseline(mm: number): number {
  const snapped = Math.round(mm / PHYSICAL.baselineMm) * PHYSICAL.baselineMm;
  return Math.max(PHYSICAL.baselineMm, snapped);
}

// ---------------------------------------------------------------------------
// Design-canvas coordinate conversion. The Claude Design handoff canvas
// ("Momora Book Layout System.dc.html") was built at 1mm = 4px, with each
// single-page mockup box measuring 840x840px = 210x210mm TRIM (the 3mm bleed
// overhang is not drawn — it's abstracted away for legibility). Converting a
// canvas px coordinate therefore means: divide by 4 to get "mm from the trim
// edge", then add the 3mm bleed offset to get "mm from the full-bleed edge",
// which is what our percentage system (0% = bleed edge) expects. Content the
// canvas draws edge-to-edge (`inset:0`) is genuine bleed content and should
// be positioned directly at 0%/100% instead of going through these helpers.
// ---------------------------------------------------------------------------

const CANVAS_PX_PER_MM = 4;
/** Width in canvas px of one single-page mockup box (210mm trim x 4px/mm). */
const CANVAS_PAGE_PX = PHYSICAL.pageSizeMm * CANVAS_PX_PER_MM;

export function canvasPxToTrimMm(px: number): number {
  return px / CANVAS_PX_PER_MM;
}

/** A canvas px coordinate (left/top/right/bottom) on a SINGLE-page mockup, as mm from the bleed edge. */
export function canvasPageMm(px: number): number {
  return PHYSICAL.bleedMm + canvasPxToTrimMm(px);
}

/**
 * A canvas px x-coordinate on a two-page SPREAD mockup (1680px wide = two
 * 840px trim halves side by side, no gutter gap drawn), as mm from the
 * spread's left bleed edge.
 */
export function canvasSpreadMm(px: number): number {
  if (px <= CANVAS_PAGE_PX) return PHYSICAL.bleedMm + canvasPxToTrimMm(px);
  return PHYSICAL.bleedMm + PHYSICAL.pageSizeMm + canvasPxToTrimMm(px - CANVAS_PAGE_PX);
}

/** Canvas x (left/right) -> % of the frame's own width, for a single page or a spread. */
export function xPct(px: number, isSpread: boolean): number {
  const mm = isSpread ? canvasSpreadMm(px) : canvasPageMm(px);
  return mmToPctWidth(mm, isSpread);
}

/** Canvas y (top/bottom) -> % of the frame's own height. Height is always one page tall. */
export function yPct(px: number, isSpread: boolean = false): number {
  return mmToPctHeight(canvasPageMm(px), isSpread);
}

/** Canvas width/height (a size, not a position) -> % of the frame's own width. */
export function wPct(px: number, isSpread: boolean): number {
  return mmToPctWidth(canvasPxToTrimMm(px), isSpread);
}

/** Canvas width/height (a size, not a position) -> % of the frame's own height. */
export function hPct(px: number, isSpread: boolean = false): number {
  return mmToPctHeight(canvasPxToTrimMm(px), isSpread);
}

const MM_PER_PT = 25.4 / 72;

/**
 * Type-scale point size -> CSS length in `cqw` (percent of the nearest
 * `container-type: inline-size` ancestor's width — see `.page-frame` in
 * PageFrame.css). This is what makes every template thumbnail-safe: a
 * font-size in raw px does not shrink when the page frame is rendered at
 * book-map thumbnail scale, but a `cqw` value always does, because it's
 * defined as a fraction of the frame's OWN rendered width rather than an
 * absolute px count.
 */
export function ptCqw(pt: number, isSpread: boolean): string {
  const mm = pt * MM_PER_PT;
  return `${mmToPctWidth(mm, isSpread)}cqw`;
}

/** Same idea as `ptCqw` but from an mm size directly (icons, rule thickness, gaps that must scale). */
export function mmCqw(mm: number, isSpread: boolean): string {
  return `${mmToPctWidth(mm, isSpread)}cqw`;
}

/**
 * Same idea as `ptCqw`, parametrized by an explicit container width (mm)
 * instead of the page/spread binary — for a frame with its own custom
 * width, like the wraparound cover (back + variable spine + front, which
 * fits neither `pageDims(false)` nor `pageDims(true)`).
 */
export function ptCqwFor(pt: number, containerWidthMm: number): string {
  return `${((pt * MM_PER_PT) / containerWidthMm) * 100}cqw`;
}

/**
 * Converts a raw canvas px font-size (for the handful of one-off text
 * elements in the design canvas that aren't in the documented type-scale
 * table — e.g. the through-the-years header) to the equivalent point size,
 * so it can still be run through `ptCqw`. Prefer the type-scale table's
 * documented pt values directly wherever one exists.
 */
export function canvasPxToPt(px: number): number {
  return canvasPxToTrimMm(px) / MM_PER_PT;
}

// ---------------------------------------------------------------------------
// Illustrated-story stack-bottom containment (round-9 item 1 — "folio
// stamped on the illustration"). Measured on a real page: the text +
// illustration stack's bottom edge landed at 236mm on a 216mm page, because
// nothing constrained the stack's TOTAL height to the 190mm safe box. These
// pure functions are the single source of truth `IllustratedStory.tsx` (the
// render), `fitter.ts`'s `illustratedStoryNeedsSplit` (the 1-vs-2-page
// decision), and `audit.ts`'s new stack-bottom check (the regression
// backstop) all consume, so the three can never drift apart again — the
// exact bug class a CSS %-basis drift bug shipped twice in round 8.
// ---------------------------------------------------------------------------

/**
 * `.illustrated-story__stack`'s own rendered width (640 canvas px = 160mm)
 * — was a local constant in `IllustratedStory.tsx`; shared here so the
 * caption-height estimator below and the template can never disagree about
 * how wide the text is actually flowing.
 */
export const ILLUSTRATED_STACK_WIDTH_MM = canvasPxToTrimMm(640);

/** Flow gap between the text block and the illustration below it (`STACK_GAP_CANVAS_PX` = 32 canvas px = 8mm in IllustratedStory.tsx). */
export const ILLUSTRATED_STACK_GAP_MM = canvasPxToTrimMm(32);

/** Breathing gap between a month-opener header's own reserve and the stack starting below it (was a local constant in IllustratedStory.tsx). */
export const ILLUSTRATED_HEADER_TO_STACK_GAP_MM = 6;

/** Stack's own top offset in the ordinary, non-stagger, no-header case — canvas y=60px, minus the safe margin (works out to 5mm). */
export const ILLUSTRATED_STACK_TOP_NO_HEADER_MM = canvasPxToTrimMm(60) - PHYSICAL.safeMarginMm;
/** Stack's own top offset in the staggered (alternating-frame) case — canvas y=96px, minus the safe margin (works out to 14mm). */
export const ILLUSTRATED_STACK_TOP_STAGGER_MM = canvasPxToTrimMm(96) - PHYSICAL.safeMarginMm;

/**
 * `.illustrated-story__stack`'s own top offset from the safe box's top edge,
 * for every mode combination — the SAME rule `IllustratedStory.tsx` computes
 * `stackTopPct` with (5mm plain / 14mm stagger / 46mm header).
 */
export function illustratedStackTopMm(hasSectionHeader: boolean, stagger: boolean): number {
  if (hasSectionHeader) return SECTION_HEADER_RESERVE_MM + ILLUSTRATED_HEADER_TO_STACK_GAP_MM;
  return stagger ? ILLUSTRATED_STACK_TOP_STAGGER_MM : ILLUSTRATED_STACK_TOP_NO_HEADER_MM;
}

/**
 * Folio clearance reserved at the safe box's bottom edge (round-9 item 1b)
 * — the folio sits at the safe bottom edge, so the stack's own bottom must
 * stay clear of it by this much. Owner-tunable.
 */
export const ILLUSTRATED_FOLIO_CLEARANCE_MM = 8;

/**
 * The EFFECTIVE per-character line advance to assume when estimating how
 * many lines a caption wraps to — see `illustratedCaptionHeightEstimateMm`
 * for why over-estimating lines is the safe direction. This is NOT
 * Newsreader's raw average glyph width (~0.5em): real word-wrap loses a
 * large ragged-edge margin at every line break (lines break at word
 * boundaries, not at the exact column limit), so the EFFECTIVE
 * chars-per-line is much lower than perfect character packing predicts.
 * Calibrated against a measured real page (round-9 verification): a
 * 101-char Spanish caption at 17pt on the 160mm stack wrapped to 3 real
 * lines — 0.69em effective advance — where the raw-glyph 0.52em estimate
 * predicted 2 (and the illustration, sized to the phantom spare line,
 * overflowed the safe box into the folio zone on two real pages). 0.70
 * sits just past the measured effective value; the ceil() in the line
 * count provides the remaining margin.
 */
const NEWSREADER_AVG_GLYPH_WIDTH_EM = 0.7;
/** Matches `.illustrated-story__body { line-height: 1.58 }` in IllustratedStory.css. */
const ILLUSTRATED_BODY_LINE_HEIGHT = 1.58;
/** Matches the template's date `<span>` font-size (`ptCqw(canvasPxToPt(9.5), false)`). */
const ILLUSTRATED_DATE_FONT_PT = canvasPxToPt(9.5);
/** Browser 'normal' line-height approximation for a single unstyled `<span>` (the date line sets none explicitly). */
const ILLUSTRATED_DATE_LINE_HEIGHT = 1.2;
/** Matches `.illustrated-story__text { gap: 0.9em }` in IllustratedStory.css. */
const ILLUSTRATED_TEXT_GAP_EM = 0.9;

/** Body paragraph font size in the "both" (single-page) mode — 17pt when staggered, 19pt otherwise (`IllustratedStory.tsx`'s own ternary). */
export function illustratedBodyFontSizePt(stagger: boolean): number {
  return stagger ? 17 : 19;
}

/**
 * Round-9 item 1a: a deterministic, DOM-free estimate of the text block's
 * rendered height (date line + body paragraph), CONSERVATIVE BY
 * CONSTRUCTION in one direction only — every choice below can make this
 * estimate TALLER than the true render, never shorter:
 *   - chars-per-line is rounded DOWN (`Math.floor`) — fewer chars per line
 *     means MORE estimated lines for the same caption, never fewer.
 *   - the average glyph width is picked toward the WIDE end of Newsreader's
 *     real range (`NEWSREADER_AVG_GLYPH_WIDTH_EM`) — a wider assumed glyph
 *     shrinks the chars-per-line estimate further, same direction.
 *   - the date line is always counted, even for a caption with no date —
 *     a dateless page's TRUE stack is then strictly shorter than predicted
 *     here, which is safe slack, never a correctness risk.
 * An over-prediction only shrinks the fitted illustration a bit more than
 * strictly necessary (safe); an under-prediction would let the stack
 * overflow the safe box again — the exact bug this whole section exists to
 * close for good.
 */
export function illustratedCaptionHeightEstimateMm(captionLen: number, stagger: boolean): number {
  const bodyFontSizePt = illustratedBodyFontSizePt(stagger);
  const bodyFontSizeMm = bodyFontSizePt * MM_PER_PT;
  const stackWidthPt = ILLUSTRATED_STACK_WIDTH_MM / MM_PER_PT;
  const avgGlyphWidthPt = bodyFontSizePt * NEWSREADER_AVG_GLYPH_WIDTH_EM;
  const charsPerLine = Math.max(1, Math.floor(stackWidthPt / avgGlyphWidthPt));
  const lines = captionLen > 0 ? Math.ceil(captionLen / charsPerLine) : 1;
  const bodyHeightMm = lines * bodyFontSizeMm * ILLUSTRATED_BODY_LINE_HEIGHT;
  const dateLineHeightMm = ILLUSTRATED_DATE_FONT_PT * MM_PER_PT * ILLUSTRATED_DATE_LINE_HEIGHT;
  const gapMm = ILLUSTRATED_TEXT_GAP_EM * bodyFontSizeMm;
  return dateLineHeightMm + gapMm + bodyHeightMm;
}

/**
 * Round-9 item 1b: the FINAL rendered illustration height for the "both"
 * (single-page) mode — `min(nominal size from illustratedIlloHeightMm, the
 * max height that keeps the stack's own bottom edge at or above
 * SAFE_BOX_MM - ILLUSTRATED_FOLIO_CLEARANCE_MM)`. This is the actual fix for
 * the "folio stamped on the illustration" bug (a real page measured the
 * stack bottom at 236mm on a 216mm page) — every caller (the template, the
 * fitter's split threshold, the audit's stack-bottom check) uses this SAME
 * function, so the three can never drift. Width follows from this height at
 * the image's own aspect ratio (never stretched/distorted).
 */
export function illustratedIlloFitHeightMm(
  captionLen: number,
  hasSectionHeader: boolean,
  stagger: boolean,
  aspectRatio: number,
): number {
  const nominalHeight = illustratedIlloHeightMm(captionLen, hasSectionHeader, aspectRatio);
  const top = illustratedStackTopMm(hasSectionHeader, stagger);
  const captionHeight = illustratedCaptionHeightEstimateMm(captionLen, stagger);
  const verticalBudget = SAFE_BOX_MM - ILLUSTRATED_FOLIO_CLEARANCE_MM - top - captionHeight - ILLUSTRATED_STACK_GAP_MM;
  return Math.max(0, Math.min(nominalHeight, verticalBudget));
}

// ---------------------------------------------------------------------------
// Section-header title width estimate (round-9 item 3 — "title-aware
// beside-header width cap"). `layoutTallSoloBesideHeader` (anchorMediaLayout.ts)
// used to cap a tall solo's column at a flat 50% of the safe box regardless
// of how short the header's own title was, leaving an oversized empty gap
// next to a short month title like "mayo 2025". These pure functions model
// the title's own rendered width from `SectionHeader.tsx`'s own font
// metrics, so the layout function (and the audit's matching overlap check)
// can grow the image column only as far as the ACTUAL title leaves clear —
// never into it, however long the title happens to be.
// ---------------------------------------------------------------------------

/** `SectionHeader.tsx`'s own container width for the whole kicker+title block — a fraction of the safe box (`width: '80%'`). */
export const SECTION_HEADER_WIDTH_FRACTION = 0.8;

/**
 * Deliberately toward the WIDE end of Newsreader's real average glyph
 * advance width — the conservative direction here is the OPPOSITE of the
 * caption-height estimator's (round-9 item 1a uses a wide glyph to make a
 * HEIGHT estimate taller; this uses a wide glyph to make a WIDTH estimate
 * wider), but the goal is the same: this estimate must never UNDER-predict
 * the title's true rendered width, or the derived cap below could let an
 * image column encroach on a title that renders wider than predicted.
 *
 * 0.45em blends a mixed-case-letter average (~0.5em, the same ballpark the
 * caption-height estimator uses for body text) down slightly for what a
 * month-title string actually contains — a SPACE (much narrower than a
 * letter, ~0.25-0.3em) and digits (near-monospaced, ~0.5-0.6em) — while
 * still erring wide. Calibrated against the real books: at this value,
 * Mara's "julio 2025"/"octubre 2025" headers (short titles) grow the tall-
 * solo column from the old flat 94mm toward the 123.5mm (65%) ceiling, and
 * a themed spread's own long title stays close to the 95mm (50%) floor —
 * see anchorMediaLayout.ts's `tallSoloHeaderWidthCapMm`. Owner-tunable.
 */
const NEWSREADER_TITLE_AVG_GLYPH_WIDTH_EM = 0.45;

/** `SectionHeader.tsx`: `fontSize: ptCqw(special ? 44 : 34, isSpread)`. */
export function sectionHeaderTitleFontSizePt(special: boolean): number {
  return special ? 44 : 34;
}

/**
 * Deterministic, DOM-free estimate of the title's own SINGLE-LINE rendered
 * width, at its own font size — conservative by construction (see the doc
 * comment on `NEWSREADER_TITLE_AVG_GLYPH_WIDTH_EM`): rounds UP, never down.
 * Ignores letter-spacing (`-0.028em`, a small net-negative adjustment) and
 * kerning, both folded into the wide glyph-width assumption's margin.
 */
export function sectionHeaderTitleWidthEstimateMm(title: string, special: boolean): number {
  const fontSizePt = sectionHeaderTitleFontSizePt(special);
  const avgGlyphWidthPt = fontSizePt * NEWSREADER_TITLE_AVG_GLYPH_WIDTH_EM;
  return title.length * avgGlyphWidthPt * MM_PER_PT;
}

export interface SectionHeaderTitleModel {
  /** The title's own modeled width, in mm — capped at the header's own container width (`SECTION_HEADER_WIDTH_FRACTION` of the safe box) when the estimate says it would wrap. */
  widthMm: number;
  /** True when the single-line estimate exceeds the header's own container width — the title wraps to 2+ lines, per `SectionHeader.tsx`'s own layout. */
  wraps: boolean;
}

/**
 * Models a section header's title for width-cap purposes — the ONE
 * function `layoutTallSoloBesideHeader` and the audit's matching overlap
 * check both consume, so neither can compute a different title box than
 * the other. `null`/empty title models as a zero-width, non-wrapping box
 * (no title to avoid).
 */
export function modelSectionHeaderTitle(safeBoxWidthMm: number, title: string | null, special: boolean): SectionHeaderTitleModel {
  if (!title) return { widthMm: 0, wraps: false };
  const estimateMm = sectionHeaderTitleWidthEstimateMm(title, special);
  const containerMm = safeBoxWidthMm * SECTION_HEADER_WIDTH_FRACTION;
  const wraps = estimateMm > containerMm;
  return { widthMm: Math.min(estimateMm, containerMm), wraps };
}

// ---------------------------------------------------------------------------
// Illustrated-digest sizing (round-12: promotes the preview demo composition
// — see IllustratedDigest.tsx's own history — to a real fitter-emitted one).
// Shared here so `templates/layout/illustratedDigestLayout.ts` (the row
// packer), `IllustratedDigest.tsx` (the render), and `audit.ts`'s own
// geometric check all consume the SAME numbers and can never drift.
// ---------------------------------------------------------------------------

/**
 * Owner round-12 (re-tuned back UP after the implementer dropped it to 75mm
 * for the aspect-0.9 worst case): the illustration renders in a FIXED
 * 82mm SQUARE box (`object-fit: cover`) — the owner-approved demo scale —
 * instead of scaling its height by aspect. Within the tightened
 * `[0.9, 1.1]` eligibility band the square crop loses at most ~10% of one
 * dimension (the book's standing grid-crop tolerance), and in practice
 * every Momora illustration is generated at 1024x1024 (aspect 1.0 — no
 * crop at all). Fixed rows make the geometry trivially safe: two 82mm
 * rows + the 6mm gap = 170mm against the ~182mm column. Owner-tunable.
 */
export const DIGEST_ILLO_WIDTH_MM = 82;
/** Vertical gap between an illustrated-digest column's rows — matches the template's own CSS rhythm (~1.4em at the entry's 13pt body size). */
export const DIGEST_ROW_GAP_MM = 6;
/** Folio clearance reserved at an illustrated-digest column's bottom edge — same role as `ILLUSTRATED_FOLIO_CLEARANCE_MM`, a separate constant since the two compositions may retune independently. */
export const DIGEST_FOLIO_CLEARANCE_MM = 8;
/** `.illustrated-digest__textcol { max-width: 46% }` — the text column's own share of the page's content width. */
export const DIGEST_TEXT_MAX_WIDTH_FRACTION = 0.46;
/** `.illustrated-digest__text { font-size: 13pt }`. */
export const DIGEST_TEXT_FONT_PT = 13;
/** Matches `.illustrated-digest__text { line-height: 1.55 }`. */
const DIGEST_TEXT_LINE_HEIGHT = 1.55;
/** Matches the entry's date `<span>`'s own font-size (`ptCqw(6.5, true)` in the template). */
const DIGEST_DATE_FONT_PT = 6.5;
/** Matches `.illustrated-digest__date { line-height: 1.2 }`. */
const DIGEST_DATE_LINE_HEIGHT = 1.2;
/** Matches `.illustrated-digest__textcol { gap: 0.55em }`. */
const DIGEST_TEXT_GAP_EM = 0.55;

/**
 * Conservative-by-construction text-block height estimate — same technique
 * as `illustratedCaptionHeightEstimateMm` (rounds chars-per-line DOWN, uses
 * a wide average glyph width), re-parameterized at the digest's own 13pt
 * body size and narrower (46%-of-column) measure.
 */
function digestTextHeightEstimateMm(captionLen: number, textWidthMm: number): number {
  const fontSizeMm = DIGEST_TEXT_FONT_PT * MM_PER_PT;
  const widthPt = textWidthMm / MM_PER_PT;
  const avgGlyphWidthPt = DIGEST_TEXT_FONT_PT * NEWSREADER_AVG_GLYPH_WIDTH_EM;
  const charsPerLine = Math.max(1, Math.floor(widthPt / avgGlyphWidthPt));
  const lines = captionLen > 0 ? Math.ceil(captionLen / charsPerLine) : 1;
  const bodyHeightMm = lines * fontSizeMm * DIGEST_TEXT_LINE_HEIGHT;
  const dateLineHeightMm = DIGEST_DATE_FONT_PT * MM_PER_PT * DIGEST_DATE_LINE_HEIGHT;
  const gapMm = DIGEST_TEXT_GAP_EM * fontSizeMm;
  return dateLineHeightMm + gapMm + bodyHeightMm;
}

export interface DigestRowMetrics {
  illoHeightMm: number;
  textHeightMm: number;
  /** The row's own rendered height — illustration and text sit SIDE BY SIDE, so the row is as tall as whichever is taller, never their sum. */
  rowHeightMm: number;
}

/** One digest entry's row height at the shared `DIGEST_ILLO_WIDTH_MM` — the ONE function the template, the fitter's own no-op geometry (it never needs to size anything, only the render/audit do), and the audit's regression check all consume. */
export function digestRowMetrics(captionLen: number, _illoAspect: number, columnWidthMm: number): DigestRowMetrics {
  // Fixed square box (see DIGEST_ILLO_WIDTH_MM) — aspect no longer changes
  // the row height; the parameter stays for call-site compatibility.
  const illoHeightMm = DIGEST_ILLO_WIDTH_MM;
  const textWidthMm = columnWidthMm * DIGEST_TEXT_MAX_WIDTH_FRACTION;
  const textHeightMm = digestTextHeightEstimateMm(captionLen, textWidthMm);
  return { illoHeightMm, textHeightMm, rowHeightMm: Math.max(illoHeightMm, textHeightMm) };
}
