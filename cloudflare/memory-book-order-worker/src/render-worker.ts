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
  // The render worker's ACTUAL contract (render/memory-book-renderer/src/
  // server.ts; canary seam #3): field is `status` with values
  // pending|running|done|failed, and a 202 body is {accepted:true,...}.
  // Map onto this client's state enum.
  const raw = json.status ?? (json.accepted === true ? 'accepted' : json.state);
  const state = raw === 'pending' || raw === 'running' ? 'in_progress' : raw;
  if (state !== 'accepted' && state !== 'in_progress' && state !== 'done' && state !== 'failed') {
    throw new RenderWorkerError(502, 'render worker returned an unrecognized state');
  }
  return {
    state,
    // Done-payload shape is NESTED on the worker: keys{interior,cover} +
    // checksums{interior,cover} (status.ts RenderStatus) — canary seam.
    interiorKey: typeof (json.keys as any)?.interior === 'string' ? (json.keys as any).interior : undefined,
    coverKey: typeof (json.keys as any)?.cover === 'string' ? (json.keys as any).cover : undefined,
    pageCount: typeof json.pageCount === 'number' ? json.pageCount : undefined,
    interiorChecksum: typeof (json.checksums as any)?.interior === 'string' ? (json.checksums as any).interior : undefined,
    coverChecksum: typeof (json.checksums as any)?.cover === 'string' ? (json.checksums as any).cover : undefined,
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

export async function getRenderStatus(env: Env, orderId: string, attemptId: string): Promise<RenderWorkerRenderResult> {
  // The render worker's status route REQUIRES ?orderId= (its R2 state key
  // is print-orders/<orderId>/<attemptId>/ — documented deviation in
  // render/memory-book-renderer/src/server.ts; canary finding: the plan's
  // shorthand /status/<attemptId> 400s without it).
  const response = await signedFetch(env, `/status/${encodeURIComponent(attemptId)}?orderId=${encodeURIComponent(orderId)}`, {}, 'GET');
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new RenderWorkerError(response.status, `render worker /status failed (${response.status})`);
  return parseRenderResult(json);
}
