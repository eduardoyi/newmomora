// Aspect-ratio handling for memory media and illustrations. Media carousels
// preserve the first asset's natural ratio; illustration-only cards still use
// the clamp helpers so extreme generated images do not take over the feed.

export const DEFAULT_MEDIA_ASPECT_RATIO = 4 / 3;
export const MIN_MEDIA_ASPECT_RATIO = 3 / 4;
export const MAX_MEDIA_ASPECT_RATIO = 16 / 9;

export function aspectRatioFromDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): number | null {
  if (!width || !height || width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
}

export function clampMediaAspectRatio(ratio: number): number {
  return Math.min(MAX_MEDIA_ASPECT_RATIO, Math.max(MIN_MEDIA_ASPECT_RATIO, ratio));
}
