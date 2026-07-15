// Preview-key resolution for list-view media surfaces (Workstream C6,
// performance-optimizations plan). Detail/full-screen surfaces always use
// the original object_key -- these helpers are for MemoryCard media,
// calendar MemoryStamp, and the family member profile's MemoryThumb only.

interface MediaAssetKeyPair {
  object_key: string;
  preview_object_key?: string | null;
}

/**
 * Resolves the display key for one media asset. When `preferPreview` is
 * true, returns the derived preview key when present, falling back to the
 * original -- covers legacy rows (no backfill in this pass), videos (never
 * get a preview), the no-upscale guard, and a failed preview upload
 * (fail-open). When `preferPreview` is false, always returns the original.
 */
export function resolveMediaDisplayKey(
  asset: MediaAssetKeyPair,
  preferPreview: boolean,
): string {
  if (preferPreview && asset.preview_object_key) {
    return asset.preview_object_key;
  }
  return asset.object_key;
}

/**
 * Same preference as resolveMediaDisplayKey, but for call sites (calendar
 * MemoryStamp, family member MemoryThumb) that resolve a single "cover"
 * asset with a legacy `memories.media_key` fallback when no memory_media
 * row exists at all.
 */
export function resolvePreferredCoverKey(
  coverAsset: MediaAssetKeyPair | undefined,
  legacyMediaKey: string | null,
): string | null {
  if (coverAsset) {
    return resolveMediaDisplayKey(coverAsset, true);
  }
  return legacyMediaKey;
}

/**
 * Resolves a VIDEO asset's stored poster key (a first-frame JPEG generated
 * at upload time, see createVideoPosterForUpload/getVideoFrame in
 * src/utils/create-image-preview.ts and src/services/memory-posting.ts),
 * for use anywhere a paused/inactive video thumbnail is shown: timeline
 * MemoryCard (via MemoryMediaCarousel), calendar MemoryStamp, and the family
 * member profile's MemoryThumb.
 *
 * Deliberately separate from resolveMediaDisplayKey/resolvePreferredCoverKey:
 * a video's actual playback source must always stay `object_key` (a poster
 * is a JPEG, not a playable video), so this never substitutes for the
 * display/source key -- callers fetch this key ADDITIONALLY, purely for the
 * thumbnail affordance, and fall back to runtime extraction
 * (useVideoThumbnail against the real video URL) when it's null: a legacy
 * row predating this feature, a row not yet covered by
 * backfill-video-posters.ts, or a failed upload-time poster (fail-open).
 */
export function resolveVideoPosterKey(asset: MediaAssetKeyPair | undefined): string | null {
  return asset?.preview_object_key ?? null;
}
