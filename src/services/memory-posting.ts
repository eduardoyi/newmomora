import { notifyFamilyActivity } from '@/services/ai';
import { deleteStorageObject, uploadMediaObject } from '@/services/media';
import { createMediaMemory, type MemoryWithTags } from '@/services/memories';
import { createImagePreviewForUpload, createVideoPosterForUpload } from '@/utils/create-image-preview';
import { getLocalFileSizeBytes } from '@/utils/local-files';
import { aspectRatioFromDimensions } from '@/utils/media-aspect';
import {
  getMediaExtensionFromContentType,
  isVideoContentType,
  MAX_VIDEO_BYTES,
} from '@/utils/media-validation';
import { buildMemoryMediaAssetKey } from '@/utils/storage-keys';
import { stripImageMetadataForUpload } from '@/utils/strip-image-metadata';
import { getVideoFrame } from '@/utils/video-aspect-ratio';
import { compressVideoForUpload } from '@/utils/video-compression';

const MEDIA_UPLOAD_CONCURRENCY = 3;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MemoryMediaMutationAsset {
  objectKey?: string;
  fileUri?: string;
  mediaAssetId?: string;
  contentType: string;
  durationMs?: number | null;
  aspectRatio?: number | null;
  /**
   * Existing preview key for a pass-through (already-uploaded) asset. Not
   * currently threaded through by any composer screen -- when omitted, the
   * `replace_memory_media_assets` RPC preserves the row's existing preview
   * key by matching `objectKey` (same precedent as `aspectRatio`; see
   * supabase/migrations/20260715140000_memory_media_preview_key.sql).
   */
  previewObjectKey?: string | null;
}

export interface UploadedMemoryMediaAsset {
  objectKey: string;
  contentType: string;
  durationMs: number | null;
  aspectRatio: number | null;
  /**
   * Derived bandwidth-friendly preview key: a resized JPEG for photos
   * (createImagePreviewForUpload, longest edge capped, `null` when already
   * at/under the cap -- no-upscale guard) or a first-frame poster JPEG for
   * videos (createVideoPosterForUpload, always generated when a frame could
   * be extracted). `null` for a failed preview/poster generation or upload
   * (fail-open -- never fails the memory post) or a video whose frame could
   * not be extracted at all.
   */
  previewObjectKey: string | null;
}

export interface PostMediaMemoryInput {
  memoryId: string;
  mediaAssets: MemoryMediaMutationAsset[];
  content?: string;
  memoryDate: string;
  taggedMemberIds: string[];
}

function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function getStorageMediaAssetId(mediaAssetId?: string): string {
  return mediaAssetId && UUID_PATTERN.test(mediaAssetId) ? mediaAssetId : createUuid();
}

/**
 * Authoritative post-compression size check. compressVideoForUpload already
 * fails the asset when it can't produce something within MAX_VIDEO_BYTES
 * from a fallback (see video-compression.ts), but this is the backstop for
 * the normal path too: react-native-compressor's 'auto' mode caps bitrate
 * well under the limit in practice, but this must not silently trust that --
 * an unusually long/high-motion clip that compresses over the cap has to
 * fail the asset here, before the PUT, rather than let the server's own
 * MAX_UPLOAD_BYTES (supabase/functions/upload-media/index.ts) reject it with
 * a less actionable error.
 */
async function assertVideoWithinUploadCap(fileUri: string): Promise<void> {
  const sizeBytes = await getLocalFileSizeBytes(fileUri);

  if (sizeBytes == null || sizeBytes > MAX_VIDEO_BYTES) {
    throw new Error('This video is too large to upload after compression. Try a shorter clip.');
  }
}

export function hasImageMediaAsset(assets: { contentType: string }[]): boolean {
  return assets.some((asset) => !isVideoContentType(asset.contentType));
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message);
  }

  return new Error(fallbackMessage);
}

