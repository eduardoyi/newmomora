import { hmacSha256Hex } from './crypto';
import type {
  BridgeOperation,
  Env,
  EnsureShareTokensResponse,
  FailResponse,
  GenerationContextResponse,
  PublishResponse,
  ReconcileResponse,
} from './types';

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

/**
 * Signs and posts one bridge operation. Mirrors
 * cloudflare/memory-illustration-worker/src/bridge.ts's `callBridgeAt`
 * exactly (same HMAC construction: `${timestamp}.${nonce}.${rawBody}`,
 * same header names) -- see that file's own comment for why the operation
 * is folded into the signed body rather than a separate field a caller
 * could otherwise substitute.
 */
export async function callBridge<T>(
  env: Env,
  operation: BridgeOperation,
  payload: Record<string, unknown>,
): Promise<T> {
  const rawBody = JSON.stringify({ ...payload, operation });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = await hmacSha256Hex(
    env.SUPABASE_BRIDGE_HMAC_SECRET,
    `${timestamp}.${nonce}.${rawBody}`,
  );
  const response = await fetch(env.SUPABASE_BRIDGE_URL, {
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
    throw new BridgeError(
      response.status === 408 || response.status === 429 || response.status >= 500
        ? 'BRIDGE_UNAVAILABLE'
        : 'BRIDGE_REJECTED',
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }

  return await response.json() as T;
}

const BRIDGE_OPERATION_ATTEMPTS = 3;

/** Bounded retry for a retryable bridge failure, same policy as the
 * illustration worker's `callBridgeWithRetry` (100ms * attempt backoff). */
export async function callBridgeWithRetry<T>(
  env: Env,
  operation: BridgeOperation,
  payload: Record<string, unknown>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < BRIDGE_OPERATION_ATTEMPTS; attempt += 1) {
    try {
      return await callBridge<T>(env, operation, payload);
    } catch (error) {
      lastError = error;
      if (!(error instanceof BridgeError) || !error.retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidBridgeResponse(): never {
  throw new BridgeError('BRIDGE_INVALID_RESPONSE', false);
}

/**
 * Loads the book's frozen scope + every raw row the outline/manifest stages
 * need (memories, media, tags, milestones, engagement, family members,
 * portrait versions). The bridge itself re-verifies `attemptId` is still
 * the row's current `generation_attempt_id` and the row is still
 * `generating` before returning anything -- a superseded/failed attempt
 * bails here, cheaply, before any OpenAI call.
 */
export async function loadGenerationContext(
  env: Env,
  bookId: string,
  attemptId: string,
): Promise<GenerationContextResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'load_generation_context', { bookId, attemptId });
  if (!isRecord(response) || !isRecord(response.book) || !Array.isArray(response.memories)) {
    return invalidBridgeResponse();
  }
  return response as unknown as GenerationContextResponse;
}

export async function ensureShareTokens(
  env: Env,
  bookId: string,
  attemptId: string,
  memoryIds: string[],
): Promise<EnsureShareTokensResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'ensure_share_tokens', { bookId, attemptId, memoryIds });
  if (!isRecord(response) || !isRecord(response.tokensByMemoryId)) return invalidBridgeResponse();
  return response as unknown as EnsureShareTokensResponse;
}

export async function publishBook(
  env: Env,
  bookId: string,
  attemptId: string,
  bookDocument: unknown,
): Promise<PublishResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'publish', { bookId, attemptId, bookDocument });
  if (!isRecord(response) || typeof response.published !== 'boolean') return invalidBridgeResponse();
  return { published: response.published };
}

export async function failBook(
  env: Env,
  bookId: string,
  attemptId: string,
  failureReason: string,
): Promise<FailResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'fail', { bookId, attemptId, failureReason });
  if (!isRecord(response) || typeof response.failed !== 'boolean') return invalidBridgeResponse();
  return { failed: response.failed };
}

export async function reconcileBook(
  env: Env,
  bookId: string,
  attemptId: string,
): Promise<ReconcileResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'reconcile', { bookId, attemptId });
  const outcome = isRecord(response) ? response.outcome : null;
  if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'retry' && outcome !== 'superseded') {
    return invalidBridgeResponse();
  }
  return { outcome };
}
