import * as VideoThumbnails from 'expo-video-thumbnails';
import { useEffect, useState } from 'react';

export interface VideoThumbnailResult {
  uri: string;
  width: number;
  height: number;
}

const thumbnailCache = new Map<string, VideoThumbnailResult>();
const pendingThumbnails = new Map<string, Promise<VideoThumbnailResult | null>>();
const MAX_CACHED_VIDEO_THUMBNAILS = 100;

function cacheThumbnail(cacheKey: string, result: VideoThumbnailResult) {
  if (!thumbnailCache.has(cacheKey) && thumbnailCache.size >= MAX_CACHED_VIDEO_THUMBNAILS) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (oldestKey) {
      thumbnailCache.delete(oldestKey);
    }
  }
  thumbnailCache.set(cacheKey, result);
}

async function generateThumbnail(
  videoUrl: string,
  cacheKey: string,
): Promise<VideoThumbnailResult | null> {
  const cached = thumbnailCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = pendingThumbnails.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = VideoThumbnails.getThumbnailAsync(videoUrl, { time: 0 })
    .then((result) => {
      cacheThumbnail(cacheKey, result);
      return result;
    })
    .catch(() => null)
    .finally(() => {
      pendingThumbnails.delete(cacheKey);
    });

  pendingThumbnails.set(cacheKey, request);
  return request;
}

export function clearVideoThumbnailCache() {
  thumbnailCache.clear();
  pendingThumbnails.clear();
}

export function useVideoThumbnailResult(
  videoUrl: string | null | undefined,
  cacheKey = videoUrl,
) {
  const [thumbnail, setThumbnail] = useState<VideoThumbnailResult | null>(() =>
    cacheKey ? thumbnailCache.get(cacheKey) ?? null : null,
  );

  useEffect(() => {
    const cached = cacheKey ? thumbnailCache.get(cacheKey) ?? null : null;
    setThumbnail(cached);
    if (!videoUrl || !cacheKey || cached) return;
    let cancelled = false;
    void (async () => {
      const result = await generateThumbnail(videoUrl, cacheKey);
      if (!cancelled && result) {
        setThumbnail(result);
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey, videoUrl]);

  return thumbnail;
}

export function useVideoThumbnail(
  videoUrl: string | null | undefined,
  cacheKey = videoUrl,
) {
  return useVideoThumbnailResult(videoUrl, cacheKey)?.uri ?? null;
}
