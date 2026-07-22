import { hmacSha256Hex } from './crypto';
import type { BridgeOperation } from './types';

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export async function callBridge<T>(
  env: Env,
  operation: BridgeOperation,
  payload: Record<string, unknown>,
): Promise<T> {
  const rawBody = JSON.stringify({ operation, ...payload });
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
