import { PHYSICAL } from '../../model/types';
import { colSpanMm, snapToBaseline, MIN_IMAGE_SIDE_MM } from '../mm';

/**
 * Deterministic asymmetric packer for `flex-grid` (Momora Book Layout System
 * 1b §3 "Retícula flexible"). This implements the WRITTEN rules — whole
 * columns, baseline-snapped heights, asymmetry ("two holes never share the
 * same top edge"), 40mm minimum side — as a skyline/shelf bin-pack rather
 * than reproducing the hand-designed example compositions pixel-for-pixel
 * (those are one-off curated layouts in the design canvas, not a formula).
 *
 * Pure function: same input always produces the same rects, and it never
 * touches the DOM — this can run identically in the browser preview and a
 * future Node print pipeline.
 */

export interface FlexGridInput {
  /** The crop-box aspect ratio the fitter already picked for this photo (targetAspect). */
  aspect: number;
  hero: boolean;
}

export interface FlexGridRect {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

/** Round-5 amendment: shared with every other composition — see `MIN_IMAGE_SIDE_MM`'s doc comment (was a local 40mm floor). */
const MIN_SIDE_MM = MIN_IMAGE_SIDE_MM;
const COLUMNS = PHYSICAL.columns; // 6

/**
 * Round-7 item 1c: fill the canvas VERTICALLY — a 4-photo grid must read as
 * 2-per-row stacks (2+2), never a single cramped row that leaves the lower
 * half of the page white (owner screenshot: a 3-in-a-row grid at span=2
 * each fills exactly one row and stops, using well under half the
 * available height). Round-8 item 5b ("grids only at 4" — owner rule: a
 * page holds exactly 1, 2, or 4 photos, NEVER 3, never >4):
 * `chunkSingleMemoryAssets`/`scoreFlexGrid` in fitter.ts now guarantee
 * flex-grid only EVER sees n=4 — a former 3-photo grid is a 2+1 pair of
 * anchor-media pages instead — so span=3 (EXACTLY 2 photos per 6-column
 * row) always yields the 2+2 stack via the skyline packer's own shelf
 * logic below, no special-casing needed beyond this span choice. `n` != 4
 * (unreachable today, kept as a defensive fallback should that invariant
 * ever be violated upstream) still falls back to the old aspect-driven
 * span.
 */
function colSpanFor(aspect: number, hero: boolean, n: number): number {
  if (hero) return 4;
  if (n === 4) return 3;
  if (aspect >= 1.5) return 3;
  return 2;
}

/**
 * @param items Photos in outline order.
 * @param widthMm Available content width (the safe box — 190mm on a single page).
 * @param heightMm Available content height (safe box height minus any
 *   reserved header/footer strips the caller has already subtracted).
 */
export function layoutFlexGrid(items: FlexGridInput[], widthMm: number, heightMm: number): FlexGridRect[] {
  if (items.length === 0) return [];

  const colWidthUnit = widthMm / (COLUMNS * 27.5 + (COLUMNS - 1) * PHYSICAL.gutterMm); // scale factor if widthMm != 190
  const colOffsetMm: number[] = [0];
  for (let c = 0; c < COLUMNS; c++) {
    const w = 27.5 * colWidthUnit;
    colOffsetMm.push(colOffsetMm[c] + w + PHYSICAL.gutterMm * colWidthUnit);
  }
  const columnHeights = new Array(COLUMNS).fill(0);
  const usedTopRows = new Set<number>(); // baseline-snapped top values already used, for the asymmetry rule

  const rects: FlexGridRect[] = items.map((item) => {
    let span = Math.min(COLUMNS, colSpanFor(item.aspect, item.hero, items.length));

    // Find the column start (0..COLUMNS-span) whose shelf is lowest (skyline packing).
    let bestStart = 0;
    let bestHeight = Infinity;
    for (let start = 0; start + span <= COLUMNS; start++) {
      const shelfHeight = Math.max(...columnHeights.slice(start, start + span));
      if (shelfHeight < bestHeight) {
        bestHeight = shelfHeight;
        bestStart = start;
      }
    }

    const wMm = colSpanMm(span) * colWidthUnit;
    let hMm = snapToBaseline(wMm / item.aspect);
    hMm = Math.max(hMm, MIN_SIDE_MM);

    let yMm = bestHeight;
    // Asymmetry rule: no two holes share the same top edge — nudge down by
    // one baseline if this exact top has already been used elsewhere.
    while (usedTopRows.has(Math.round(yMm))) {
      yMm += PHYSICAL.baselineMm;
    }
    usedTopRows.add(Math.round(yMm));

    const xMm = colOffsetMm[bestStart];
    for (let c = bestStart; c < bestStart + span; c++) {
      columnHeights[c] = yMm + hMm + PHYSICAL.gutterMm; // gutter reserves room for the numeral strip below
    }

    return { xMm, yMm, wMm, hMm };
  });

  const usedHeight = Math.max(...columnHeights);
  if (usedHeight > heightMm && usedHeight > 0) {
    const scale = heightMm / usedHeight;
    return rects.map((r) => ({
      xMm: r.xMm,
      yMm: r.yMm * scale,
      wMm: r.wMm,
      hMm: Math.max(MIN_SIDE_MM * scale, snapToBaseline(r.hMm * scale)),
    }));
  }

  return rects;
}
