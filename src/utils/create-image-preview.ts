import * as ImageManipulator from 'expo-image-manipulator';

/**
 * Longest-edge cap for the derived list-view preview (Workstream C3,
 * performance-optimizations plan). Distinct from
 * `VIDEO_UPLOAD_MAX_DIMENSION` (video-compression.ts) even though both
 * currently use 1280 -- they cap different pipelines for different reasons
 * and are allowed to diverge independently.
 *
 * CROSS-REFERENCE: supabase/scripts/backfill-media-previews.ts mirrors this
 * exact value (`PREVIEW_MAX_DIMENSION`) for the server-side backfill of
 * previews on pre-existing photos. If this constant ever changes, change it
 * there too (see the comment on that file's constant).
 */
export const MEMORY_IMAGE_PREVIEW_MAX_DIMENSION = 1280;

/**
 * Preview compression quality -- lower than the EXIF-strip pass (0.92) since
 * this variant is only ever used at small list-view sizes.
 *
 * CROSS-REFERENCE: supabase/scripts/backfill-media-previews.ts mirrors this
 * as `PREVIEW_JPEG_QUALITY = 80` (sharp's 1-100 scale vs. this 0-1 scale --
 * 0.8 here == quality 80 there). Keep both in sync.
 */
export const MEMORY_IMAGE_PREVIEW_QUALITY = 0.8;

export interface ImagePreviewResult {
  fileUri: string;
  contentType: 'image/jpeg';
}

/**
 * Generates a bandwidth-friendly JPEG preview from an already EXIF-stripped
 * image, resized so its LONGEST edge is <= MEMORY_IMAGE_PREVIEW_MAX_DIMENSION
 * (width for landscape/square, height for portrait -- expo-image-manipulator
 * auto-computes the other dimension). Reuses the width/height
 * `stripImageMetadataForUpload` already computed -- do NOT call this with a
 * fresh `manipulateAsync` dimension probe; the whole point is avoiding a
 * second one.
 *
 * No-upscale guard: returns `null` when the source's longest edge is already
 * at or under the cap, or when dimensions are unknown. Originals are never
 * downscaled elsewhere in the app either (keepsake product) -- callers
 * should fall back to the original object key when this returns `null`.
 */
export async function createImagePreviewForUpload(params: {
  fileUri: string;
  width: number | null | undefined;
  height: number | null | undefined;
}): Promise<ImagePreviewResult | null> {
  const { fileUri, width, height } = params;

  if (!width || !height || width <= 0 || height <= 0) {
    return null;
  }

  const longestEdge = Math.max(width, height);
  if (longestEdge <= MEMORY_IMAGE_PREVIEW_MAX_DIMENSION) {
    return null;
  }

  const resize =
    width >= height
      ? { width: MEMORY_IMAGE_PREVIEW_MAX_DIMENSION }
      : { height: MEMORY_IMAGE_PREVIEW_MAX_DIMENSION };

  const result = await ImageManipulator.manipulateAsync(fileUri, [{ resize }], {
    compress: MEMORY_IMAGE_PREVIEW_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  return { fileUri: result.uri, contentType: 'image/jpeg' };
}

export interface VideoPosterResult {
  fileUri: string;
  contentType: 'image/jpeg';
}

/**
 * Generates the upload-time video poster JPEG from an already-extracted
 * first frame (see getVideoFrame in video-aspect-ratio.ts -- the same frame
 * grab that computes the video's aspect ratio, reused here so a video only
 * pays for one native decode). Same longest-edge cap and quality as
 * createImagePreviewForUpload, but deliberately NOT the same no-upscale
 * "return null" contract:
 *
 * Unlike a photo, an uploaded video has no acceptable "render the original
 * at full size" fallback for a list-view thumbnail -- the original is a
 * multi-second video, not a displayable image. The existing fallback for a
 * video with no poster is a runtime first-frame extraction against the
 * remote file (useVideoThumbnail), which is exactly the per-device
 * ranged-fetch-and-decode cost this feature exists to avoid. So this
 * function ALWAYS returns a poster -- even when the frame is already at or
 * under MEMORY_IMAGE_PREVIEW_MAX_DIMENSION, it still runs through
 * manipulateAsync (with no resize action) to get a real, quality-compressed
 * JPEG file to upload, rather than skipping and leaving preview_object_key
 * null.
 */
export async function createVideoPosterForUpload(params: {
  fileUri: string;
  width: number | null | undefined;
  height: number | null | undefined;
}): Promise<VideoPosterResult> {
  const { fileUri, width, height } = params;

  const actions: { resize: { width?: number; height?: number } }[] = [];
  if (width && height && width > 0 && height > 0) {
    const longestEdge = Math.max(width, height);
    if (longestEdge > MEMORY_IMAGE_PREVIEW_MAX_DIMENSION) {
      actions.push({
        resize:
          width >= height
            ? { width: MEMORY_IMAGE_PREVIEW_MAX_DIMENSION }
            : { height: MEMORY_IMAGE_PREVIEW_MAX_DIMENSION },
      });
    }
  }

  const result = await ImageManipulator.manipulateAsync(fileUri, actions, {
    compress: MEMORY_IMAGE_PREVIEW_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  return { fileUri: result.uri, contentType: 'image/jpeg' };
}
