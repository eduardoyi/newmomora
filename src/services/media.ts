import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

export interface ServiceError {
  message: string;
  code?: string;
}

export interface GetUploadUrlResponse {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export interface GetMediaUrlResponse {
  urls: Record<string, string>;
  expiresIn: number;
}

export interface UploadMediaResponse {
  objectKey: string;
  success: true;
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;

function mapFunctionError(error: { message: string; context?: { status?: number } }): ServiceError {
  return {
    message: error.message,
    code: error.context?.status ? String(error.context.status) : undefined,
  };
}

async function mapResponseError(response: Response): Promise<ServiceError> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      return {
        message: body.error,
        code: typeof body.code === 'string' ? body.code : String(response.status),
      };
    }
  } catch {
    // Fall through to generic status-based message.
  }

  return {
    message: 'Media upload failed',
    code: String(response.status),
  };
}

async function getUploadFunctionHeaders(
  objectKey: string,
  contentType: string,
  familyId: string,
): Promise<{ headers: Record<string, string>; error: ServiceError | null }> {
  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  if (error || !token) {
    return {
      headers: {},
      error: {
        message: error?.message ?? 'You must be signed in to upload media',
        code: 'unauthorized',
      },
    };
  }

  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'x-object-key': objectKey,
      'x-family-id': familyId,
    },
    error: null,
  };
}

