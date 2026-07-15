import * as VideoThumbnails from 'expo-video-thumbnails';

import { aspectRatioFromDimensions } from '@/utils/media-aspect';

export interface VideoFrame {
  uri: string;
  width: number;
  height: number;
}

/**
 * Extract the transformed first frame of a local video file. Measures the
 * transformed display frame rather than encoded track dimensions -- phone
 * videos can store portrait orientation as rotation metadata while the
 * encoded track itself remains landscape.
 *
 * Shared by getVideoAspectRatio (below) and the upload-time video poster
 * pipeline (uploadMemoryMediaAssets in src/services/memory-posting.ts) --
 * both need "the video's first frame, transform-corrected," and a native
 * frame decode is expensive enough that a video asset should only pay for
 * it once per upload, not twice.
 */
export async function getVideoFrame(uri: string): Promise<VideoFrame | null> {
  try {
    return await VideoThumbnails.getThumbnailAsync(uri, { time: 0 });
  } catch {
    return null;
  }
}

export async function getVideoAspectRatio(uri: string): Promise<number | null> {
  const frame = await getVideoFrame(uri);
  return frame ? aspectRatioFromDimensions(frame.width, frame.height) : null;
}
