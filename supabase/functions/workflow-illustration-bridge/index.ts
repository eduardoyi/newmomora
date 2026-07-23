import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

interface BridgeRequest {
  operation:
    | 'get_input'
    | 'reserve_attempt'
    | 'record_prompt'
    | 'authorize_upload'
    | 'record_upload_complete'
    | 'publish'
    | 'fail'
    | 'reconcile';
  jobId: string;
  provider?: 'primary' | 'fallback';
  attemptNumber?: number;
  prompt?: string;
  model?: string;
  outputKey?: string;
  uploadToken?: string;
  errorCode?: string;
}

interface WorkflowJobInputRow {
  id: string;
  output_key: string;
  old_illustration_key: string | null;
  provider_deadline_at: string;
  style_description: string | null;
  safe_scene_description: string | null;
  expression_style: string | null;
  color_palette: string;
  emotion: string | null;
  memory_date: string;
  reference_candidates: unknown;
}

interface PublishOutcome {
  published?: boolean;
  already_published?: boolean;
  old_key?: string | null;
}

export function mapPublishOutcome(outcome: PublishOutcome | undefined) {
  const published = Boolean(outcome?.published || outcome?.already_published);
  return {
    published,
    oldIllustrationKey: outcome?.old_key ?? null,
    deleteOutput: !published,
  };
}

export function getReconcileAction(input: {
  status: string;
  outputKey: string;
  expectedOutputKey: string;
}): 'succeeded' | 'republish' | 'delete' {
  if (input.status === 'succeeded' && input.outputKey === input.expectedOutputKey) return 'succeeded';
  if ((input.status === 'queued' || input.status === 'running') && input.outputKey === input.expectedOutputKey) return 'republish';
  return 'delete';
}

export function classifyNonceInsertError(error: { code?: string } | null): 'ok' | 'replay' | 'error' {
  if (!error) return 'ok';
  return error.code === '23505' ? 'replay' : 'error';
}

