import { Platform } from 'react-native';
import { Video } from 'react-native-compressor';

import { isVideoContentType } from '@/utils/media-validation';

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

/**
 * Transcode a video to H.264 MP4 capped at VIDEO_UPLOAD_MAX_DIMENSION before
 * upload. Best-effort: images pass through untouched, and any compression
 * failure falls back to uploading the original file. Web uploads skip
 * compression (react-native-compressor is native-only).
 */
export async function compressVideoForUpload(
  media: UploadableMedia,
): Promise<UploadableMedia> {
  if (Platform.OS === 'web' || !isVideoContentType(media.contentType)) {
    return media;
  }

  try {
    const compressedUri = await Video.compress(media.fileUri, {
      compressionMethod: 'auto',
      maxSize: VIDEO_UPLOAD_MAX_DIMENSION,
    });

    if (!compressedUri) {
      return media;
    }

    return { ...media, fileUri: compressedUri, contentType: 'video/mp4' };
  } catch {
    return media;
  }
}
