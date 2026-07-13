import * as ImageManipulator from 'expo-image-manipulator';

import { aspectRatioFromDimensions } from '@/utils/media-aspect';
import { isVideoContentType } from '@/utils/media-validation';
import type { UploadableMedia } from '@/utils/video-compression';

/**
 * Re-encode quality for the EXIF-strip pass below. The picker already
 * exports library photos at JPEG quality 0.85 before this step ever runs
 * (Android's `CompressionImageExporter`, and iOS's `quality < 1` re-encode
 * path -- see `src/components/memory-media-picker.tsx` and
 * docs/features/media-memories.md), so re-encoding again at a *higher*
 * quality keeps this second, deliberate compression pass from adding
 * visible double-compression artifacts while still guaranteeing the output
 * carries no EXIF.
 */
export const MEMORY_IMAGE_STRIP_QUALITY = 0.92;

const OUTPUT_FORMAT_BY_CONTENT_TYPE: Record<string, ImageManipulator.SaveFormat> = {
  'image/jpeg': ImageManipulator.SaveFormat.JPEG,
  'image/png': ImageManipulator.SaveFormat.PNG,
  'image/webp': ImageManipulator.SaveFormat.WEBP,
  // expo-image-manipulator cannot write HEIC/HEIF -- re-encode to JPEG
  // instead. This is the one case where the stripped file's content type
  // (and therefore its storage extension) differs from what was picked.
  'image/heic': ImageManipulator.SaveFormat.JPEG,
  'image/heif': ImageManipulator.SaveFormat.JPEG,
};

const CONTENT_TYPE_BY_OUTPUT_FORMAT: Record<ImageManipulator.SaveFormat, string> = {
  [ImageManipulator.SaveFormat.JPEG]: 'image/jpeg',
  [ImageManipulator.SaveFormat.PNG]: 'image/png',
  [ImageManipulator.SaveFormat.WEBP]: 'image/webp',
};

/**
 * Strip EXIF/GPS/device metadata from an uploaded image by re-encoding it
 * through expo-image-manipulator, whose output never carries EXIF. This is
 * the fix for the pre-existing gap documented in
 * docs/features/media-memories.md and
 * docs/plans/media-exif-capture-date-prefill.md: Android's picker export
 * copies the source file's EXIF (including GPS) verbatim into the uploaded
 * JPEG. Videos pass through untouched -- their container metadata is out of
 * scope for this pass (see the same docs).
 *
 * Fail-closed by design: a `manipulateAsync` failure rejects instead of
 * silently falling back to the unstripped original. This is a privacy
 * control for child/family photos (GPS + device metadata), and the
 * pending-uploads queue already surfaces per-asset failures as a manual
 * Retry/Discard (`src/hooks/use-pending-memory-uploads.tsx`) rather than an
 * automatic retry loop, so failing here cannot strand the queue -- it just
 * means the memory doesn't post until the user retries or discards.
 */
export async function stripImageMetadataForUpload(
  media: UploadableMedia,
): Promise<UploadableMedia> {
  if (isVideoContentType(media.contentType)) {
    return media;
  }

  const format =
    OUTPUT_FORMAT_BY_CONTENT_TYPE[media.contentType] ?? ImageManipulator.SaveFormat.JPEG;

  const result = await ImageManipulator.manipulateAsync(media.fileUri, [], {
    compress: MEMORY_IMAGE_STRIP_QUALITY,
    format,
  });
  const aspectRatio = aspectRatioFromDimensions(result.width, result.height) ?? media.aspectRatio;

  return {
    fileUri: result.uri,
    contentType: CONTENT_TYPE_BY_OUTPUT_FORMAT[format],
    ...(aspectRatio ? { aspectRatio } : {}),
  };
}