export function toWorkflowJobInput(data: WorkflowJobInputRow) {
  return { job: {
    jobId: data.id,
    outputKey: data.output_key,
    oldIllustrationKey: data.old_illustration_key,
    providerDeadlineAt: data.provider_deadline_at,
    styleDescription: data.style_description,
    safeSceneDescription: data.safe_scene_description,
    expressionStyle: data.expression_style,
    colorPalette: data.color_palette,
    emotion: data.emotion,
    memoryDate: data.memory_date,
    referenceCandidates: data.reference_candidates,
  } };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  // Compare two fixed-size digests, never the attacker-controlled strings
  // directly. This avoids the length short-circuit on the authentication
  // path while keeping the simple Web-Crypto-only dependency footprint.
  const toFixedDigest = (value: string): Uint8Array => {
    const digest = new Uint8Array(32);
    if (!/^[0-9a-f]{64}$/i.test(value)) return digest;
    for (let index = 0; index < 32; index += 1) {
      digest[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return digest;
  };
  const leftDigest = toFixedDigest(left);
  const rightDigest = toFixedDigest(right);
  let mismatch = 0;
  for (let index = 0; index < 32; index += 1) mismatch |= leftDigest[index] ^ rightDigest[index];
  return mismatch === 0;
}

export async function isSignedWorkflowRequest(req: Request, rawBody: string): Promise<boolean> {
  const timestamp = req.headers.get('x-workflow-timestamp');
  const signature = req.headers.get('x-workflow-signature');
  const nonce = req.headers.get('x-workflow-nonce');
  const secret = Deno.env.get('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
  if (!timestamp || !signature || !nonce || !secret) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_SIGNATURE_AGE_MS) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`),
  );
  return constantTimeEqual(hex(digest), signature.toLowerCase());
}

export async function handleWorkflowIllustrationBridge(req: Request): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  const rawBody = await req.text();
  if (!(await isSignedWorkflowRequest(req, rawBody))) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: BridgeRequest;
  try {
    body = JSON.parse(rawBody) as BridgeRequest;
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  const validOperations = new Set([
    'get_input',
    'reserve_attempt',
    'record_prompt',
    'authorize_upload',
    'record_upload_complete',
    'publish',
    'fail',
    'reconcile',
  ]);
  if (typeof body.jobId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.jobId) ||
    !validOperations.has(body.operation)) {
    return errorResponse('Invalid workflow operation', 400, 'validation_error');
  }

  const supabase = createServiceClient();
  const nonce = req.headers.get('x-workflow-nonce');
  if (!nonce || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) {
    return errorResponse('Missing workflow nonce', 401, 'unauthorized');
  }
  const { error: nonceError } = await supabase
    .from('memory_illustration_workflow_bridge_nonces')
    .insert({ nonce });
  if (classifyNonceInsertError(nonceError) === 'replay') {
    return errorResponse('Workflow request replayed', 409, 'replayed_request');
  }
  if (classifyNonceInsertError(nonceError) === 'error') return errorResponse('Workflow replay guard unavailable', 500, 'internal_error');
  // Nonces carry no user data. Bound this replay ledger without another cron;
  // every bridge request performs an indexed best-effort ten-minute sweep.
  await supabase
    .from('memory_illustration_workflow_bridge_nonces')
    .delete()
    .lt('received_at', new Date(Date.now() - 10 * 60_000).toISOString());
  try {
    switch (body.operation) {
      case 'get_input': {
        const { data, error } = await supabase
          .from('memory_illustration_jobs')
          .select('id, status, output_key, old_illustration_key, provider_deadline_at, style_description, safe_scene_description, expression_style, color_palette, emotion, memory_date, reference_candidates')
          .eq('id', body.jobId)
          .maybeSingle();
        if (error) throw error;
        if (!data) return errorResponse('Job not found', 404, 'JOB_NOT_FOUND');
        if (data.status === 'superseded' || data.status === 'failed') return errorResponse('Job is no longer active', 409, 'JOB_SUPERSEDED');
        const { error: markRunningError } = await supabase
          .from('memory_illustration_jobs')
          .update({ status: 'running' })
          .eq('id', body.jobId)
          .eq('status', 'queued');
        if (markRunningError) throw markRunningError;
        return jsonResponse(toWorkflowJobInput(data));
      }
      case 'reserve_attempt': {
        const expectedModel = body.provider === 'primary' ? 'gpt-image-2' : 'gpt-image-1.5';
        const maxAttemptNumber = body.provider === 'primary' ? 2 : 1;
        if ((body.provider !== 'primary' && body.provider !== 'fallback') || body.model !== expectedModel ||
          !Number.isInteger(body.attemptNumber) || body.attemptNumber! < 1 || body.attemptNumber! > maxAttemptNumber) {
          return errorResponse('Invalid provider', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('reserve_memory_illustration_provider_attempt', {
          p_job_id: body.jobId,
          p_provider: body.provider,
          p_attempt_number: body.attemptNumber,
        });
        if (error) throw error;
        return jsonResponse({ reserved: Boolean(data) });
      }
      case 'record_prompt': {
        if (!body.prompt || body.prompt.length > 12_000) return errorResponse('Invalid prompt', 400, 'validation_error');
        const { data, error } = await supabase
          .from('memory_illustration_jobs')
          .update({ illustration_prompt: body.prompt })
          .eq('id', body.jobId)
          .in('status', ['queued', 'running'])
          .select('id')
          .maybeSingle();
        if (error) throw error;
        if (!data) return errorResponse('Job is no longer active', 409, 'JOB_SUPERSEDED');
        return jsonResponse({ ok: true });
      }
      case 'authorize_upload': {
        if (typeof body.outputKey !== 'string' || !body.outputKey) {
          return errorResponse('outputKey is required', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('authorize_memory_illustration_workflow_upload', {
          p_job_id: body.jobId,
          p_output_key: body.outputKey,
        });
        if (error) throw error;
        const outcome = data?.[0] as {
          authorized?: boolean;
          upload_token?: string | null;
          existing_lease?: boolean;
        } | undefined;
        const authorized = outcome?.authorized === true && typeof outcome.upload_token === 'string';
        return jsonResponse({
          authorized,
          uploadToken: authorized ? outcome!.upload_token : null,
          existingLease: authorized && outcome?.existing_lease === true,
        });
      }
      case 'record_upload_complete': {
        if (typeof body.outputKey !== 'string' || !body.outputKey ||
          typeof body.uploadToken !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.uploadToken)) {
          return errorResponse('outputKey and uploadToken are required', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc(
          'record_memory_illustration_workflow_upload_complete',
          {
            p_job_id: body.jobId,
            p_output_key: body.outputKey,
            p_upload_token: body.uploadToken,
          },
        );
        if (error) throw error;
        return jsonResponse({ completed: Boolean(data) });
      }
      case 'publish': {
        if (typeof body.model !== 'string' || typeof body.outputKey !== 'string' || !body.outputKey) return errorResponse('model and outputKey are required', 400, 'validation_error');
        if (body.model !== 'gpt-image-2' && body.model !== 'gpt-image-1.5') return errorResponse('Invalid model', 400, 'validation_error');
        const { data: job, error: jobError } = await supabase
          .from('memory_illustration_jobs')
          .select('output_key')
          .eq('id', body.jobId)
          .maybeSingle();
        if (jobError) throw jobError;
        if (!job || job.output_key !== body.outputKey) return errorResponse('Output key mismatch', 409, 'JOB_SUPERSEDED');
        const { data, error } = await supabase.rpc('publish_memory_illustration_workflow_job', {
          p_job_id: body.jobId,
          p_model: body.model,
        });
        if (error) throw error;
        return jsonResponse(mapPublishOutcome(data?.[0] as PublishOutcome | undefined));
      }
      case 'fail': {
        if (body.errorCode !== undefined && (typeof body.errorCode !== 'string' || body.errorCode.length > 100)) {
          return errorResponse('Invalid error code', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('fail_memory_illustration_workflow_job', {
          p_job_id: body.jobId,
          p_error_code: body.errorCode ?? 'GENERATION_FAILED',
        });
        if (error) throw error;
        const { data: terminalJob, error: terminalError } = await supabase
          .from('memory_illustration_jobs')
          .select('status, output_key')
          .eq('id', body.jobId)
          .maybeSingle();
        if (terminalError) throw terminalError;
        const terminalStatus = terminalJob?.status === 'succeeded'
          ? 'succeeded'
          : terminalJob?.status === 'failed'
          ? 'failed'
          : 'superseded';
        return jsonResponse({
          failed: terminalStatus === 'failed',
          outputKey: terminalJob?.output_key ?? data?.[0]?.output_key ?? null,
          terminalStatus,
          deleteOutput: terminalStatus !== 'succeeded',
        });
      }
      case 'reconcile': {
        if (typeof body.outputKey !== 'string' ||
          (body.model !== 'gpt-image-2' && body.model !== 'gpt-image-1.5')) {
          return errorResponse('outputKey and model are required', 400, 'validation_error');
        }
        const { data, error } = await supabase
          .from('memory_illustration_jobs')
          .select('status, output_key, old_illustration_key')
          .eq('id', body.jobId)
          .maybeSingle();
        if (error) throw error;
        const action = data
          ? getReconcileAction({ status: data.status, outputKey: data.output_key, expectedOutputKey: body.outputKey })
          : 'delete';
        if (action === 'succeeded') {
          return jsonResponse({
            published: true,
            oldIllustrationKey: data!.old_illustration_key ?? null,
            deleteOutput: false,
          });
        }
        if (data && action === 'republish') {
          // The object is durable but all publish requests may have failed
          // before Postgres committed. Retry the same CAS instead of deleting
          // bytes and leaving the job/memory stuck in-flight.
          const { data: outcomeRows, error: publishError } = await supabase.rpc(
            'publish_memory_illustration_workflow_job',
            { p_job_id: body.jobId, p_model: body.model },
          );
          if (publishError) throw publishError;
          return jsonResponse(mapPublishOutcome(outcomeRows?.[0] as PublishOutcome | undefined));
        }
        return jsonResponse({
          published: false,
          oldIllustrationKey: null,
          deleteOutput: true,
        });
      }
    }
  } catch (error) {
    console.error('workflow illustration bridge failed', body.operation, body.jobId);
    return errorResponse('Workflow bridge operation failed', 500, 'internal_error');
  }
}

if (import.meta.main) Deno.serve(handleWorkflowIllustrationBridge);
