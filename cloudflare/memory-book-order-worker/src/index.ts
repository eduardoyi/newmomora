import { verifySignedBody } from './crypto';
import { MemoryBookOrderWorkflow } from './workflow';
import { WORKFLOW_ID_PATTERN, type Env, type WorkflowDispatchPayload } from './types';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isDuplicateWorkflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate|unique/i.test(message);
}

async function handleDispatch(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifySignedBody(
    env.DISPATCH_SIGNING_SECRET,
    request.headers.get('x-dispatch-timestamp'),
    request.headers.get('x-dispatch-nonce'),
    request.headers.get('x-dispatch-signature'),
    rawBody,
  );
  if (!verified) {
    return response({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }

  let payload: Partial<WorkflowDispatchPayload>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response({ error: 'Invalid JSON body', code: 'INVALID_BODY' }, 400);
  }

  if (
    typeof payload.orderId !== 'string' || !WORKFLOW_ID_PATTERN.test(payload.orderId) ||
    typeof payload.attemptId !== 'string' || !WORKFLOW_ID_PATTERN.test(payload.attemptId)
  ) {
    return response({ error: 'Invalid dispatch payload', code: 'INVALID_BODY' }, 400);
  }

  try {
    // The Workflow instance id is the attempt id -- fresh per attempt (see
    // stripe-webhook/index.ts's mark-before-dispatch CAS, and the sweep's
    // zero-dispatch reconciliation), so a retried dispatch of the SAME
    // attempt is naturally idempotent via create()-by-id, while a genuinely
    // new attempt gets its own instance. The sweep's STALE-rendering
    // redispatch reuses the EXISTING attempt id on purpose, for the same
    // reason.
    await env.MEMORY_BOOK_ORDER_WORKFLOW.create({
      id: payload.attemptId,
      params: { orderId: payload.orderId, attemptId: payload.attemptId },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    });
    return response({ accepted: true, orderId: payload.orderId, attemptId: payload.attemptId }, 202);
  } catch (error) {
    if (isDuplicateWorkflowError(error)) {
      return response({ accepted: true, orderId: payload.orderId, attemptId: payload.attemptId, duplicate: true }, 202);
    }
    return response({ error: 'Workflow dispatch failed', code: 'DISPATCH_FAILED' }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return response({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/dispatch') {
      return handleDispatch(request, env);
    }

    return response({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  },
};

export { MemoryBookOrderWorkflow };
