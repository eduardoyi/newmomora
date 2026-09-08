/**
 * HMAC client for the render worker (`render/memory-book-renderer/`, plan
 * step 3 -- a separate, not-yet-built change; this module only implements
 * the CALLING side of its documented contract, plan Design Decisions 2/3).
 * Same timestamp+nonce+rawBody HMAC scheme as `./bridge.ts` and
 * `generate-memory-book/index.ts`'s dispatch signing.
 *
 * `/fit` is synchronous (returns THE page count in ~seconds). `/render` is
 * async by contract (202-accepts, in-progress marker, idempotent replay) --
 * a real render can run minutes, past a single Workflow step's timeout, so
 * `renderBook`/`getRenderStatus` are polled from the Workflow's `run()`
 * loop (see workflow.ts), not from inside one `step.do` call.
 */
import { hmacSha256Hex } from './crypto';
import type { Env, RenderWorkerFitResult, RenderWorkerRenderResult } from './types';

export class RenderWorkerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function signedFetch(env: Env, path: string, body: Record<string, unknown>, method: 'GET' | 'POST' = 'POST'): Promise<Response> {
  const rawBody = method === 'POST' ? JSON.stringify(body) : '';
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = await hmacSha256Hex(env.RENDER_WORKER_HMAC_SECRET, `${timestamp}.${nonce}.${rawBody}`);
  return fetch(`${env.RENDER_WORKER_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-render-timestamp': timestamp,
      'x-render-nonce': nonce,
      'x-render-signature': signature,
    },
    body: method === 'POST' ? rawBody : undefined,
  });
}

export async function fitBook(env: Env, bookDocument: unknown, edits: unknown): Promise<RenderWorkerFitResult> {
  const response = await signedFetch(env, '/fit', { bookDocument, edits });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new RenderWorkerError(response.status, `render worker /fit failed (${response.status})`);
  const pageCount = Number(json.pageCount);
  if (!Number.isFinite(pageCount) || pageCount <= 0) throw new RenderWorkerError(502, 'render worker /fit returned an invalid pageCount');
  return { pageCount };
}

function parseRenderResult(json: Record<string, unknown>): RenderWorkerRenderResult {
  const state = json.state;
  if (state !== 'accepted' && state !== 'in_progress' && state !== 'done' && state !== 'failed') {
    throw new RenderWorkerError(502, 'render worker returned an unrecognized state');
  }
  return {
    state,
    interiorKey: typeof json.interiorKey === 'string' ? json.interiorKey : undefined,
    coverKey: typeof json.coverKey === 'string' ? json.coverKey : undefined,
    pageCount: typeof json.pageCount === 'number' ? json.pageCount : undefined,
    interiorChecksum: typeof json.interiorChecksum === 'string' ? json.interiorChecksum : undefined,
    coverChecksum: typeof json.coverChecksum === 'string' ? json.coverChecksum : undefined,
    errorCode: typeof json.errorCode === 'string' ? json.errorCode : undefined,
  };
}

export interface RenderBookInput {
  orderId: string;
  attemptId: string;
  bookDocument: unknown;
  edits: unknown;
  spineMm: number;
}

/** `POST /render` -- 202-accepts (or, per the render worker's REAL
 * idempotency check, may return the already-completed result directly on
 * a replay). Either shape parses through `parseRenderResult`. */
export async function renderBook(env: Env, input: RenderBookInput): Promise<RenderWorkerRenderResult> {
  const response = await signedFetch(env, '/render', {
    orderId: input.orderId,
    attemptId: input.attemptId,
    bookDocument: input.bookDocument,
    edits: input.edits,
    spineMm: input.spineMm,
    output: { bucketPrefix: `print-orders/${input.orderId}/` },
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 409) {
    // A concurrent duplicate for the same attemptId -- treat as
    // "still in progress", the poll loop will catch up.
    return { state: 'in_progress' };
  }
  if (!response.ok && response.status !== 202) {
    throw new RenderWorkerError(response.status, `render worker /render failed (${response.status})`);
  }
  return parseRenderResult(json);
}

export async function getRenderStatus(env: Env, attemptId: string): Promise<RenderWorkerRenderResult> {
  const response = await signedFetch(env, `/status/${encodeURIComponent(attemptId)}`, {}, 'GET');
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new RenderWorkerError(response.status, `render worker /status failed (${response.status})`);
  return parseRenderResult(json);
}
