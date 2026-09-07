import type { BookPage } from '../../model/types';
import { PHYSICAL } from '../../model/types';
import { FULL_PAGE_MM, SPREAD_WIDTH_MM, SPREAD_HEIGHT_MM } from '../../templates/mm';

/**
 * Web-only viewport-fit sizing (polish-round item 1). Computes the aspect
 * ratio (width/height) of whatever's currently on screen — a single page, a
 * genuine cross-gutter spread template, the wraparound cover, or an ordinary
 * left+right facing pair — so `useFitToViewport` can size the wrapper's
 * `max-width` from the available height without ever touching template CSS
 * (every constant here is imported from `templates/mm.ts`/`model/types.ts`,
 * not re-declared).
 */
export function computeUnitAspect(pages: BookPage[]): number {
  if (pages.length === 2) {
    // A facing pair is two ordinary (square) single pages side by side. The
    // ~1px CSS gutter seam `.spread-pager__facing` draws between them is a
    // sub-pixel rounding error at any real on-screen size, ignored here.
    return (FULL_PAGE_MM * 2) / FULL_PAGE_MM;
  }
  const page = pages[0];
  if (!page) return 1;
  if (page.templateId === 'cover-wrap') {
    // Mirrors WraparoundCover.tsx's own `wrapWidthMm`/`wrapHeightMm` math —
    // the wrap's width is back + spine + front, not a plain page/spread.
    const spineMm = Number(page.params.spineMm ?? 9);
    const wrapWidthMm = PHYSICAL.pageSizeMm * 2 + spineMm + PHYSICAL.bleedMm * 2;
    const wrapHeightMm = PHYSICAL.pageSizeMm + PHYSICAL.bleedMm * 2;
    return wrapWidthMm / wrapHeightMm;
  }
  if (page.isSpread) {
    return SPREAD_WIDTH_MM / SPREAD_HEIGHT_MM;
  }
  return FULL_PAGE_MM / FULL_PAGE_MM; // 1 — an ordinary square single page.
}
