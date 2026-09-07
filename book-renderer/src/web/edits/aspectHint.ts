/**
 * A pre-save "this photo's proportions don't match this slot" hint for the
 * picker sheet, built ONLY from `aspect_ratio` (plan Step 6: "too-small
 * hint from aspect_ratio") — `picker_pool` is deliberately keys-only (no
 * pixel dimensions; see `memory-book-edits/index.ts`'s own doc comment),
 * so the REAL trust-gate warning (measured pixel dimensions vs. a
 * template's full-bleed/panorama minimums) can only be known server-side,
 * at `save_edit` time (Design Decision 7) — a too-small-in-PIXELS photo is
 * still accepted and simply demoted/reflowed honestly by the real fitter on
 * next render, never silently hidden. This is a lighter, honest PROXY:
 * `PhotoSlotContent.targetAspect` is the crop-box aspect the fitter already
 * chose for the slot being replaced (Stage C crop conservatism, same
 * ±20% tolerance `looseFit` uses) — a candidate far outside that tolerance
 * will crop awkwardly or trip `looseFit`'s letterbox treatment even before
 * any pixel-count question comes up.
 */
export function aspectMismatchHint(candidateAspect: number | null, targetAspect: number | null): string | null {
  if (candidateAspect == null || targetAspect == null || targetAspect <= 0) return null;
  const ratio = candidateAspect / targetAspect;
  const TOLERANCE = 0.2; // Matches PhotoSlotContent.looseFit's documented ±20% crop-box tolerance.
  if (ratio < 1 - TOLERANCE || ratio > 1 + TOLERANCE) {
    return 'This photo’s proportions are quite different from this spot — it may crop tightly or the page may re-arrange.';
  }
  return null;
}
