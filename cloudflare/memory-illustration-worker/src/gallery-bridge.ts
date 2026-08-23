import { callBridgeAt, BridgeError } from './bridge';
import type {
  BridgeGalleryAttemptResponse,
  BridgeGalleryChunkInputResponse,
  GalleryCandidateDraft,
  GallerySkipReason,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidBridgeResponse(): never {
  throw new BridgeError('BRIDGE_INVALID_RESPONSE', false);
}

function callGalleryBridge<T>(env: Env, operation: import('./types').BridgeOperation, payload: Record<string, unknown>): Promise<T> {
  return callBridgeAt<T>(
    env.GALLERY_SUPABASE_BRIDGE_URL,
    env.GALLERY_SUPABASE_BRIDGE_HMAC_SECRET,
    operation,
    payload,
  );
}

export async function getGalleryChunkInput(
  env: Env,
  chunkId: string,
): Promise<BridgeGalleryChunkInputResponse> {
  const response = await callGalleryBridge<unknown>(env, 'get_gallery_chunk_input', { chunkId });
  if (!isRecord(response) || !isRecord(response.chunk)) return invalidBridgeResponse();
  return response as unknown as BridgeGalleryChunkInputResponse;
}

export async function reserveGalleryAttempt(
  env: Env,
  payload: { chunkId: string; clusterSignature: string; attemptNumber: number },
): Promise<BridgeGalleryAttemptResponse> {
  const response = await callGalleryBridge<unknown>(env, 'reserve_gallery_attempt', payload);
  if (!isRecord(response) ||
    (response.outcome !== 'reserved_now' && response.outcome !== 'already_reserved' && response.outcome !== 'denied') ||
    (typeof response.attempt_id !== 'string' && response.attempt_id !== null) ||
    (typeof response.reservation_token !== 'string' && response.reservation_token !== null)) {
    return invalidBridgeResponse();
  }
  return {
    outcome: response.outcome,
    attemptId: response.attempt_id,
    reservationToken: response.reservation_token,
  };
}

export async function recordGalleryUsage(
  env: Env,
  payload: {
    chunkId: string;
    attemptId: string;
    reservationToken: string;
    usage: { success: boolean; providerStatus: 'completed' | 'failed' | 'ambiguous'; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  },
): Promise<void> {
  await callGalleryBridge<unknown>(env, 'record_gallery_usage', payload);
}

export async function markGalleryAttemptAmbiguous(
  env: Env,
  payload: { chunkId: string; attemptId: string; reservationToken: string },
): Promise<void> {
  await callGalleryBridge<unknown>(env, 'mark_gallery_attempt_ambiguous', payload);
}

export async function publishGalleryClusterResult(
  env: Env,
  payload: {
    chunkId: string;
    clusterSignature: string;
    candidates: GalleryCandidateDraft[];
    skipReason: GallerySkipReason | null;
  },
): Promise<void> {
  await callGalleryBridge<unknown>(env, 'publish_gallery_cluster_result', {
    ...payload,
    candidates: payload.candidates.map((candidate) => ({ ...candidate, clusterSignature: payload.clusterSignature })),
  });
}

export async function failGalleryChunk(
  env: Env,
  payload: { chunkId: string; errorCode: string },
): Promise<void> {
  await callGalleryBridge<unknown>(env, 'fail_gallery_chunk', payload);
}

export async function failGalleryCluster(
  env: Env,
  payload: { chunkId: string; clusterSignature: string; errorCode: string },
): Promise<void> {
  await callGalleryBridge<unknown>(env, 'fail_gallery_cluster', payload);
}

export async function scrubGalleryChunk(env: Env, chunkId: string): Promise<void> {
  await callGalleryBridge<unknown>(env, 'scrub_gallery_chunk', { chunkId });
}
