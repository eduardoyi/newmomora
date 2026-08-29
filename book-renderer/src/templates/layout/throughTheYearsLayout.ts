import { canvasPageMm, canvasPxToTrimMm, canvasSpreadMm } from '../mm';

/**
 * Deterministic geometry for `through-the-years` (round-21 print-safety
 * fix). Diagnosed bug: `.ttty__meta` (the per-portrait source-thumb + age/
 * date labels block) was IN-FLOW flex content nested inside the
 * absolutely-positioned `.ttty__item`, itself inside the print path's 426mm
 * cropped-spread tree (`PrintApp.tsx` renders the full spread, then crops
 * one printable half via `overflow: hidden`). Chromium's print pagination
 * (`page.pdf`, NOT the screen/screenshot renderer — the two disagree here)
 * redistributed that in-flow content: labels got pulled up onto the
 * portrait, thumbs displaced. Screen, the built app, and even Puppeteer
 * with print-media emulation all measured fine — only the real `page.pdf`
 * output broke.
 *
 * Root cause, confirmed by live `page.pdf` capture during this fix: it's
 * not specifically about a flex ROW with mixed children — ANY element that
 * is BOTH `position: absolute` AND left at an `auto` (content-driven)
 * height, anywhere in this cropped-spread tree, has its own in-flow
 * children collapse/redistribute under print pagination, however shallow.
 * The first pass here fixed `.ttty__item` (the portrait/thumb/labels'
 * shared ancestor) but left `.ttty__labels` itself absolutely positioned
 * with an auto height — the age/date lines inside it still rendered
 * literally on top of each other in the real PDF until `.ttty__labels` also
 * got an explicit height (see `TtyRect.heightMm` on `labels` below, and
 * `ThroughTheYears.tsx`'s own comment at that box). The digest spread
 * (`IllustratedDigest.tsx`, `illustratedDigestLayout.ts`) never showed
 * ANY version of the bug because it has no absolutely-positioned box with
 * an auto height anywhere in its tree — `.illustrated-digest__entry` is
 * absolute with an explicit height, and `.illustrated-digest__textcol`
 * (its own two-line date+text stack) is a plain in-flow flex child, never
 * itself `position: absolute`. This module's rule going forward: every
 * `position: absolute` box in this tree gets an explicit height, full
 * stop — pure functions, no DOM, consumed identically by
 * `templates/ThroughTheYears.tsx` (the render) and `model/audit.ts`'s
 * geometric check, so the two can never disagree about where a
 * portrait/thumb/label actually lands.
 */

export interface TtyOuterLayout {
  leftPx: number;
  topPx: number;
  widthPx: number;
}

/**
 * Staggered left/top/width so no two portrait frames share a top edge —
 * matches the design canvas's 3-portrait example, extended for up to 6.
 * Moved here (round-21) from `ThroughTheYears.tsx`, so `model/audit.ts` can
 * recompute the exact same outer position every item renders at, not just
 * its internal portrait/thumb/labels geometry.
 *
 * Round-21 `topPx` correction (index 2 only): giving this module a real
 * safe-box check (`model/audit.ts`'s new `through-the-years` check) surfaced
 * a SEPARATE, pre-existing defect this same round — at `widthPx: 420`
 * (105mm), a portrait + its meta row (thumb + labels) stands 134mm tall, and
 * the OLD `topPx: 280` (68mm from the safe top) put its bottom edge at
 * ~207mm, past the 203mm safe-box floor (and briefly discussed as possibly
 * THE actual mechanism behind the owner's print bug: Chromium's print
 * pagination may have been yanking this already-overflowing row upward to
 * keep it from being lost entirely, which reads exactly like "labels pulled
 * onto the portrait" — where the SCREEN render just silently clipped the
 * overflow via `.page-frame`'s own `overflow: hidden`, invisible rather
 * than alarming). `topPx: 280` -> `250` moves the bottom edge to ~199.5mm,
 * ~3.5mm inside the safe floor. Every OTHER entry in this table already
 * fits (verified against `layoutTtyItem`'s own height model for its own
 * `widthPx`) and is unchanged.
 */
