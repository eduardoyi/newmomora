import * as VideoThumbnails from 'expo-video-thumbnails';
import { useEffect, useState } from 'react';

export interface VideoThumbnailResult {
  uri: string;
  width: number;
  height: number;
}

export function useVideoThumbnailResult(videoUrl: string | null | undefined) {
  const [thumbnail, setThumbnail] = useState<VideoThumbnailResult | null>(null);

  useEffect(() => {
    setThumbnail(null);
    if (!videoUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await VideoThumbnails.getThumbnailAsync(videoUrl, { time: 0 });
        if (!cancelled) setThumbnail(result);
      } catch {
        // Callers provide their own fallback when a thumbnail cannot be read.
      }
    })();
    return () => { cancelled = true; };
  }, [videoUrl]);

  return thumbnail;
}

export function useVideoThumbnail(videoUrl: string | null | undefined) {
  return useVideoThumbnailResult(videoUrl)?.uri ?? null;
}
