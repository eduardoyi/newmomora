import { notifyFamilyActivity } from '@/services/ai';
import { deleteStorageObject, uploadMediaObject } from '@/services/media';
import { createMediaMemory, type MemoryWithTags } from '@/services/memories';
import { getMediaExtensionFromContentType, isVideoContentType } from '@/utils/media-validation';
import { buildMemoryMediaAssetKey } from '@/utils/storage-keys';
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
}

export interface UploadedMemoryMediaAsset {
  objectKey: string;
  contentType: string;
  durationMs: number | null;
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

export function hasImageMediaAsset(assets: Array<{ contentType: string }>): boolean {
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
      };
    }

    if (!asset.fileUri) {
      throw new Error('Media file is missing');
    }

    // Videos are transcoded to ~720p H.264 MP4 on-device before upload
    // (best-effort; falls back to the original file), so the content type
    // and extension may differ from the picked asset.
    const upload = await compressVideoForUpload({
      fileUri: asset.fileUri,
      contentType: asset.contentType,
    });

    const extension = getMediaExtensionFromContentType(upload.contentType);
    if (!extension) {
      throw new Error('Unsupported file type');
    }

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
    onAssetUploaded?.();

    return {
      objectKey: mediaKey,
      contentType: upload.contentType,
      durationMs: asset.durationMs ?? null,
    };
  };

  return mapMediaUploads(assets, uploadAsset);
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