const LEGACY_LAYOUTS: TtyOuterLayout[] = [
  { leftPx: 80, topPx: 300, widthPx: 340 },
  { leftPx: 480, topPx: 340, widthPx: 260 },
  { leftPx: 1000, topPx: 250, widthPx: 420 },
  { leftPx: 80, topPx: 640, widthPx: 220 },
  { leftPx: 480, topPx: 660, widthPx: 200 },
  { leftPx: 1180, topPx: 660, widthPx: 220 },
];

/**
 * Bug fix (owner review round 5, item 8): `partitionPortraits` always hands
 * this template a chunk of 1-3 portraits per spread (its own doc comment
 * guarantees the range) — but the OLD lookup indexed purely by running
 * position, so a 2-portrait chunk landed on `LEGACY_LAYOUTS[0]` AND
 * `LEGACY_LAYOUTS[1]`, both of which sit left of the 840px page-1/page-2
 * boundary on this 1680px spread canvas — i.e. BOTH portraits rendered on
 * the LEFT page, leaving the right page of the spread empty. Each group
 * size gets its own table with an explicit left/right-page split: 1 -> right
 * page (balances the kicker/title on the left), 2 -> one per page, 3 -> 2
 * left + 1 right (unchanged from the original table, which already got this
 * case right).
 *
 * Round-21 `topPx` correction (same defect class as `LEGACY_LAYOUTS[2]`
 * above, same fix — move the bottom edge back inside the 203mm safe floor,
 * `leftPx`/`widthPx` untouched): the size-1 entry (`widthPx: 420`, same
 * 134mm-tall item) had `topPx: 380`, landing its bottom edge at ~232mm —
 * past even the FULL PAGE edge (216mm), so the thumb would have rendered
 * entirely below the visible page. `380 -> 250` (same target as
 * `LEGACY_LAYOUTS[2]`, which shares this entry's `widthPx`). The size-2
 * entry's second slot (`widthPx: 340`, a 109mm-tall item) had `topPx: 420`,
 * landing its bottom edge at ~217mm — also past the safe floor. `420 ->
 * 350` moves it to ~199.7mm, inside. Its first slot (`topPx: 320`) already
 * fit (~192mm) and is unchanged.
 */
const LAYOUTS_BY_SIZE: Record<number, TtyOuterLayout[]> = {
  1: [{ leftPx: 1020, topPx: 250, widthPx: 420 }],
  2: [
    { leftPx: 80, topPx: 320, widthPx: 340 },
    { leftPx: 1020, topPx: 350, widthPx: 340 },
  ],
  3: [LEGACY_LAYOUTS[0], LEGACY_LAYOUTS[1], LEGACY_LAYOUTS[2]],
};

/** Outer (spread-canvas-px) position/width for the i-th of `count` portraits — the SAME table `ThroughTheYears.tsx` renders with and `model/audit.ts` recomputes from. */
export function ttyOuterLayoutFor(count: number, i: number): TtyOuterLayout {
  const table = LAYOUTS_BY_SIZE[count];
  if (table) return table[i % table.length];
  return LEGACY_LAYOUTS[i % LEGACY_LAYOUTS.length]; // defensive fallback — partitionPortraits never actually produces >3
}

// ---------------------------------------------------------------------------
// Item-internal geometry (portrait / source thumb / age+date labels).
// ---------------------------------------------------------------------------

/**
 * The browser's UNSTYLED root font-size, in mm — the `em` basis every
 * `.ttty__meta`/`.ttty__labels` gap below was expressed in. Neither
 * `print.html` nor any ancestor in the render tree (`PageFrame.css`'s
 * `.page-frame`, `.ttty`, `.ttty__item`) sets an explicit `font-size`, and
 * the print path's own physical-size scaffolding (`PrintApp.tsx`) only ever
 * sets `width`/`height` in mm on `html`/`body`, never `font-size` — so the
 * `em` resolves against the literal browser default, 16px, regardless of
 * the page's physical mm size. 16px = 16/96in = 4.2333mm.
 */
