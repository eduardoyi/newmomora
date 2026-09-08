import { hmacSha256Hex } from './crypto';
import type {
  BridgeOperation,
  Env,
  LoadOrderResponse,
  MarkFailedResponse,
  MarkSubmittedResponse,
  SendOrderEmailResponse,
  VerifyAndPresignOutputResponse,
} from './types';

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

/** Signs and posts one bridge operation -- identical construction to
 * cloudflare/memory-book-worker/src/bridge.ts's `callBridge` (same HMAC
 * scheme, same header names). */
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

/** Bounded retry for a retryable bridge failure -- same policy as
 * memory-book-worker's `callBridgeWithRetry` (100ms * attempt backoff). */
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

export async function loadOrder(env: Env, orderId: string, attemptId: string): Promise<LoadOrderResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'load_order', { orderId, attemptId });
  if (!isRecord(response) || !isRecord(response.order) || typeof response.order.id !== 'string') {
    return invalidBridgeResponse();
  }
  return response as unknown as LoadOrderResponse;
}

export async function verifyAndPresignOutput(
  env: Env,
  orderId: string,
  attemptId: string,
  interiorKey: string,
  coverKey: string,
): Promise<VerifyAndPresignOutputResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'verify_and_presign_output', { orderId, attemptId, interiorKey, coverKey });
  if (!isRecord(response) || typeof response.interiorUrl !== 'string' || typeof response.coverUrl !== 'string') {
    return invalidBridgeResponse();
  }
  return response as unknown as VerifyAndPresignOutputResponse;
}

export async function markSubmitted(env: Env, orderId: string, attemptId: string, prodigiOrderId: string): Promise<MarkSubmittedResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'mark_submitted', { orderId, attemptId, prodigiOrderId });
  if (!isRecord(response) || typeof response.submitted !== 'boolean') return invalidBridgeResponse();
  return { submitted: response.submitted };
}

export async function markFailed(env: Env, orderId: string, attemptId: string, failureReason: string): Promise<MarkFailedResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'mark_failed', { orderId, attemptId, failureReason });
  if (!isRecord(response) || typeof response.failed !== 'boolean') return invalidBridgeResponse();
  return { failed: response.failed };
}

/** Best-effort by design -- a failed email send must never itself fail the
 * Workflow (the order is already submitted, or already correctly marked
 * failed; an email is a notification, not a state transition). Callers
 * catch and log rather than letting this propagate. */
export async function sendOrderEmail(
  env: Env,
  orderId: string,
  emailKind: 'paid_confirmation' | 'owner_alarm',
  detail?: string,
  pdfLinks?: { interiorUrl?: string; coverUrl?: string },
): Promise<SendOrderEmailResponse> {
  const response = await callBridgeWithRetry<unknown>(env, 'send_order_email', { orderId, emailKind, detail, pdfLinks });
  if (!isRecord(response) || typeof response.sent !== 'boolean') return invalidBridgeResponse();
  return { sent: response.sent };
}
