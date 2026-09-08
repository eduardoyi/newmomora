import http from 'node:http';
import { verifySignedBody } from './crypto';
import { isFitRequestBody, runFit } from './fit';
import { acceptRenderRequest, ID_PATTERN, isRenderRequestBody, runRenderJob, type RenderRequestBody } from './render';
import { readStatus } from './status';
import { createR2Client, type R2Client } from './r2';
import type { RenderWorkerEnv } from './env';

/**
 * The render worker's public HTTP surface (memory-book-5c plan, Step 3):
 *
 *   GET  /health                          — open, no auth (Fly health check)
 *   POST /fit      (HMAC)                 — {bookDocument, edits?, spineMm?} -> {pageCount}
 *   POST /render   (HMAC)                 — {orderId, attemptId, bookDocument, edits?, spineMm} -> 202/200/409
 *   GET  /status/:attemptId?orderId=:id   (HMAC) — {status: pending|running|done|failed, ...}
 *
 * "public" is the operative word: the PII data endpoints
 * (`/attempt/<id>/outline.json|manifest.json|edits.json`) belong to
 * `renderBookPdfs()`'s OWN internal static server, which binds to
 * `127.0.0.1` only and is spun up/torn down per render — this HTTP server
 * (the one Fly actually exposes) never sees or proxies that data; it only
 * ever passes a `bookDocument`/`edits` payload down into `runRenderJob`,
 * which hands it to `renderBookPdfs()` as an in-memory value, not a URL.
 *
 * Every op below except `/health` requires the SAME timestamp+nonce+raw-body
 * HMAC scheme as the rest of the repo's bridges (`crypto.ts`, mirroring
 * `cloudflare/memory-book-worker/src/crypto.ts`) via the `x-render-timestamp`
 * / `x-render-nonce` / `x-render-signature` headers.
 *
 * A `GET` carries no body, so its "raw body" for signing purposes is the
 * empty string `''` — caller and verifier must agree on that (see
 * `scripts/parity-proof.mts` / the test suite's status-check helper for the
 * caller side).
 *
 * `?orderId=` on the status route (plan shorthand: `GET
 * /status/<attemptId>`) — DEVIATION, documented: the plan's route notation
 * doesn't by itself say how an attemptId-only path resolves against R2
 * object keys that are nested `print-orders/<orderId>/<attemptId>/…` (the
 * literal path this worker writes to, per the render job); rather than
 * silently assume attemptId is enough on its own (it is NOT a lookup key
 * into a flat namespace here) or invent a global attemptId->orderId index
 * this worker has no DB to hold, the status route takes `orderId` as an
 * explicit query parameter. The future order-workflow caller (plan step 5)
 * always has both ids in hand already (it's the one that generated them).
 */

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function requireAuth(req: http.IncomingMessage, rawBody: string, env: RenderWorkerEnv): Promise<boolean> {
  return verifySignedBody(
    env.hmacSecret,
    (req.headers['x-render-timestamp'] as string | undefined) ?? null,
    (req.headers['x-render-nonce'] as string | undefined) ?? null,
    (req.headers['x-render-signature'] as string | undefined) ?? null,
    rawBody,
  );
}

/**
 * `r2ClientOverride` exists ONLY for tests (`test/server.test.ts` — "R2
 * mocked", per the task brief's own test list): production (`src/index.ts`)
 * never passes it, so `createR2Client(env.r2)` (the real presign/put/get
 * implementation) is always what a deployed instance uses.
 */
export function createServer(env: RenderWorkerEnv, r2ClientOverride?: R2Client): http.Server {
  const r2Client: R2Client = r2ClientOverride ?? createR2Client(env.r2);

  return http.createServer((req, res) => {
    void handleRequest(req, res, env, r2Client).catch((error) => {
      // ids/error-shape only — never request bodies (which may carry a
      // frozen book_document) get logged here.
      console.error('memory-book-renderer: unhandled request error', error instanceof Error ? error.message : error);
      if (!res.headersSent) json(res, 500, { error: 'INTERNAL_ERROR' });
    });
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, env: RenderWorkerEnv, r2Client: R2Client): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/fit') {
    const rawBody = await readRawBody(req);
    if (!(await requireAuth(req, rawBody, env))) return void json(res, 401, { error: 'UNAUTHORIZED' });
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return void json(res, 400, { error: 'INVALID_BODY' });
    }
    if (!isFitRequestBody(body)) return void json(res, 400, { error: 'INVALID_BODY' });
    try {
      json(res, 200, runFit(body));
    } catch (error) {
      json(res, 422, { error: 'FIT_FAILED', reason: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/render') {
    const rawBody = await readRawBody(req);
    if (!(await requireAuth(req, rawBody, env))) return void json(res, 401, { error: 'UNAUTHORIZED' });
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return void json(res, 400, { error: 'INVALID_BODY' });
    }
    if (!isRenderRequestBody(body)) return void json(res, 400, { error: 'INVALID_BODY' });

    const accept = await acceptRenderRequest(r2Client, body.orderId, body.attemptId);
    if (accept.kind === 'already-done') {
      json(res, 200, accept.status);
      return;
    }
    if (accept.kind === 'conflict') {
      json(res, 409, { error: 'RENDER_IN_PROGRESS', status: accept.status });
      return;
    }

    // 'accepted' — respond 202 immediately, then run the real (minutes-long)
    // render in the background. Deliberately unawaited: see runRenderJob's
    // own doc comment ("Async by contract").
    json(res, 202, { accepted: true, orderId: body.orderId, attemptId: body.attemptId });
    const renderBody: RenderRequestBody = body;
    runRenderJob(env, r2Client, renderBody).catch((error) => {
      console.error(
        `memory-book-renderer: render job failed (orderId=${body.orderId} attemptId=${body.attemptId})`,
        error instanceof Error ? error.message : error,
      );
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/status/')) {
    const rawBody = await readRawBody(req);
    if (!(await requireAuth(req, rawBody, env))) return void json(res, 401, { error: 'UNAUTHORIZED' });
    const attemptId = url.pathname.slice('/status/'.length);
    const orderId = url.searchParams.get('orderId');
    if (!attemptId || !ID_PATTERN.test(attemptId) || !orderId || !ID_PATTERN.test(orderId)) {
      return void json(res, 400, { error: 'INVALID_BODY' });
    }
    const status = await readStatus(r2Client, orderId, attemptId);
    if (!status) {
      json(res, 200, { status: 'pending' });
      return;
    }
    json(res, 200, status);
    return;
  }

  json(res, 404, { error: 'NOT_FOUND' });
}
