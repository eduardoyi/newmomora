/**
 * Reposition-gating threshold (owner-approved round-3 polish, item 1). When
 * a photo's own native aspect ratio is already close enough to the aspect
 * ratio it renders at on the page (the crop box the fitter chose for an
 * ordinary slot, or the front-cover panel's own approximate aspect for the
 * cover — see `EditOverlay.tsx`'s `COVER_APPROX_ASPECT`), `object-fit:
 * cover` trims a negligible sliver off one axis: there's nothing meaningful
 * left for a parent to reposition. Below the threshold the Reposition
 * affordance should be hidden (or rendered disabled) rather than offering a
 * control that visibly does nothing.
 *
 * Pure, DOM-free, and independently unit-tested — the actual gating
 * decision (which button to render/hide) lives in `EditOverlay.tsx`, which
 * feeds this module the two aspect ratios it already has on hand (fitted
 * `PhotoSlotContent.assetAspectRatio`/`.targetAspect`, or a manifest lookup
 * for the cover).
 */

/** "Small" per the polish-round brief: a photo within ~3% of its slot's own
 * aspect ratio crops (or letterboxes) by an amount no parent would notice or
 * benefit from adjusting. */
export const REPOSITION_ASPECT_DELTA_THRESHOLD = 0.03;

/**
 * Normalized magnitude of the crop delta between a photo's native aspect
 * ratio and the aspect ratio it renders at — `0` when they match exactly,
 * growing with how much of the image `object-fit: cover` must trim to fill
 * the slot. Returns `0` (never NaN/Infinity) for any non-positive input,
 * which `needsReposition` below treats as "fail open" (never hides a real
 * control over bad data).
 */
export function croppingDelta(photoAspect: number, slotAspect: number): number {
  if (!(photoAspect > 0) || !(slotAspect > 0)) return 0;
  return Math.abs(photoAspect / slotAspect - 1);
}

/**
 * Whether the Reposition affordance is worth offering for this photo/slot
 * pair. `null`/non-finite/non-positive aspect data (a genuinely unknown
 * case — e.g. the cover's photo isn't found in the manifest) fails OPEN,
 * i.e. still offers Reposition, rather than hiding a real control because
 * of a data gap this module can't distinguish from "no crop happening".
 */
export function needsReposition(
  photoAspect: number | null | undefined,
  slotAspect: number | null | undefined,
  threshold: number = REPOSITION_ASPECT_DELTA_THRESHOLD,
): boolean {
  if (photoAspect == null || slotAspect == null || !(photoAspect > 0) || !(slotAspect > 0)) return true;
  return croppingDelta(photoAspect, slotAspect) > threshold;
}
