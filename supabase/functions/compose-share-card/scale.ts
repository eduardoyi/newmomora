// Pure math for (a) the logical-to-raster scale that keeps the share card's
// typography/paddings proportioned like the in-app card, and (b) the
// pixel-count budget mitigation for Supabase Edge Functions'
// WORKER_RESOURCE_LIMIT (546) -- originally the S0-mandated two-tier
// 1080/720 fallback (docs/plans/offline-awareness-and-share-cards.md, S0 +
// S3), now CONTINUOUS scaling (docs/plans/share-card-store-through.md's
// four-part production fix, tail fix -- see SHARE_CARD_PIXEL_BUDGET and
// resolveShareCardOutputScale below for the full diagnosis/design).
//
// ── Logical card width (proportions fix) ────────────────────────────────
// layout.ts composes the card in LOGICAL units -- the same RN dp values as
// src/components/memory-card.tsx (font sizes, paddings, radii, avatar
// sizes, all copied verbatim) -- and only converts to raster pixels here,
// at the very end, via a scale factor. Previously the card was laid out
// directly at a 1080px width using those dp-scale magic numbers (e.g. a
// 14.5 "fontSize"), so a value sized for a ~400dp-wide card ended up ~1.5%
// of a 1080px-wide canvas instead of the in-app ~4% -- the "huge photo,
// tiny caption strip" bug. Composing in logical units first and scaling
// uniformly afterward (this file) fixes that structurally: the
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

/** Width (in OUTPUT px) of the FIRST satori pass -- used purely to MEASURE
 * the card's logical height (a card must be laid out at SOME width before
 * satori can tell you how tall it wrapped to). This is also the ceiling
 * every compose's actual output width is capped at -- see
 * resolveShareCardOutputScale's `Math.min(BASE_SCALE, ...)` clamp: a short
 * card's real (second, final) output width equals this exactly, same as
 * before this file moved to continuous scaling. */
export const SHARE_CARD_FULL_WIDTH = 1080;

/** Multiplies every logical (dp) value in layout.ts up to this file's
 * primary 1080px-wide raster scale -- the scale a short card (comfortably
 * under budget) renders at, unchanged from before. */
export const BASE_SCALE = SHARE_CARD_FULL_WIDTH / LOGICAL_CARD_WIDTH;

// ── Pixel-count budget (WORKER_RESOURCE_LIMIT mitigation) ───────────────
// The original S0 gating spike measured that Supabase Edge Functions'
// WORKER_RESOURCE_LIMIT failures track TOTAL PIXEL COUNT of the rendered
// card (resvg's RGBA raster buffer), not caption length or photo bytes
// directly, and picked a single 1080/720 two-tier fallback with a 2.5M-px
// budget from that spike's data.
//
// TAIL FIX (docs/plans/share-card-store-through.md's four-part production
// fix, backfill telemetry across 823 real targets): 771 stored
// successfully; 5 permanent 400s (legacy/invalid rows, expected, no
// action); 47 failed 546 DETERMINISTICALLY -- 6/6 attempts each, which is
// impossible under the ~50% STOCHASTIC per-attempt rate the retry/warm
// machinery was built around. Pattern: whole carousels failed together,
// the shared factor being long captions -- those cards exceeded the
// platform's REAL budget even at the 720px fallback. Two findings drove
// this rewrite:
//   1. The 2.5M budget itself was stale -- it came from the OLD spike;
//      every real production SUCCESS on the day of this telemetry ran at
//      or under ~1.9M px. Budget lowered to 1,900,000 to match reality.
//   2. A SINGLE extra fallback tier (720px) cannot scale to arbitrarily
//      long captions -- a caption long enough to blow the budget at 1080
//      can ALSO blow it at 720 (that's exactly what the 47 deterministic
//      failures were). The fix replaces the two-tier system with
//      CONTINUOUS scaling (resolveShareCardOutputScale below): the output
//      scale is computed directly from the measured logical height to
//      target the budget exactly, for any caption length -- not just the
//      one length the old 720px tier happened to help.
export const SHARE_CARD_PIXEL_BUDGET = 1_900_000;

/** Quality floor -- the narrowest this file will ever render, even if a
 * caption is so long that budget-fitting would call for something
 * narrower. Below this width, running text becomes hard to read on a
 * phone screen regardless of how the share was composed -- illegibility
 * is worse than the residual 546 risk, so the floor wins and the budget
 * is knowingly NOT guaranteed past it (see resolveShareCardOutputScale's
 * doc comment for the measured worst case this trades off against, and
 * docs/features/memory-sharing.md's Constraints section for the accepted
 * numbers). */
