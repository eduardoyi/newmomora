import { hmacSha256Hex } from './crypto';
import type {
  BridgeAuthorizeUploadResponse,
  BridgeFailResponse,
  BridgeOperation,
  BridgeReserveAttemptResponse,
  BridgeRecordUploadCompleteResponse,
} from './types';

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export async function callBridgeAt<T>(
  bridgeUrl: string,
  bridgeSecret: string,
  operation: BridgeOperation,
  payload: Record<string, unknown>,
): Promise<T> {
  // The signed bridge action is authoritative. Payload fields must never be
  // able to replace it (for example a ledger's AI operation classification).
  const rawBody = JSON.stringify({ ...payload, operation });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = await hmacSha256Hex(
    bridgeSecret,
    `${timestamp}.${nonce}.${rawBody}`,
  );
  const response = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-workflow-timestamp': timestamp,
      'x-workflow-nonce': nonce,
      'x-workflow-signature': signature,
    },
    body: rawBody,
  });

  if (!response.ok) {
    // Bridge error bodies may contain internal detail; do not propagate or log them.
    throw new BridgeError(
      response.status === 408 || response.status === 429 || response.status >= 500
        ? 'BRIDGE_UNAVAILABLE'
        : 'BRIDGE_REJECTED',
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }

  return await response.json() as T;
}

export async function callBridge<T>(
  env: Env,
  operation: BridgeOperation,
  payload: Record<string, unknown>,
): Promise<T> {
  return await callBridgeAt<T>(
    env.SUPABASE_BRIDGE_URL,
    env.SUPABASE_BRIDGE_HMAC_SECRET,
    operation,
    payload,
  );
}

export async function reserveMemoryProviderAttempt(
  env: Env,
  payload: {
    jobId: string;
    usageRequestId: string;
    provider: 'primary' | 'fallback';
    model: 'gpt-image-2' | 'gpt-image-1.5';
    attemptNumber: number;
    aiCallId: string;
  },
): Promise<BridgeReserveAttemptResponse> {
  const response = await callBridge<unknown>(env, 'reserve_attempt', { ...payload, protocolVersion: 2 });
  if (!isRecord(response) || response.protocolVersion !== 2 ||
    (response.outcome !== 'reserved_now' && response.outcome !== 'already_reserved' && response.outcome !== 'denied')) {
    return invalidBridgeResponse();
  }
  return { outcome: response.outcome, protocolVersion: 2 };
}

export async function reserveMemoryProviderAttemptV1(
  env: Env,
  payload: {
    jobId: string;
    provider: 'primary' | 'fallback';
    model: 'gpt-image-2' | 'gpt-image-1.5';
    attemptNumber: number;
  },
): Promise<boolean> {
  const response = await callBridge<unknown>(env, 'reserve_attempt', payload);
  if (!isRecord(response)) return invalidBridgeResponse();
  if (typeof response.reserved === 'boolean') return response.reserved;
  if (response.protocolVersion === 2 &&
    (response.outcome === 'reserved_now' || response.outcome === 'already_reserved' || response.outcome === 'denied')) {
    return response.outcome === 'reserved_now';
  }
  return invalidBridgeResponse();
}

export async function recordMemoryUsage(env: Env, payload: Record<string, unknown>): Promise<void> {
  await callBridge<unknown>(env, 'record_usage', payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidBridgeResponse(): never {
  throw new BridgeError('BRIDGE_INVALID_RESPONSE', false);
}

export async function authorizeMemoryUpload(
  env: Env,
  jobId: string,
  outputKey: string,
): Promise<BridgeAuthorizeUploadResponse> {
  const response = await callBridge<unknown>(env, 'authorize_upload', { jobId, outputKey });
  if (!isRecord(response) ||
    typeof response.authorized !== 'boolean' ||
    (typeof response.uploadToken !== 'string' && response.uploadToken !== null) ||
    typeof response.existingLease !== 'boolean') {
    return invalidBridgeResponse();
  }
  return {
    authorized: response.authorized,
    uploadToken: response.uploadToken,
    existingLease: response.existingLease,
  };
}

export async function recordMemoryUploadComplete(
  env: Env,
  jobId: string,
  outputKey: string,
  uploadToken: string,
): Promise<BridgeRecordUploadCompleteResponse> {
  const response = await callBridge<unknown>(env, 'record_upload_complete', {
    jobId,
    outputKey,
    uploadToken,
  });
  if (!isRecord(response) || typeof response.completed !== 'boolean') return invalidBridgeResponse();
  return { completed: response.completed };
}

export async function failMemoryJob(
  env: Env,
  jobId: string,
  errorCode: string,
): Promise<BridgeFailResponse> {
  const response = await callBridge<unknown>(env, 'fail', { jobId, errorCode });
  if (!isRecord(response)) return invalidBridgeResponse();
  const outputKey = 'outputKey' in response ? response.outputKey : response.output_key;
  if (typeof response.failed !== 'boolean' ||
    (typeof outputKey !== 'string' && outputKey !== null) ||
    typeof response.deleteOutput !== 'boolean') {
    return invalidBridgeResponse();
  }
  return {
    failed: response.failed,
    outputKey,
    deleteOutput: response.deleteOutput,
  };
}
