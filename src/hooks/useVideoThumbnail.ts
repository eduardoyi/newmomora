import * as VideoThumbnails from 'expo-video-thumbnails';
import { useEffect, useState } from 'react';

export function useVideoThumbnail(videoUrl: string | null | undefined) {
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);

  useEffect(() => {
    if (!videoUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(videoUrl, { time: 0 });
        if (!cancelled) setThumbnailUri(uri);
      } catch {
        // silently fall through to icon fallback
      }
    })();
    return () => { cancelled = true; };
  }, [videoUrl]);

  return thumbnailUri;
}
