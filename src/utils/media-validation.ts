export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_DURATION_MS = 60 * 1000;

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
      return 'Videos must be 60 seconds or shorter.';
    }

    if (input.sizeBytes > MAX_VIDEO_BYTES) {
      return 'Videos must be 100 MB or smaller.';
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