const ROOT_EM_MM = (16 / 96) * 25.4;

/** `.ttty__meta { gap: 0.9em; padding-top: 0.9em }` — both fixed to the SAME mm value here (round-21: was flex `gap`/`padding-top`, now the fixed vertical offset between the portrait and the thumb/labels row, and the fixed horizontal offset between the thumb and the labels). */
export const TTY_META_GAP_MM = 0.9 * ROOT_EM_MM;

/** `.ttty__labels { padding-top: 0.1em }` — small nudge that aligned the age line's cap-height with the thumb's own top edge. */
export const TTY_LABELS_TOP_NUDGE_MM = 0.1 * ROOT_EM_MM;

/** `.ttty__labels { gap: 0.3em }` — vertical gap between the age and date lines. */
export const TTY_LABELS_GAP_MM = 0.3 * ROOT_EM_MM;

/** `.ttty__source { width: 24% }` of the item's own box. */
export const TTY_SOURCE_WIDTH_FRACTION = 0.24;

/** `ptCqw(canvasPxToPt(19), true)` in the template — the age line's real rendered font-size, in mm (canvas px / 4 = trim mm, exactly what `ptCqw`'s cqw percentage reproduces at full scale). */
const TTY_AGE_FONT_SIZE_MM = canvasPxToTrimMm(19);
/** `ptCqw(canvasPxToPt(10), true)` in the template — the date line's real rendered font-size, in mm. */
const TTY_DATE_FONT_SIZE_MM = canvasPxToTrimMm(10);
/** Browser 'normal' line-height approximation — neither `.ttty__age` nor `.ttty__date` sets an explicit `line-height` (same technique `mm.ts`'s `ILLUSTRATED_DATE_LINE_HEIGHT`/`DIGEST_DATE_LINE_HEIGHT` use for their own unstyled spans). */
const DEFAULT_LINE_HEIGHT = 1.2;

/** The labels block's own modeled height (age line + gap + date line) — conservative estimate, same role as `illustratedCaptionHeightEstimateMm`/`digestTextHeightEstimateMm` in `mm.ts`, but trivial here since the two lines never wrap (short, fixed-format age/date strings). */
const TTY_LABELS_HEIGHT_MM =
  TTY_AGE_FONT_SIZE_MM * DEFAULT_LINE_HEIGHT + TTY_LABELS_GAP_MM + TTY_DATE_FONT_SIZE_MM * DEFAULT_LINE_HEIGHT;

export interface TtyRect {
  leftMm: number;
  topMm: number;
  widthMm: number;
  heightMm: number;
}

export interface TtyItemLayout {
  /** Square, item-width x item-width, anchored at the item's own top-left. */
  portrait: TtyRect;
  /** Square, 24% of item width, below the portrait — `null` when the portrait has no source photo to show (`ManifestPortrait.sourceFile` absent). */
  thumb: TtyRect | null;
  /** Age/date labels block — right of the thumb (or at the item's own left edge when there's no thumb), starting just below the portrait. Sized from `TTY_LABELS_HEIGHT_MM`/the item's own remaining width, never measured live. */
  labels: TtyRect;
  /**
   * The item's own total rendered height (portrait + gap + the taller of
   * the thumb/labels row) — what the template must set as `.ttty__item`'s
   * OWN explicit height, so its now-absolutely-positioned children (also
   * absolute) have a real containing block to resolve their % against,
   * rather than an auto height that collapses to 0 (every child is
   * `position: absolute` and contributes nothing to flow height — the exact
   * containing-block trap `illustratedDigestLayout.ts`'s own doc comments
   * warn about). Also what `model/audit.ts`'s safe-box check measures the
   * item against.
   */
  itemHeightMm: number;
}

