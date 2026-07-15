export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Video limits are derived here, in one place, because pick-time validation
// (this file), on-device compression (video-compression.ts), and the
// upload path (memory-posting.ts) all need to agree on what "too big"
// means at each stage of the pipeline. See each constant's comment for its
// role and derivation.

/**
 * Max recording duration accepted at pick time (also the source of truth
 * for MAX_VIDEO_SOURCE_BYTES below). 180s / 3 minutes -- long enough for a
 * typical clip, short enough to keep MAX_VIDEO_SOURCE_BYTES's worst-case
 * math bounded.
 */
export const MAX_VIDEO_DURATION_MS = 180 * 1000;

/**
 * Pick-time sanity cap on the RAW/ORIGINAL file, before compression.
 *
 * Videos are compressed on-device before upload (video-compression.ts),
 * capping bitrate well under MAX_VIDEO_BYTES regardless of the source, so
 * this is deliberately *not* the upload limit -- it only exists to reject
 * implausible source files (e.g. ProRes) before spending time compressing
 * them.
 *
 * Derivation: MAX_VIDEO_DURATION_MS (180s) x a worst-realistic 4K/60 HEVC
 * capture bitrate (~7 MB/s, in line with iPhone's own on-device 4K60 HEVC
 * recording bitrate) = ~1.2GB. 2GB leaves headroom for bitrate variance
 * across devices/scenes without admitting ProRes-class sources -- ProRes
 * 4K/60 runs at roughly 500-700 Mbps, i.e. tens of GB for a 3-minute clip --
 * those stay blocked by design.
 */
export const MAX_VIDEO_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * POST-COMPRESSION / upload cap for videos. This is no longer checked at
 * pick time (see MAX_VIDEO_SOURCE_BYTES) -- it's enforced after
 * compressVideoForUpload returns, in src/services/memory-posting.ts, right
 * before the asset is PUT to R2.
 *
 * Must match MAX_UPLOAD_BYTES in
 * supabase/functions/upload-media/index.ts, the server-side cap for the
 * same upload. Kept in sync by hand (Deno edge functions can't import from
 * src/) -- change both together.
 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);

export const ALLOWED_VIDEO_CONTENT_TYPES = new Set(['video/mp4', 'video/quicktime']);

export const ALLOWED_MEDIA_CONTENT_TYPES = new Set([
  ...ALLOWED_IMAGE_CONTENT_TYPES,
  ...ALLOWED_VIDEO_CONTENT_TYPES,
]);

export interface ValidateMediaFileInput {
  sizeBytes: number | null | undefined;
  durationMs?: number | null;
  contentType: string;
}

export function isVideoContentType(contentType: string): boolean {
  return ALLOWED_VIDEO_CONTENT_TYPES.has(contentType);
}

export function validateMediaFile(input: ValidateMediaFileInput): string | null {
  if (!ALLOWED_MEDIA_CONTENT_TYPES.has(input.contentType)) {
    return 'Unsupported file type. Use JPEG, PNG, HEIC, WEBP, MP4, or MOV.';
  }

  if (input.sizeBytes == null || input.sizeBytes <= 0) {
    return 'Could not read file size. Try another photo or video.';
  }

  if (isVideoContentType(input.contentType)) {
    if (input.durationMs == null || input.durationMs <= 0) {
      return 'Could not read video duration. Try another clip.';
    }

    if (input.durationMs > MAX_VIDEO_DURATION_MS) {
      return 'Videos must be 3 minutes or shorter.';
    }

    // Pick-time check: a sanity cap on the raw/original file, not the
    // post-compression upload cap (MAX_VIDEO_BYTES) -- compression happens
    // later, in the upload path, which enforces that cap for real. See the
    // constant's comment above for the derivation.
    if (input.sizeBytes > MAX_VIDEO_SOURCE_BYTES) {
      return 'This video file is too large. Try recording a shorter clip or a lower camera quality.';
    }

    return null;
  }

  if (input.sizeBytes > MAX_IMAGE_BYTES) {
    return 'Photos must be 20 MB or smaller.';
  }

  return null;
}

export function getMediaExtensionFromContentType(contentType: string): string | null {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/heic':
    case 'image/heif':
      return 'heic';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    case 'video/quicktime':
      return 'mov';
    default:
      return null;
  }
}
