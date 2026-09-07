/**
 * Design Decision 9 (memory-book-5b plan, "Focal-point template wiring"):
 * turns an optional reposition-in-crop override into a CSS `object-position`
 * value. `null`/`undefined` (the fitter's own default, and every book that
 * has no such edit) returns `undefined` — React (including
 * `renderToStaticMarkup`, the print/preview/snapshot render path) omits an
 * `undefined` style property from the rendered output entirely, so this is
 * byte-identical to before the field existed. Wired into PhotoTile,
 * FullBleed, and PanoramaSpread only (+ the cover photo via its own params
 * path in WraparoundCover) — round-2 review of Decision 9 verified every
 * other photo-ish template renders illustrations/portraits through a
 * different slot-content type, out of scope here.
 */
export function objectPositionFor(focalPoint: { x: number; y: number } | null | undefined): string | undefined {
  if (!focalPoint) return undefined;
  return `${focalPoint.x * 100}% ${focalPoint.y * 100}%`;
}
