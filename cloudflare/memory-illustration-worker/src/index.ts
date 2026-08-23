import { verifySignedBody } from './crypto';
import { GalleryImportWorkflow } from './gallery-workflow';
import { PortraitGenerationWorkflow } from './portrait-workflow';
import { MemoryIllustrationWorkflow } from './workflow';
import {
  WORKFLOW_JOB_ID_PATTERN,
  type GalleryWorkflowDispatchPayload,
  type WorkflowDispatchPayload,
} from './types';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function response(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isDuplicateWorkflowError(error: unknown): boolean {
  // The Workflows binding surfaces a duplicate-instance-id rejection as a
  // plain Error with a human-readable message (no documented numeric code
  // in @cloudflare/workers-types' `WorkflowError` as of this writing); match
  // its wording rather than relying on an unstable code.
  const message = error instanceof Error ? error.message : '';
  return /already exists|duplicate|unique/i.test(message);
}

interface DispatchTarget {
  workflow: Workflow<WorkflowDispatchPayload>;
  signingSecret: string;
}

interface GalleryDispatchTarget {
  workflow: Workflow<GalleryWorkflowDispatchPayload>;
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

async function handleGalleryDispatch(request: Request, target: GalleryDispatchTarget): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifySignedBody(
    target.signingSecret,
    request.headers.get('x-dispatch-timestamp'),
    request.headers.get('x-dispatch-nonce'),
    request.headers.get('x-dispatch-signature'),
    rawBody,
  );
  if (!verified) return response({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);

  let payload: GalleryWorkflowDispatchPayload;
  try {
    payload = JSON.parse(rawBody) as GalleryWorkflowDispatchPayload;
  } catch {
    return response({ error: 'Invalid request', code: 'INVALID_REQUEST' }, 400);
  }
  if (!WORKFLOW_JOB_ID_PATTERN.test(payload.chunkId ?? '')) {
    return response({ error: 'Invalid request', code: 'INVALID_CHUNK_ID' }, 400);
  }
  if (payload.attempt !== undefined && (!Number.isSafeInteger(payload.attempt) || payload.attempt < 0)) {
    return response({ error: 'Invalid request', code: 'INVALID_ATTEMPT' }, 400);
  }
  // S4: a re-dispatch on reconciliation carries `attempt` (chunks.dispatch_attempts)
  // so it gets its own Workflow instance id instead of colliding with the
  // still-running (or ambiguous) prior attempt's instance.
  // Workflow instance ids only admit [A-Za-z0-9_-] (a colon made `create`
  // throw on every dispatch -- device-observed 2026-08-23), so the prefix and
  // attempt suffix are dash-joined. Must stay in sync with the Edge's
  // galleryWorkflowInstanceId (supabase/functions/_shared/gallery-import.ts).
  const instanceId = payload.attempt !== undefined && payload.attempt > 1
    ? `gallery-${payload.chunkId}-${payload.attempt}`
    : `gallery-${payload.chunkId}`;
  try {
    await target.workflow.create({
      id: instanceId,
      params: { chunkId: payload.chunkId, attempt: payload.attempt },
      retention: { successRetention: '1 day', errorRetention: '1 day' },
    });
    return response({ accepted: true, chunkId: payload.chunkId }, 202);
  } catch (error) {
    if (isDuplicateWorkflowError(error)) {
      return response({ accepted: true, chunkId: payload.chunkId, duplicate: true }, 202);
    }
    return response({ error: 'Workflow dispatch failed', code: 'DISPATCH_FAILED' }, 502);
  }
}

export { GalleryImportWorkflow, MemoryIllustrationWorkflow, PortraitGenerationWorkflow };

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
    if (request.method === 'POST' && url.pathname === '/dispatch/gallery') {
      return await handleGalleryDispatch(request, {
        workflow: env.GALLERY_IMPORT_WORKFLOW,
        signingSecret: env.GALLERY_DISPATCH_SIGNING_SECRET,
      });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return response({ ok: true });
    }
    return response({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  },
};
