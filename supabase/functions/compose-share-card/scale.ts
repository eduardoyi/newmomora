// Pure math for the S0-mandated "reduced raster scale" mitigation
// (docs/plans/offline-awareness-and-share-cards.md, S0 + S3). The gating
// spike measured that Supabase Edge Functions' WORKER_RESOURCE_LIMIT
// failures track TOTAL PIXEL COUNT of the rendered card (resvg's RGBA
// raster buffer), not caption length or photo bytes directly: ~87.5%
// per-attempt success at <=~2.5M px, 37.5% at 5.5M px. The fix is to render
// the identical layout at 720px width (2/3 scale of every dimension)
// instead of 1080px whenever the 1080-wide layout would exceed the budget
// -- never truncate the caption to fit.

export const SHARE_CARD_FULL_WIDTH = 1080;
export const SHARE_CARD_REDUCED_WIDTH = 720;
export const SHARE_CARD_REDUCED_SCALE = SHARE_CARD_REDUCED_WIDTH / SHARE_CARD_FULL_WIDTH;

/** Measured ceiling from the S0 spike (see header comment). */
export const SHARE_CARD_PIXEL_BUDGET = 2_500_000;

/**
 * Decides whether to re-render at SHARE_CARD_REDUCED_SCALE, given the height
 * (in px) the card would be at `width` (1080 by default). Pure so the
 * decision boundary is unit-testable without running satori/resvg.
 */
export function shouldUseReducedScale(
  heightAtFullWidthPx: number,
  width: number = SHARE_CARD_FULL_WIDTH,
  budget: number = SHARE_CARD_PIXEL_BUDGET,
): boolean {
  return width * heightAtFullWidthPx > budget;
}

/** Extracts the integer height attribute satori embeds in its SVG output
 * root element (`<svg ... height="1234" ...>`). Returns null if the SVG
 * string doesn't match the expected shape (defensive -- callers should treat
 * null as "could not determine, skip the reduced-scale decision"). */
export function parseSvgHeightPx(svg: string): number | null {
  const match = svg.match(/<svg[^>]*\sheight="(\d+(?:\.\d+)?)"/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
