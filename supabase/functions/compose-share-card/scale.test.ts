import { assertEquals } from 'jsr:@std/assert@1';
import {
  BASE_SCALE,
  LOGICAL_CARD_WIDTH,
  MIN_OUTPUT_SCALE,
  MIN_RASTER_WIDTH,
  parseSvgHeightPx,
  resolveShareCardOutputScale,
  resolveShareCardOutputWidthPx,
  SHARE_CARD_FULL_WIDTH,
  SHARE_CARD_PIXEL_BUDGET,
} from './scale.ts';

Deno.test('BASE_SCALE converts LOGICAL_CARD_WIDTH to exactly SHARE_CARD_FULL_WIDTH', () => {
  assertEquals(Math.round(LOGICAL_CARD_WIDTH * BASE_SCALE), SHARE_CARD_FULL_WIDTH);
});

Deno.test('MIN_OUTPUT_SCALE converts LOGICAL_CARD_WIDTH to exactly MIN_RASTER_WIDTH', () => {
  assertEquals(Math.round(LOGICAL_CARD_WIDTH * MIN_OUTPUT_SCALE), MIN_RASTER_WIDTH);
});

// ── resolveShareCardOutputScale: BASE cap for short cards ────────────────
// A card comfortably under budget must still render at EXACTLY the primary
// 1080px width -- the pixel-budget mitigation must never make a SHORT
// card's output bigger or smaller than before this rewrite.

Deno.test('resolveShareCardOutputScale: a short card (comfortably under budget even at BASE_SCALE) returns exactly BASE_SCALE, not something computed-but-coincidentally-equal', () => {
  // 398 * 500 * BASE_SCALE^2 = budget-comfortable at full width -- the
  // unclamped formula would ask for a scale ABOVE BASE_SCALE here (a
  // width wider than 1080px), which the Math.min clamp must reject.
  const shortLogicalHeight = 500;
  const unclampedIdeal = Math.sqrt(SHARE_CARD_PIXEL_BUDGET / (LOGICAL_CARD_WIDTH * shortLogicalHeight));
  assertEquals(unclampedIdeal > BASE_SCALE, true); // sanity: confirms this case actually exercises the BASE clamp
  assertEquals(resolveShareCardOutputScale(shortLogicalHeight), BASE_SCALE);
});

Deno.test('resolveShareCardOutputScale: exactly at the BASE_SCALE boundary (budget itself does not trip a reduction)', () => {
  // The exact logicalHeight where the unclamped formula equals BASE_SCALE:
  // budget / (W * h) == BASE_SCALE^2  =>  h == budget / (W * BASE_SCALE^2).
  const boundaryHeight = SHARE_CARD_PIXEL_BUDGET / (LOGICAL_CARD_WIDTH * BASE_SCALE * BASE_SCALE);
  assertEquals(resolveShareCardOutputScale(boundaryHeight), BASE_SCALE);
  // One logical unit taller must scale down (even if only fractionally) --
  // proves the boundary isn't accidentally wide/fuzzy.
  assertEquals(resolveShareCardOutputScale(boundaryHeight + 50) < BASE_SCALE, true);
});

// ── resolveShareCardOutputScale: continuous budget-fit math ─────────────

Deno.test('resolveShareCardOutputScale: matches the exact sqrt(budget / (width * height)) formula for a mid-range logical height', () => {
  const logicalHeight = 1800; // well past the BASE boundary, well short of the floor crossover
  const expected = Math.sqrt(SHARE_CARD_PIXEL_BUDGET / (LOGICAL_CARD_WIDTH * logicalHeight));
  assertEquals(expected < BASE_SCALE, true);
  assertEquals(expected > MIN_OUTPUT_SCALE, true);
  assertEquals(resolveShareCardOutputScale(logicalHeight), expected);
});

