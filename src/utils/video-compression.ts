import { Platform } from 'react-native';
import { Video } from 'react-native-compressor';

import { getLocalFileSizeBytes } from '@/utils/local-files';
import { isVideoContentType, MAX_VIDEO_BYTES } from '@/utils/media-validation';

/**
 * Longest edge for uploaded video, in pixels (≈720p). Camera-roll clips are
 * often 4K and 5-10x larger than needed for in-app playback.
 */
export const VIDEO_UPLOAD_MAX_DIMENSION = 1280;

export interface UploadableMedia {
  fileUri: string;
  contentType: string;
  aspectRatio?: number;
  /**
   * Natural dimensions of the current `fileUri`, when known. Populated by
   * `stripImageMetadataForUpload` from the re-encode it already performs
   * (see `src/utils/strip-image-metadata.ts`) so downstream steps -- e.g.
   * `createImagePreviewForUpload` -- can reuse them instead of an extra
   * `manipulateAsync` probe call. Not set for videos.
   */
  width?: number;
  height?: number;
}

export const VIDEO_COMPRESSION_TOO_LARGE_ERROR =
  'This video could not be compressed and is too large to upload. Try a shorter clip.';

/**
 * Compression failed or produced nothing usable. Historically this always
 * fell back to uploading the original file, which was safe because pick-time
 * validation already capped the original at MAX_VIDEO_BYTES (100MB). Now
 * that pick-time validation only sanity-caps the original at
 * MAX_VIDEO_SOURCE_BYTES (2GB -- see media-validation.ts), an unconditional
 * fallback could try to upload a multi-hundred-MB original straight past the
 * server's upload cap. So: fall back only when the original is already
 * within MAX_VIDEO_BYTES; otherwise fail the asset with a clear error. The
 * pending-uploads queue surfaces this as a per-asset Retry/Discard, same as
 * any other upload failure (see use-pending-memory-uploads.tsx).
 */
async function fallBackToOriginalOrThrow(media: UploadableMedia): Promise<UploadableMedia> {
  const originalSizeBytes = await getLocalFileSizeBytes(media.fileUri);

  if (originalSizeBytes != null && originalSizeBytes <= MAX_VIDEO_BYTES) {
    return media;
  }

  throw new Error(VIDEO_COMPRESSION_TOO_LARGE_ERROR);
}

/**
 * Transcode a video to H.264 MP4 capped at VIDEO_UPLOAD_MAX_DIMENSION before
 * upload. Best-effort: images pass through untouched. Web uploads skip
 * compression (react-native-compressor is native-only). See
 * fallBackToOriginalOrThrow for what happens when compression itself fails.
 */
export async function compressVideoForUpload(
  media: UploadableMedia,
): Promise<UploadableMedia> {
  if (Platform.OS === 'web' || !isVideoContentType(media.contentType)) {
    return media;
  }

  let compressedUri: string | null | undefined;
  try {
    compressedUri = await Video.compress(media.fileUri, {
      compressionMethod: 'auto',
      maxSize: VIDEO_UPLOAD_MAX_DIMENSION,
    });
  } catch {
    return fallBackToOriginalOrThrow(media);
  }

  if (!compressedUri) {
    return fallBackToOriginalOrThrow(media);
  }

  return { ...media, fileUri: compressedUri, contentType: 'video/mp4' };
}
