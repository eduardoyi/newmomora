import * as VideoThumbnails from 'expo-video-thumbnails';

import { aspectRatioFromDimensions } from '@/utils/media-aspect';

/**
 * Measure the transformed display frame rather than encoded track dimensions.
 * Phone videos can store portrait orientation as rotation metadata while the
 * encoded track itself remains landscape.
 */
export async function getVideoAspectRatio(uri: string): Promise<number | null> {
  try {
    const frame = await VideoThumbnails.getThumbnailAsync(uri, { time: 0 });
    return aspectRatioFromDimensions(frame.width, frame.height);
  } catch {
    return null;
  }
}
