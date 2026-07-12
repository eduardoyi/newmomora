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

    return { fileUri: compressedUri, contentType: 'video/mp4' };
  } catch {
    return media;
  }
}
