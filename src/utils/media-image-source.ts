// expo-image caches by URI. R2 signed URLs rotate hourly (a fresh signature
// on every re-sign of the same underlying object), which orphans the disk
// cache on every re-sign even though the bytes already on disk are still
// correct for that object. Pinning `cacheKey` to the stable R2 object key
// keys the cache on the object's identity instead of its current signed
// URL, so a freshly re-signed URL for the same key still hits the disk
// cache -- this is what makes offline/cache-hit-rate work (Workstream O5,
// docs/plans/offline-awareness-and-share-cards.md).
//
// Only pass an `objectKey` at sites whose `uri` is an R2 signed URL
// (sourced from `useMediaUrl`/`useMediaUrls`/`getMediaUrl`). Sites
// rendering local `file://` URIs -- pickers, pending-upload previews,
// onboarding capture/reveal-before-upload -- must call this with no
// `objectKey` (or not use it at all): a locally-picked file has no stable
// R2 identity to pin against, and pinning one to the WRONG key would let
// unrelated bytes bleed into a cache slot. See docs/features/media-memories.md
// for the invariant this relies on: object keys are never reused/overwritten
// in place, so `cacheKey = objectKey` can never pin stale bytes.
export interface MediaImageSource {
  uri: string;
  cacheKey?: string;
}

/**
 * Builds an expo-image `source` object for an R2-backed image. `objectKey`
 * is optional so call sites can pass it through as-is (e.g. a nullable
 * `illustration_key`) without a separate presence check; the resulting
 * source simply omits `cacheKey` when there is no stable object key to pin
 * on (e.g. a local file URI, or a runtime-generated thumbnail with no R2
 * identity).
 */
export function mediaImageSource(uri: string, objectKey?: string | null): MediaImageSource {
  return objectKey ? { uri, cacheKey: objectKey } : { uri };
}
