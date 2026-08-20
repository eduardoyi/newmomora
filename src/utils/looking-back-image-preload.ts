import { Image } from 'expo-image';

import type { MediaImageSource } from '@/utils/media-image-source';

const inFlightLoads = new Map<string, Promise<void>>();

function requestIdentity(source: MediaImageSource): string {
  // `cacheKey` identifies the reusable disk-cache entry, while the signed URI
  // identifies the native request that is currently authorized to fill it.
  // Keep both in the in-flight key so a URL refresh cannot join an older
  // request that may fail or be canceled independently.
  return JSON.stringify([source.cacheKey ?? null, source.uri]);
}

/**
 * Shares an exact in-flight native image request between the viewer warm-up
 * queue and the image that is currently mounted. iOS can otherwise receive
 * two SDWebImage requests during the intro → first frame transition and leave
 * the visible request without a completion event.
 */
export function preloadLookingBackImage(source: MediaImageSource): Promise<void> {
  const identity = requestIdentity(source);
  const existingLoad = inFlightLoads.get(identity);
  if (existingLoad) return existingLoad;

  const load = Promise.resolve()
    .then(() => Image.loadAsync(source))
    .then((imageRef) => {
      try {
        imageRef.release();
      } catch {
        // The cache fill succeeded; a late native release is harmless.
      }
    })
    .finally(() => {
      if (inFlightLoads.get(identity) === load) inFlightLoads.delete(identity);
    });

  inFlightLoads.set(identity, load);
  return load;
}

/** Test-only reset for pending shared loads between isolated test cases. */
export function resetLookingBackImagePreloadForTests(): void {
  inFlightLoads.clear();
}