Deno.test('resolveShareCardOutputScale: the resulting (unrounded) pixel count is exactly the budget at a scale strictly between the two clamps', () => {
  const logicalHeight = 1800;
  const scale = resolveShareCardOutputScale(logicalHeight);
  const pixelCount = (LOGICAL_CARD_WIDTH * scale) * (logicalHeight * scale);
  // Exact in continuous (unrounded) space -- the clamp-free formula is
  // DERIVED by solving width*height == budget for scale, so this must hold
  // to float precision, not just "close."
  assertEquals(Math.abs(pixelCount - SHARE_CARD_PIXEL_BUDGET) < 1e-6, true);
});

Deno.test('resolveShareCardOutputScale: a taller logical height always yields a smaller (or equal) scale -- monotonic, no discontinuity', () => {
  const heights = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000, 3400, 4000, 5000];
  let previousScale = Infinity;
  for (const h of heights) {
    const scale = resolveShareCardOutputScale(h);
    assertEquals(scale <= previousScale, true, `expected scale to be non-increasing at logicalHeight=${h}`);
    previousScale = scale;
  }
});

// ── resolveShareCardOutputScale: quality floor (MIN_OUTPUT_SCALE) ───────

Deno.test('resolveShareCardOutputScale: floor clamp -- past the crossover height, scale never drops below MIN_OUTPUT_SCALE even though the raw formula would go lower', () => {
  // Crossover: budget / (W * h) == MIN_OUTPUT_SCALE^2 => h == budget / (W * MIN_OUTPUT_SCALE^2).
  const crossoverHeight = SHARE_CARD_PIXEL_BUDGET / (LOGICAL_CARD_WIDTH * MIN_OUTPUT_SCALE * MIN_OUTPUT_SCALE);

  const justPastCrossover = crossoverHeight + 50;
  const unclampedIdeal = Math.sqrt(SHARE_CARD_PIXEL_BUDGET / (LOGICAL_CARD_WIDTH * justPastCrossover));
  assertEquals(unclampedIdeal < MIN_OUTPUT_SCALE, true); // sanity: confirms this case actually exercises the floor clamp
  assertEquals(resolveShareCardOutputScale(justPastCrossover), MIN_OUTPUT_SCALE);

  // An even more extreme height must NOT push the scale any lower --
  // the floor is a hard floor, not just "smaller than before."
  assertEquals(resolveShareCardOutputScale(justPastCrossover * 3), MIN_OUTPUT_SCALE);
});

Deno.test('resolveShareCardOutputScale: exactly at the floor crossover boundary', () => {
  const crossoverHeight = SHARE_CARD_PIXEL_BUDGET / (LOGICAL_CARD_WIDTH * MIN_OUTPUT_SCALE * MIN_OUTPUT_SCALE);
  assertEquals(resolveShareCardOutputScale(crossoverHeight), MIN_OUTPUT_SCALE);
});

Deno.test('resolveShareCardOutputScale: defensive fallback to BASE_SCALE for a non-positive or invalid logical height (never divide by zero/NaN)', () => {
  assertEquals(resolveShareCardOutputScale(0), BASE_SCALE);
  assertEquals(resolveShareCardOutputScale(-100), BASE_SCALE);
});

Deno.test('resolveShareCardOutputScale: accepts a custom width/budget (unit-level, independent of the fixed production constants)', () => {
  // width=200, height=200, budget=90_000 => ideal = sqrt(90000/40000) = 1.5
  // -- chosen to land strictly between the (fixed, non-parameterized)
  // MIN_OUTPUT_SCALE/BASE_SCALE clamps, since those two are always derived
  // from the real LOGICAL_CARD_WIDTH/MIN_RASTER_WIDTH/SHARE_CARD_FULL_WIDTH
  // production constants regardless of the custom width/budget passed
  // here -- only the numerator (budget) and the WIDTH*HEIGHT product are
  // actually parameterized.
  assertEquals(resolveShareCardOutputScale(200, 200, 90_000), 1.5);
});

