// Pure math for (a) the logical-to-raster scale that keeps the share card's
// typography/paddings proportioned like the in-app card, and (b) the
// S0-mandated "reduced raster scale" mitigation
// (docs/plans/offline-awareness-and-share-cards.md, S0 + S3).
//
// ── Logical card width (proportions fix) ────────────────────────────────
// layout.ts composes the card in LOGICAL units -- the same RN dp values as
// src/components/memory-card.tsx (font sizes, paddings, radii, avatar
// sizes, all copied verbatim) -- and only converts to raster pixels here,
// at the very end, via BASE_SCALE/REDUCED_SCALE. Previously the card was
// laid out directly at a 1080px width using those dp-scale magic numbers
// (e.g. a 14.5 "fontSize"), so a value sized for a ~400dp-wide card ended
// up ~1.5% of a 1080px-wide canvas instead of the in-app ~4% -- the "huge
// photo, tiny caption strip" bug. Composing in logical units first and
// scaling uniformly afterward (this file) fixes that structurally: the
// font-size/card-width ratio in the output is now, by construction, the
// same ratio as in memory-card.tsx.
//
// Derivation of LOGICAL_CARD_WIDTH: the in-app timeline renders MemoryCard
// inside `cardItem` (app/(app)/(tabs)/timeline.tsx), which applies
// `paddingHorizontal: spacing.md` (16dp, src/constants/theme.ts) on both
// sides; the card itself carries no max-width cap, so its rendered width
// is `screenWidth - 2*16`. There's no single "the" screen width (that's
// the whole point of it being device-independent), so this picks a
// representative modern large-phone width -- 430dp, the width of the
// current iPhone Pro Max/Plus family (iPhone 14 Pro Max through 16 Pro
// Max/Plus) -- giving 430 - 32 = 398dp. That lands right in the ~390-400dp
// range the reported bug independently estimated ("in-app card ~400dp
// wide"), so it's used as a fixed logical width for every compose,
// regardless of the requesting device.
export const LOGICAL_CARD_WIDTH = 398;

export const SHARE_CARD_FULL_WIDTH = 1080;
export const SHARE_CARD_REDUCED_WIDTH = 720;

// Multiplies every logical (dp) value in layout.ts up to a raster pixel
// value. BASE_SCALE targets the primary 1080px-wide output; REDUCED_SCALE
// targets the 720px fallback output used by shouldUseReducedScale below --
// same LOGICAL_CARD_WIDTH, same layout, smaller final raster. Because both
// scales derive from the same logical width, REDUCED_SCALE / BASE_SCALE ==
// SHARE_CARD_REDUCED_WIDTH / SHARE_CARD_FULL_WIDTH == 2/3, so the 720px
// output is still the IDENTICAL layout at 2/3 size (S0 mandate), not a
// reflow -- see layout.test.ts's "identical layout at 2/3 size" test.
export const BASE_SCALE = SHARE_CARD_FULL_WIDTH / LOGICAL_CARD_WIDTH;
export const REDUCED_SCALE = SHARE_CARD_REDUCED_WIDTH / LOGICAL_CARD_WIDTH;

// ── Pixel-count budget (S0 mitigation) ──────────────────────────────────
// The gating spike measured that Supabase Edge Functions' WORKER_RESOURCE_LIMIT
// failures track TOTAL PIXEL COUNT of the rendered card (resvg's RGBA
// raster buffer), not caption length or photo bytes directly: ~87.5%
// per-attempt success at <=~2.5M px, 37.5% at 5.5M px. The fix is to render
// the identical layout at 720px width (2/3 scale of every dimension)
// instead of 1080px whenever the 1080-wide layout would exceed the budget
// -- never truncate the caption to fit. This check stays in OUTPUT
// (raster) pixel space, not logical dp space -- that's what the spike
// measured against.

/** Measured ceiling from the S0 spike (see header comment). */
export const SHARE_CARD_PIXEL_BUDGET = 2_500_000;

/**
 * Decides whether to re-render at REDUCED_SCALE, given the height (in
 * OUTPUT px) the card would be at `width` (1080 by default). Pure so the
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
