// Aspect-ratio handling for memory media and illustrations. Containers size
// themselves to the media's natural ratio (clamped so extreme portrait or
// panorama shots don't take over the feed) instead of cropping to a fixed box.

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
