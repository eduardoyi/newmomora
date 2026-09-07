import { useEffect, useState, type RefObject } from 'react';

/**
 * Web-only viewport-fit sizing (polish-round item 1: "the rendered spread
 * currently floats small in the viewport"). Lives entirely in `src/web/` —
 * the local preview app (`src/preview/`) and the print entry are untouched,
 * and this hook never reaches into `SpreadPager`/`PageFrame`/template CSS;
 * it only measures a wrapper DIV the web app itself renders around
 * `<SpreadPager>` and writes a `max-width` back onto that SAME wrapper.
 *
 * On a desktop-width viewport, the spread should fill ~90% of the wrapper's
 * available height, capped so it can never overflow the wrapper's width —
 * achieved by converting "90% of height" into an equivalent `max-width` (via
 * the unit's own aspect ratio from `computeUnitAspect`) and letting the
 * existing `.spread-pager__stage { width: 100%; max-width: ... }` /
 * `.page-frame { width: 100%; aspect-ratio: ... }` CSS chain do the rest —
 * every page-frame already sizes its OWN height from ITS OWN width via
 * `aspect-ratio`, so constraining the outer wrapper's width is sufficient.
 *
 * On a narrower (mobile/tablet) viewport, returns `null` — the caller
 * applies no inline `max-width`, so the existing fit-to-WIDTH flow (every
 * page-frame's own `width: 100%` of its container) is exactly what renders,
 * unchanged.
 */
const DESKTOP_BREAKPOINT_PX = 768;
const HEIGHT_FILL_RATIO = 0.9;

export function useFitToViewportWidth(containerRef: RefObject<HTMLElement | null>, aspect: number): number | null {
  const [maxWidthPx, setMaxWidthPx] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function recompute() {
      if (typeof window === 'undefined' || window.innerWidth < DESKTOP_BREAKPOINT_PX) {
        setMaxWidthPx(null);
        return;
      }
      const heightBudget = (el?.clientHeight ?? 0) * HEIGHT_FILL_RATIO;
      if (heightBudget <= 0) {
        setMaxWidthPx(null);
        return;
      }
      setMaxWidthPx(Math.round(heightBudget * aspect));
    }

    recompute();

    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    window.addEventListener('resize', recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [containerRef, aspect]);

  return maxWidthPx;
}
