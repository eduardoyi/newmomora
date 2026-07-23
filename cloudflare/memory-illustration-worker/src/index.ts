import { verifySignedBody } from './crypto';
import { PortraitGenerationWorkflow } from './portrait-workflow';
import { MemoryIllustrationWorkflow } from './workflow';
import { WORKFLOW_JOB_ID_PATTERN, type WorkflowDispatchPayload } from './types';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function response(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isDuplicateWorkflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /already exists|duplicate|unique/i.test(message);
}

interface DispatchTarget {
  workflow: Workflow<WorkflowDispatchPayload>;
  signingSecret: string;
}

async function handleDispatch(
  request: Request,
  target: DispatchTarget,
): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifySignedBody(
    target.signingSecret,
    request.headers.get('x-dispatch-timestamp'),
    request.headers.get('x-dispatch-nonce'),
    request.headers.get('x-dispatch-signature'),
    rawBody,
  );
  if (!verified) {
    return response({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }

  let payload: WorkflowDispatchPayload;
  try {
    payload = JSON.parse(rawBody) as WorkflowDispatchPayload;
  } catch {
    return response({ error: 'Invalid request', code: 'INVALID_REQUEST' }, 400);
  }
  if (!WORKFLOW_JOB_ID_PATTERN.test(payload.jobId ?? '')) {
    return response({ error: 'Invalid request', code: 'INVALID_JOB_ID' }, 400);
  }

  try {
    await target.workflow.create({
      id: payload.jobId,
      params: { jobId: payload.jobId },
      retention: { successRetention: '1 day', errorRetention: '1 day' },
    });
    return response({ accepted: true, jobId: payload.jobId }, 202);
  } catch (error) {
    if (isDuplicateWorkflowError(error)) {
      return response({ accepted: true, jobId: payload.jobId, duplicate: true }, 202);
    }
    return response({ error: 'Workflow dispatch failed', code: 'DISPATCH_FAILED' }, 502);
  }
}

export { MemoryIllustrationWorkflow, PortraitGenerationWorkflow };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/dispatch') {
      return await handleDispatch(request, {
        workflow: env.MEMORY_ILLUSTRATION_WORKFLOW,
        signingSecret: env.DISPATCH_SIGNING_SECRET,
      });
    }
    if (request.method === 'POST' && url.pathname === '/dispatch/portrait') {
      return await handleDispatch(request, {
        workflow: env.PORTRAIT_GENERATION_WORKFLOW,
        signingSecret: env.PORTRAIT_DISPATCH_SIGNING_SECRET,
      });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return response({ ok: true });
    }
    return response({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  },
};