// ── "47-failure-class" regression (tail fix, docs/plans/
// share-card-store-through.md's four-part production fix) ────────────────
// Production backfill telemetry across 823 real targets: 47 failed 546
// DETERMINISTICALLY (6/6 attempts each -- impossible under the ~50%
// stochastic per-attempt rate the retry/warm machinery assumes). Pattern:
// whole carousels with long captions exceeded the platform's real budget
// even at the OLD fixed 720px fallback. SHARE_CARD_PIXEL_BUDGET dropped
// 2,500,000 -> 1,900,000 to match what real production successes actually
// run at, and the two-tier 1080/720 system was replaced with this file's
// continuous formula so scaling isn't capped at a single extra tier.
//
// HONEST result for validateMemoryContent's real 5000-char cap (measured
// against a real composeShareCardPng render in render.test.ts, NOT
// estimated here): logicalHeight ~4497, past the floor crossover (~3282
// logical units), so MIN_OUTPUT_SCALE binds and the OUTPUT can still
// exceed budget -- ~2.60M px, ~37% over. This test pins that same
// crossover-vs-cap relationship at the scale.ts math level (see
// render.test.ts's dedicated end-to-end test for the actual measured
// pixel numbers against a real render).
Deno.test('resolveShareCardOutputScale: a real 5000-char caption\'s measured logical height (~4497) sits PAST the floor crossover -- the budget guarantee is knowingly not held for this specific worst case', () => {
  const measuredLogicalHeightFor5000CharCaption = 4497; // this package's implementation report -- see render.test.ts's real end-to-end measurement
  const crossoverHeight = SHARE_CARD_PIXEL_BUDGET / (LOGICAL_CARD_WIDTH * MIN_OUTPUT_SCALE * MIN_OUTPUT_SCALE);

  assertEquals(measuredLogicalHeightFor5000CharCaption > crossoverHeight, true);
  assertEquals(resolveShareCardOutputScale(measuredLogicalHeightFor5000CharCaption), MIN_OUTPUT_SCALE);

  const width = resolveShareCardOutputWidthPx(MIN_OUTPUT_SCALE);
  const height = Math.round(measuredLogicalHeightFor5000CharCaption * MIN_OUTPUT_SCALE);
  assertEquals(width, MIN_RASTER_WIDTH);
  assertEquals(width * height > SHARE_CARD_PIXEL_BUDGET, true);

  // Still a real improvement over the OLD fixed-720 fallback for the SAME
  // logical height -- that comparison is the actual regression this
  // rewrite targets. Old: REDUCED_SCALE == 720/398 (no further floor).
  const oldReducedScale = 720 / LOGICAL_CARD_WIDTH;
  const oldHeight = Math.round(measuredLogicalHeightFor5000CharCaption * oldReducedScale);
  const oldPixelCount = 720 * oldHeight;
  assertEquals(oldPixelCount > width * height, true);
  // At least 2x fewer pixels than the old fixed-720 fallback would have
  // produced for the identical content -- the real measured ratio is
  // ~2.25x (render.test.ts).
  assertEquals(oldPixelCount / (width * height) >= 2, true);
});

// ── resolveShareCardOutputWidthPx ─────────────────────────────────────────

Deno.test('resolveShareCardOutputWidthPx: rounds to the nearest integer raster width', () => {
  assertEquals(resolveShareCardOutputWidthPx(BASE_SCALE), SHARE_CARD_FULL_WIDTH);
  assertEquals(resolveShareCardOutputWidthPx(MIN_OUTPUT_SCALE), MIN_RASTER_WIDTH);
});

// ── parseSvgHeightPx (unchanged) ─────────────────────────────────────────

Deno.test('parseSvgHeightPx reads the integer height attribute from a satori SVG root', () => {
  const svg = '<svg width="1080" height="2431" viewBox="0 0 1080 2431" xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  assertEquals(parseSvgHeightPx(svg), 2431);
});

Deno.test('parseSvgHeightPx returns null for a string with no height attribute', () => {
  assertEquals(parseSvgHeightPx('<svg><rect/></svg>'), null);
});