export const MIN_RASTER_WIDTH = 480;

/** The scale factor that produces exactly MIN_RASTER_WIDTH at
 * LOGICAL_CARD_WIDTH -- the floor `resolveShareCardOutputScale` clamps to. */
export const MIN_OUTPUT_SCALE = MIN_RASTER_WIDTH / LOGICAL_CARD_WIDTH;

/**
 * Computes the CONTINUOUS output scale (relative to LOGICAL_CARD_WIDTH)
 * that keeps the card's total raster pixel count (width × height) at or
 * under `budget`, given the card's LOGICAL height (dp units, i.e. what the
 * card would measure at scale 1 -- the caller derives this from a first
 * full-width satori pass: `logicalHeight = heightAtFullWidthPx /
 * BASE_SCALE`, see render.ts).
 *
 * Replaces the old two-tier `shouldUseReducedScale`/`REDUCED_SCALE`
 * mitigation (see this file's SHARE_CARD_PIXEL_BUDGET doc comment for the
 * production telemetry that motivated the rewrite). Solving
 * `outputScale^2 * logicalWidth * logicalHeight <= budget` for the largest
 * valid `outputScale` gives:
 *
 *   outputScale = sqrt(budget / (logicalWidth * logicalHeight))
 *
 * ...clamped on both ends:
 *   - Never ABOVE BASE_SCALE -- a short card (comfortably under budget
 *     even at the primary width) still renders at EXACTLY 1080px wide,
 *     unchanged from before this rewrite. This is why the clamp is
 *     `Math.min(BASE_SCALE, ...)`, not just the raw formula: for a small
 *     `logicalHeight`, the unclamped formula would call for an output
 *     WIDER than 1080px, which is not a real option (1080 is this
 *     pipeline's fixed primary width).
 *   - Never BELOW MIN_OUTPUT_SCALE (the MIN_RASTER_WIDTH floor) -- for an
 *     extreme enough `logicalHeight` (verified against the real numbers:
 *     the crossover is ~3282 logical units; a 5000-char caption, close to
 *     validateMemoryContent's cap, measures ~3400 logical tall) this means
 *     the OUTPUT pixel count can still exceed `budget` -- e.g. at
 *     logicalHeight=3400, the floor produces a 480x4101 output, ~1.97M px,
 *     ~3.6% over the 1.9M budget. This is an EXPLICIT, ACCEPTED risk
 *     (illegibly narrow text is worse), not an oversight -- see
 *     MIN_RASTER_WIDTH's doc comment. It is still dramatically better than
 *     the old two-tier system's failure mode for the same content: the old
 *     720px-fixed fallback did not scale down further for a caption this
 *     long, producing a MUCH larger (and, per telemetry, deterministically
 *     546-failing) raster.
 */
export function resolveShareCardOutputScale(
  logicalHeight: number,
  logicalWidth: number = LOGICAL_CARD_WIDTH,
  budget: number = SHARE_CARD_PIXEL_BUDGET,
): number {
  if (!(logicalHeight > 0) || !(logicalWidth > 0)) {
    // Defensive-only (a real satori-measured height is always positive) --
    // fail toward the primary scale rather than dividing by zero/NaN.
    return BASE_SCALE;
  }
  const idealScale = Math.sqrt(budget / (logicalWidth * logicalHeight));
  return Math.min(BASE_SCALE, Math.max(MIN_OUTPUT_SCALE, idealScale));
}

/** Rounds a logical width to the integer raster pixel width `scale`
 * produces -- the value render.ts passes to satori's second pass AND
 * resvg's `fitTo: { mode: 'width', ... }`. Integer, matching every other
 * raster dimension in this pipeline (satori/resvg both operate in whole
 * pixels). */
export function resolveShareCardOutputWidthPx(
  scale: number,
  logicalWidth: number = LOGICAL_CARD_WIDTH,
): number {
  return Math.round(logicalWidth * scale);
}

/** Extracts the integer height attribute satori embeds in its SVG output
 * root element (`<svg ... height="1234" ...>`). Returns null if the SVG
 * string doesn't match the expected shape (defensive -- callers should treat
 * null as "could not determine, skip the budget-fit scale decision"). */
export function parseSvgHeightPx(svg: string): number | null {
  const match = svg.match(/<svg[^>]*\sheight="(\d+(?:\.\d+)?)"/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