async function mapMediaUploads<T>(
  assets: MemoryMediaMutationAsset[],
  uploadAsset: (asset: MemoryMediaMutationAsset) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(assets.length);
  let nextIndex = 0;
  let firstError: unknown = null;

  async function worker() {
    while (nextIndex < assets.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      try {
        results[currentIndex] = await uploadAsset(assets[currentIndex]);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  const workerCount = Math.min(MEDIA_UPLOAD_CONCURRENCY, assets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (firstError) {
    throw firstError;
  }

  return results;
}

/**
 * Compress (videos) and upload each new asset, MEDIA_UPLOAD_CONCURRENCY at a
 * time. Assets that already have an objectKey pass through untouched. Every
 * key this call uploads is pushed into `uploadedKeys` before any failure can
 * propagate, so callers can roll back partial uploads.
 */
export async function uploadMemoryMediaAssets(params: {
  userId: string;
  familyId: string;
  memoryId: string;
  assets: MemoryMediaMutationAsset[];
  uploadedKeys: string[];
  onAssetUploaded?: () => void;
}): Promise<UploadedMemoryMediaAsset[]> {
  const { userId, familyId, memoryId, assets, uploadedKeys, onAssetUploaded } = params;

  const uploadAsset = async (
    asset: MemoryMediaMutationAsset,
  ): Promise<UploadedMemoryMediaAsset> => {
    if (asset.objectKey) {
      onAssetUploaded?.();
      return {
        objectKey: asset.objectKey,
        contentType: asset.contentType,
        durationMs: asset.durationMs ?? null,
        aspectRatio: asset.aspectRatio ?? null,
        previewObjectKey: asset.previewObjectKey ?? null,
      };
    }

    if (!asset.fileUri) {
      throw new Error('Media file is missing');
    }

    // Videos are transcoded to ~720p H.264 MP4 on-device before upload
    // (falls back to the original file only when it already fits the
    // upload cap -- see video-compression.ts), so the content type and
    // extension may differ from the picked asset.
    const compressed = await compressVideoForUpload({
      fileUri: asset.fileUri,
      contentType: asset.contentType,
    });

    // Post-compression enforcement: the result (transcoded or fallback)
    // must fit MAX_VIDEO_BYTES before we spend a PUT on it. See
    // assertVideoWithinUploadCap above.
    if (isVideoContentType(compressed.contentType)) {
      await assertVideoWithinUploadCap(compressed.fileUri);
    }

    // Images are re-encoded to strip EXIF/GPS/device metadata before
    // upload (privacy control -- see strip-image-metadata.ts); videos pass
    // through untouched. HEIC/HEIF inputs come out as JPEG, which is why
    // extension/contentType below are derived from the *stripped* result,
    // not the picked asset.
    const upload = await stripImageMetadataForUpload(compressed);

    const extension = getMediaExtensionFromContentType(upload.contentType);
    if (!extension) {
      throw new Error('Unsupported file type');
    }

    const isVideo = isVideoContentType(upload.contentType);

    // Single frame grab for videos: video-aspect-ratio.ts's getVideoFrame is
    // used for BOTH the persisted aspect ratio and the upload-time poster
    // below, so a video asset only pays for one native frame decode, not
    // two (see that function's doc comment).
    const videoFrame = isVideo ? await getVideoFrame(upload.fileUri) : null;

    const aspectRatio = isVideo
      ? aspectRatioFromDimensions(videoFrame?.width, videoFrame?.height) ?? asset.aspectRatio ?? null
      : upload.aspectRatio ?? asset.aspectRatio ?? null;

    const mediaAssetId = getStorageMediaAssetId(asset.mediaAssetId);
    const mediaKey = buildMemoryMediaAssetKey(userId, memoryId, mediaAssetId, extension);
    const { error: uploadError } = await uploadMediaObject(
      mediaKey,
      upload.fileUri,
      upload.contentType,
      familyId,
    );

    if (uploadError) {
      throw toError(uploadError, 'Media upload failed');
    }

    uploadedKeys.push(mediaKey);

    // Preview/poster generation+upload: fail-open for both media kinds. A
    // failure here must never fail the memory post -- falls back to
    // `previewObjectKey: null`. Photos fall back to rendering the original
    // (C6); videos fall back to runtime first-frame extraction
    // (useVideoThumbnail).
    let previewObjectKey: string | null = null;
    if (isVideo) {
      if (videoFrame) {
        previewObjectKey = await uploadDerivedPreviewAsset({
          userId,
          familyId,
          memoryId,
          mediaAssetId,
          uploadedKeys,
          warningContext: 'Video poster',
          generatePreview: () =>
            createVideoPosterForUpload({
              fileUri: videoFrame.uri,
              width: videoFrame.width,
              height: videoFrame.height,
            }),
        });
      }
    } else {
      previewObjectKey = await uploadDerivedPreviewAsset({
        userId,
        familyId,
        memoryId,
        mediaAssetId,
        uploadedKeys,
        warningContext: 'Preview',
        generatePreview: () =>
          createImagePreviewForUpload({
            fileUri: upload.fileUri,
            width: upload.width,
            height: upload.height,
          }),
      });
    }

    onAssetUploaded?.();

    return {
      objectKey: mediaKey,
      contentType: upload.contentType,
      durationMs: asset.durationMs ?? null,
      aspectRatio,
      previewObjectKey,
    };
  };

  return mapMediaUploads(assets, uploadAsset);
}

/**
 * Generates and uploads a derived `{mediaAssetId}-preview.jpg` asset (same
 * directory as the original -- verified against
 * `MEMORY_MEDIA_ASSET_EXTENSION_PATTERN` in
 * supabase/functions/_shared/storage-keys.ts, which permits hyphens in the
 * asset-id segment). Shared by both derived-preview kinds:
 *  - photos: `generatePreview` is `createImagePreviewForUpload`, which can
 *    return `null` (no-upscale guard) -- this function passes that through.
 *  - videos: `generatePreview` is `createVideoPosterForUpload`, which never
 *    returns `null` (see that function's doc comment).
 *
 * Fail-open: any failure (generation or upload) is swallowed and returns
 * `null` rather than throwing, since a missing preview/poster is a
 * rendering fallback (original image, or runtime video-frame extraction),
 * not a data-loss risk. A successful upload is still pushed onto
 * `uploadedKeys` so a later failure elsewhere in the post rolls it back like
 * any other uploaded object.
 */
async function uploadDerivedPreviewAsset(params: {
  userId: string;
  familyId: string;
  memoryId: string;
  mediaAssetId: string;
  uploadedKeys: string[];
  warningContext: string;
  generatePreview: () => Promise<{ fileUri: string; contentType: 'image/jpeg' } | null>;
}): Promise<string | null> {
  const { userId, familyId, memoryId, mediaAssetId, uploadedKeys, warningContext, generatePreview } =
    params;

  try {
    const preview = await generatePreview();
    if (!preview) {
      return null;
    }

    const previewKey = buildMemoryMediaAssetKey(userId, memoryId, `${mediaAssetId}-preview`, 'jpg');
    const { error } = await uploadMediaObject(
      previewKey,
      preview.fileUri,
      preview.contentType,
      familyId,
    );

    if (error) {
      console.warn(`${warningContext} upload failed; falling back`, error.message);
      return null;
    }

    uploadedKeys.push(previewKey);
    return previewKey;
  } catch (error) {
    console.warn(
      `${warningContext} generation failed; falling back`,
      error instanceof Error ? error.message : 'unknown',
    );
    return null;
  }
}

/**
 * Full media-memory posting pipeline: upload every asset, then insert the
 * memory row. Rolls back any uploaded objects and throws on failure. Runs
 * detached from the composer screen so posting can continue after the user
 * returns to the timeline (see use-pending-memory-uploads).
 */
export async function postMediaMemory(params: {
  userId: string;
  familyId: string;
  input: PostMediaMemoryInput;
  onAssetUploaded?: () => void;
}): Promise<MemoryWithTags> {
  const { userId, familyId, input, onAssetUploaded } = params;
  const uploadedKeys: string[] = [];

  try {
    const mediaAssets = await uploadMemoryMediaAssets({
      userId,
      familyId,
      memoryId: input.memoryId,
      assets: input.mediaAssets,
      uploadedKeys,
      onAssetUploaded,
    });

    const { data, error } = await createMediaMemory({
      userId,
      familyId,
      memoryId: input.memoryId,
      mediaAssets,
      content: input.content,
      memoryDate: input.memoryDate,
      taggedMemberIds: input.taggedMemberIds,
    });

    if (error) {
      throw toError(error, 'Could not save memory');
    }

    return data as MemoryWithTags;
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => deleteStorageObject(key)));
    throw toError(error, 'Could not save memory');
  }
}

// Fire-and-forget family-activity push (plan §10). Never awaited by
// callers -- a failure here must not delay or fail the create-memory UX,
// so it's swallowed down to a console.warn.
export function notifyFamilyActivityFireAndForget(memoryId: string): void {
  void notifyFamilyActivity(memoryId)
    .then(({ error }) => {
      if (error) {
        console.warn('Failed to notify family of new memory', memoryId, error.message);
      }
    })
    .catch((error) => {
      console.warn(
        'Failed to notify family of new memory',
        memoryId,
        error instanceof Error ? error.message : 'unknown',
      );
    });
}
