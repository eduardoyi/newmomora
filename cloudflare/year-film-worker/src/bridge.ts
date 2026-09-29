// Signed calls to supabase/functions/workflow-year-film-bridge. Every call
// carries the film + attempt; the bridge answers 409 { state } when the
// attempt is superseded, its content epoch moved, or the rollout is off —
// surfaced here as AttemptStopped so the Workflow aborts cleanly.
import { hmacSha256Hex } from './crypto';
import type { Env } from './types';

export class AttemptStopped extends Error {
  constructor(readonly state: string) {
    super(`attempt stopped: ${state}`);
  }
}

export class BridgeError extends Error {
  constructor(readonly status: number, readonly operation: string) {
    super(`bridge ${operation} failed (${status})`);
  }
}

export interface BridgeClient {
  call<T = Record<string, unknown>>(operation: string, body?: Record<string, unknown>): Promise<T>;
}

export function createBridge(env: Pick<Env, 'SUPABASE_BRIDGE_URL' | 'SUPABASE_BRIDGE_HMAC_SECRET'>, filmId: string, attemptId: string): BridgeClient {
  return {
    async call<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
      const raw = JSON.stringify({ ...body, operation, filmId, attemptId });
      const timestamp = String(Date.now());
      const nonce = crypto.randomUUID();
      const signature = await hmacSha256Hex(env.SUPABASE_BRIDGE_HMAC_SECRET, `${timestamp}.${nonce}.${raw}`);
      const response = await fetch(env.SUPABASE_BRIDGE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workflow-timestamp': timestamp,
          'x-workflow-nonce': nonce,
          'x-workflow-signature': signature,
        },
        body: raw,
      });
      if (response.status === 409) {
        const json = await response.json().catch(() => ({})) as { state?: string };
        throw new AttemptStopped(json.state ?? 'superseded');
      }
      if (!response.ok) throw new BridgeError(response.status, operation);
      return await response.json() as T;
    },
  };
}