/**
 * Given one item's own width (mm, at native page scale) and whether its
 * portrait has a source photo, computes every internal rect as mm offsets
 * from the ITEM's own top-left (0,0) — never from the spread or the page.
 * `ThroughTheYears.tsx` converts each rect into a percentage of the item's
 * OWN rendered width/height (its actual containing block, now that the
 * item has an explicit height); `model/audit.ts`'s check adds the item's
 * own absolute spread position (`ttyItemAbsoluteRect`) on top to verify
 * containment in real mm.
 */
export function layoutTtyItem(itemWidthMm: number, hasSourceThumb: boolean): TtyItemLayout {
  const portrait: TtyRect = { leftMm: 0, topMm: 0, widthMm: itemWidthMm, heightMm: itemWidthMm };
  const rowTopMm = itemWidthMm + TTY_META_GAP_MM;
  const thumbWidthMm = itemWidthMm * TTY_SOURCE_WIDTH_FRACTION;

  const thumb: TtyRect | null = hasSourceThumb
    ? { leftMm: 0, topMm: rowTopMm, widthMm: thumbWidthMm, heightMm: thumbWidthMm }
    : null;

  const labelsLeftMm = hasSourceThumb ? thumbWidthMm + TTY_META_GAP_MM : 0;
  const labels: TtyRect = {
    leftMm: labelsLeftMm,
    topMm: rowTopMm + TTY_LABELS_TOP_NUDGE_MM,
    widthMm: Math.max(0, itemWidthMm - labelsLeftMm),
    heightMm: TTY_LABELS_HEIGHT_MM,
  };

  // The item's own total height reaches to whichever of the thumb/labels
  // row's own bottom edge is lower (mirrors the old flex row's
  // `align-items: flex-start` sizing) — at every real item width (>= 200
  // canvas px = 50mm, per `LEGACY_LAYOUTS`/`LAYOUTS_BY_SIZE` above) the
  // 24%-wide thumb is taller than the two-line label block, but this is
  // computed from each rect's OWN bottom edge (not a shared "row height"
  // added back onto `rowTopMm`, which would silently drop the labels'
  // extra `TTY_LABELS_TOP_NUDGE_MM` offset) so a future narrower item width
  // (or a no-thumb page) still gets a correct item height instead of
  // clipping the labels.
  const thumbBottomMm = thumb ? thumb.topMm + thumb.heightMm : 0;
  const labelsBottomMm = labels.topMm + labels.heightMm;
  const itemHeightMm = Math.max(thumbBottomMm, labelsBottomMm);

  return { portrait, thumb, labels, itemHeightMm };
}

export interface TtyAbsoluteRect {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

/**
 * An item's own outer box, in absolute mm from the SPREAD's bleed edge
 * (round-21, for `model/audit.ts`'s safe-box check) — the same conversion
 * `ThroughTheYears.tsx` performs via `xPct`/`yPct`/`wPct`, but returning raw
 * mm instead of a spread-relative percentage string.
 */
export function ttyItemAbsoluteRect(outer: TtyOuterLayout, itemHeightMm: number): TtyAbsoluteRect {
  return {
    xMm: canvasSpreadMm(outer.leftPx),
    yMm: canvasPageMm(outer.topPx),
    wMm: canvasPxToTrimMm(outer.widthPx),
    hMm: itemHeightMm,
  };
}

/** Offsets a child rect (mm, relative to the item's own top-left) by the item's own absolute spread position — what `model/audit.ts` checks against the spread's safe box. */
export function ttyChildAbsoluteRect(itemAbs: TtyAbsoluteRect, child: TtyRect): TtyAbsoluteRect {
  return { xMm: itemAbs.xMm + child.leftMm, yMm: itemAbs.yMm + child.topMm, wMm: child.widthMm, hMm: child.heightMm };
}