function getUploadFunctionUrl(): string {
  if (!supabaseUrl) {
    throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL');
  }

  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/upload-media`;
}

export async function getUploadUrl(
  objectKey: string,
  contentType: string,
  familyId: string,
): Promise<{ data: GetUploadUrlResponse | null; error: ServiceError | null }> {
  const { data, error } = await supabase.functions.invoke<GetUploadUrlResponse>('get-upload-url', {
    body: { objectKey, contentType, familyId },
  });

  if (error) {
    return { data: null, error: mapFunctionError(error) };
  }

  if (!data?.uploadUrl) {
    return { data: null, error: { message: 'Upload URL was not returned' } };
  }

  return { data, error: null };
}

// ── getMediaUrls request coalescing ─────────────────────────────────────────
// The family/timeline screens can mount dozens of MemoryThumb rows at once,
// each calling useMediaUrl -> getMediaUrls with its own key. Without
// coalescing, that's one 'get-media-url' Edge Function invocation per row.
// This batches every getMediaUrls call made within BATCH_WINDOW_MS into as
// few Edge Function invocations as possible: keys are deduped across callers
// and chunked at MAX_BATCH_KEYS (mirrors the server's MAX_KEYS), and each
// caller gets back the merged result for whichever chunk(s) its keys landed
// in -- same { data, error } shape a direct call would have returned.
const MAX_BATCH_KEYS = 50;
const BATCH_WINDOW_MS = 25;

type GetMediaUrlsResult = { data: GetMediaUrlResponse | null; error: ServiceError | null };

interface PendingMediaUrlCaller {
  keys: string[];
  resolve: (result: GetMediaUrlsResult) => void;
}

let pendingKeys: Set<string> | null = null;
let pendingCallers: PendingMediaUrlCaller[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/** Test-only: clears in-flight batcher state between test cases. */
export function resetMediaUrlBatcherForTests(): void {
  if (batchTimer) {
    clearTimeout(batchTimer);
  }
  pendingKeys = null;
  pendingCallers = [];
  batchTimer = null;
}

async function invokeMediaUrlChunk(
  keys: string[],
): Promise<{ data: GetMediaUrlResponse | null; error: ServiceError | null }> {
  const { data, error } = await supabase.functions.invoke<GetMediaUrlResponse>('get-media-url', {
    body: { keys },
  });

  if (error) {
    return { data: null, error: mapFunctionError(error) };
  }

  if (!data?.urls) {
    return { data: null, error: { message: 'Media URLs were not returned' } };
  }

  return { data, error: null };
}

// ── Omitted-key self-heal (production gray-box incident) ───────────────────
// get-media-url resolves each key against its OWNING ROW's CURRENT state
// (resolveReferencedStorageKeys, get-media-url/index.ts) and OMITS -- never
// errors -- any key it can't yet resolve/authorize/see-as-referenced. A key
// requested the instant after its row commits (a fresh memory_media insert,
// or a memory's illustration_key just having been set by the async
// pipeline) can lose that visibility race and come back omitted even though
// the row is genuinely fine a moment later -- indistinguishable, from this
// client's point of view, from a key that's truly gone (the incident that
// motivated the server's per-key tolerance in the first place). Before this
// fix, useMediaUrls' react-query layer had no way to tell the two apart: an
// omitted key is still a 200 SUCCESS response, so it was cached for the full
// 50-minute staleTime with zero retry -- a real gray box in the current
// session, healed only by an app restart (fresh queryClient). Retrying just
// the OMITTED SUBSET a few times with a short backoff, INSIDE the batcher,
// before ever resolving the caller, gives the common case (a row that
// committed a few hundred ms ago) a real chance to resolve -- and still
// falls through to the same omission-as-before behavior for a key that's
// genuinely gone, just a bounded ~1.4s later instead of instantly.
//
// Client-only fix (src/services/media.ts): ships to already-installed apps
// only via an EAS OTA update, not a server deploy -- get-media-url itself is
// unchanged.
const MISSING_KEY_MAX_ATTEMPTS = 3;
/** Backoff BEFORE each retry -- index 0 is the wait before attempt 2, index
 * 1 the wait before attempt 3. Short relative to share-card.ts's
 * SHARE_CARD_WARM_RETRY_BACKOFF_MS: this races ordinary DB write/read
 * visibility (typically resolved within one round trip), not Supabase
 * Edge's WORKER_RESOURCE_LIMIT policing window. */
const MISSING_KEY_RETRY_BACKOFF_MS: readonly number[] = [300, 600];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findMissingKeys(requestedKeys: string[], urls: Record<string, string>): string[] {
  return requestedKeys.filter((key) => !(key in urls));
}

/**
 * Retries `missingKeys` (a chunk's omitted subset) up to
 * `MISSING_KEY_MAX_ATTEMPTS` total attempts, narrowing to whatever's still
 * missing after each attempt. Returns whatever it managed to resolve --
 * anything still missing when attempts run out (or a retry itself errors)
 * is simply absent from the returned map, same as the original omission.
 */
async function resolveMissingKeysWithRetries(
  missingKeys: string[],
): Promise<Record<string, string>> {
  let remaining = missingKeys;
  const resolvedUrls: Record<string, string> = {};

  for (let attempt = 2; attempt <= MISSING_KEY_MAX_ATTEMPTS && remaining.length > 0; attempt++) {
    await delay(MISSING_KEY_RETRY_BACKOFF_MS[attempt - 2]);

    const result = await invokeMediaUrlChunk(remaining);
    if (result.error || !result.data) {
      // A retry that itself errors isn't worth compounding retries on top
      // of -- stop and let whatever's still missing fall through as an
      // omission, same as the pre-fix behavior.
      break;
    }

    Object.assign(resolvedUrls, result.data.urls);
    remaining = findMissingKeys(remaining, result.data.urls);
  }

  return resolvedUrls;
}

async function flushMediaUrlBatch(): Promise<void> {
  const keys = pendingKeys ? Array.from(pendingKeys) : [];
  const callers = pendingCallers;
  pendingKeys = null;
  pendingCallers = [];
  batchTimer = null;

  if (keys.length === 0 || callers.length === 0) {
    return;
  }

  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += MAX_BATCH_KEYS) {
    chunks.push(keys.slice(i, i + MAX_BATCH_KEYS));
  }

  const chunkIndexByKey = new Map<string, number>();
  chunks.forEach((chunk, index) => {
    chunk.forEach((key) => chunkIndexByKey.set(key, index));
  });

  // invokeMediaUrlChunk normally resolves with { data, error } rather than
  // throwing, but an unexpected exception (network abort, serialization bug)
  // must still settle every pending caller -- otherwise their promises never
  // resolve and the 'media-urls' queries hang in fetching with no error or
  // retry. Before batching, such a throw propagated to the caller.
  let chunkResults: GetMediaUrlsResult[];
  try {
    chunkResults = await Promise.all(chunks.map((chunk) => invokeMediaUrlChunk(chunk)));
  } catch (error) {
    const serviceError: ServiceError = {
      message: error instanceof Error ? error.message : 'Failed to load media URLs',
    };
    for (const caller of callers) {
      caller.resolve({ data: null, error: serviceError });
    }
    return;
  }

  // Self-heal each chunk's omitted keys (see the block comment above)
  // BEFORE merging results into caller responses -- a caller must never
  // observe the pre-retry, incomplete result.
  await Promise.all(
    chunks.map(async (chunk, index) => {
      const result = chunkResults[index];
      if (result.error || !result.data) {
        return;
      }

      const missing = findMissingKeys(chunk, result.data.urls);
      if (missing.length === 0) {
        return;
      }

      const recovered = await resolveMissingKeysWithRetries(missing);
      Object.assign(result.data.urls, recovered);
    }),
  );

  for (const caller of callers) {
    const relevantChunkIndexes = new Set(
      caller.keys
        .map((key) => chunkIndexByKey.get(key))
        .filter((index): index is number => index !== undefined),
    );

    let firstError: ServiceError | null = null;
    let expiresIn: number | undefined;
    const mergedUrls: Record<string, string> = {};

    for (const chunkIndex of relevantChunkIndexes) {
      const result = chunkResults[chunkIndex];
      if (result.error || !result.data) {
        firstError = firstError ?? result.error ?? { message: 'Media URLs were not returned' };
        continue;
      }

      Object.assign(mergedUrls, result.data.urls);
      expiresIn = result.data.expiresIn;
    }

    if (firstError) {
      caller.resolve({ data: null, error: firstError });
    } else {
      caller.resolve({ data: { urls: mergedUrls, expiresIn: expiresIn ?? 0 }, error: null });
    }
  }
}

export async function getMediaUrls(
  keys: string[],
): Promise<{ data: GetMediaUrlResponse | null; error: ServiceError | null }> {
  // Preserve the un-batched, un-deduped behavior for the empty-keys edge
  // case -- there's nothing to coalesce, and the Edge Function's own
  // validation error ("keys must be a non-empty array") should still surface.
  if (keys.length === 0) {
    return invokeMediaUrlChunk(keys);
  }

  return new Promise<GetMediaUrlsResult>((resolve) => {
    if (!pendingKeys) {
      pendingKeys = new Set();
    }
    for (const key of keys) {
      pendingKeys.add(key);
    }
    pendingCallers.push({ keys, resolve });

    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        void flushMediaUrlBatch();
      }, BATCH_WINDOW_MS);
    }
  });
}

export async function uploadMediaObject(
  objectKey: string,
  fileUri: string,
  contentType: string,
  familyId: string,
): Promise<{ data: UploadMediaResponse | null; error: ServiceError | null }> {
  const { headers, error: authError } = await getUploadFunctionHeaders(
    objectKey,
    contentType,
    familyId,
  );
  if (authError) {
    return { data: null, error: authError };
  }

  const uploadUrl = getUploadFunctionUrl();

  if (Platform.OS === 'web') {
    const fileResponse = await fetch(fileUri);
    const blob = await fileResponse.blob();

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: blob,
    });

    if (!uploadResponse.ok) {
      return { data: null, error: await mapResponseError(uploadResponse) };
    }

    return { data: await uploadResponse.json(), error: null };
  }

  const uploadResult = await FileSystem.uploadAsync(uploadUrl, fileUri, {
    httpMethod: 'POST',
    headers,
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    try {
      const body = JSON.parse(uploadResult.body);
      if (body && typeof body.error === 'string') {
        return {
          data: null,
          error: {
            message: body.error,
            code: typeof body.code === 'string' ? body.code : String(uploadResult.status),
          },
        };
      }
    } catch {
      // Fall through to generic status-based message.
    }

    return {
      data: null,
      error: {
        message: 'Media upload failed',
        code: String(uploadResult.status),
      },
    };
  }

  return {
    data: {
      objectKey,
      success: true,
    },
    error: null,
  };
}

export async function uploadToPresignedUrl(
  uploadUrl: string,
  fileUri: string,
  contentType: string,
): Promise<{ error: ServiceError | null }> {
  if (Platform.OS === 'web') {
    const response = await fetch(fileUri);
    const blob = await response.blob();

    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: blob,
    });

    if (!uploadResponse.ok) {
      return {
        error: {
          message: 'Photo upload failed',
          code: String(uploadResponse.status),
        },
      };
    }

    return { error: null };
  }

  const uploadResult = await FileSystem.uploadAsync(uploadUrl, fileUri, {
    httpMethod: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    return {
      error: {
        message: 'Photo upload failed',
        code: String(uploadResult.status),
      },
    };
  }

  return { error: null };
}

export async function deleteStorageObject(
  objectKey: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase.functions.invoke('delete-storage-object', {
    body: { objectKey },
  });

  if (error) {
    return { error: mapFunctionError(error) };
  }

  return { error: null };
}
