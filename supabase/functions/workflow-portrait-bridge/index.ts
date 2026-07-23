import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import {
  signedPortraitMemoryRetriggerHeaders,
  type PortraitMemoryRetriggerRequest,
} from '../_shared/portrait-memory-retrigger.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;
const RETRIGGER_MIN_AGE_MS = 30_000;
const RETRIGGER_MAX_CANDIDATES = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BridgeOperation =
  | 'get_input'
  | 'reserve_attempt'
  | 'authorize_upload'
  | 'record_upload_complete'
  | 'publish'
  | 'fail'
  | 'reconcile'
  | 'retrigger_memories';

interface BridgeRequest {
  operation: BridgeOperation;
  jobId: string;
  provider?: 'primary' | 'fallback';
  attemptNumber?: number;
  model?: string;
  outputKey?: string;
  uploadToken?: string;
  errorCode?: string;
}

interface PortraitWorkflowJobInputRow {
  id: string;
  output_key: string;
  old_portrait_key: string | null;
  provider_deadline_at: string;
  source_photo_key: string | null;
  style_reference_key: string | null;
  portrait_prompt: string | null;
}

interface PublishOutcome {
  published?: boolean;
  already_published?: boolean;
  old_key?: string | null;
}

interface TerminalJobRow {
  status: string;
  family_id: string;
  actor_user_id: string | null;
  portrait_version_id: string;
}

export interface WorkflowPortraitBridgeDependencies {
  createServiceClient: typeof createServiceClient;
  fetch: typeof fetch;
}

const DEFAULT_DEPENDENCIES: WorkflowPortraitBridgeDependencies = {
  createServiceClient,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  const decode = (value: string): Uint8Array => {
    const digest = new Uint8Array(32);
    if (!/^[0-9a-f]{64}$/i.test(value)) return digest;
    for (let index = 0; index < digest.length; index += 1) {
      digest[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return digest;
  };
  const leftDigest = decode(left);
  const rightDigest = decode(right);
  let mismatch = 0;
  for (let index = 0; index < leftDigest.length; index += 1) mismatch |= leftDigest[index] ^ rightDigest[index];
  return mismatch === 0;
}

export async function isSignedPortraitWorkflowRequest(req: Request, rawBody: string): Promise<boolean> {
  const timestamp = req.headers.get('x-workflow-timestamp');
  const nonce = req.headers.get('x-workflow-nonce');
  const signature = req.headers.get('x-workflow-signature');
  const secret = Deno.env.get('CLOUDFLARE_PORTRAIT_BRIDGE_SECRET');
  if (!timestamp || !nonce || !signature || !secret) return false;
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

export function classifyPortraitNonceInsertError(error: { code?: string } | null): 'ok' | 'replay' | 'error' {
  if (!error) return 'ok';
  return error.code === '23505' ? 'replay' : 'error';
}

export function toPortraitWorkflowJobInput(data: PortraitWorkflowJobInputRow) {
  return {
    job: {
      jobId: data.id,
      outputKey: data.output_key,
      oldPortraitKey: data.old_portrait_key,
      providerDeadlineAt: data.provider_deadline_at,
      sourcePhotoKey: data.source_photo_key,
      styleReferenceKey: data.style_reference_key,
      prompt: data.portrait_prompt,
    },
  };
}

export function mapPortraitPublishOutcome(outcome: PublishOutcome | undefined) {
  const published = Boolean(outcome?.published || outcome?.already_published);
  return {
    published,
    oldPortraitKey: outcome?.old_key ?? null,
    deleteOutput: !published,
  };
}

export function getPortraitReconcileAction(input: {
  status: string;
  outputKey: string;
  expectedOutputKey: string;
}): 'succeeded' | 'republish' | 'delete' {
  if (input.status === 'succeeded' && input.outputKey === input.expectedOutputKey) return 'succeeded';
  if ((input.status === 'queued' || input.status === 'running') && input.outputKey === input.expectedOutputKey) {
    return 'republish';
  }
  return 'delete';
}

async function invokeMemoryRecovery(
  fetchFn: typeof fetch,
  memoryId: string,
  actorUserId: string,
  familyId: string,
): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) throw new Error('Missing Supabase recovery configuration');
  const payload: PortraitMemoryRetriggerRequest = {
    memoryId,
    requestIntent: 'recovery',
    actorUserId,
    familyId,
  };
  const rawBody = JSON.stringify(payload);
  const response = await fetchFn(`${supabaseUrl}/functions/v1/generate-illustration`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      ...await signedPortraitMemoryRetriggerHeaders(rawBody),
    },
    body: rawBody,
  });
  await response.text().catch(() => '');
  // A current workflow/claim is normal. Other individual errors are isolated
  // from the portrait terminal transition and client recovery remains a
  // backstop for a transient bridge outage.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Memory recovery dispatch failed (${response.status})`);
  }
}

async function retriggerAffectedMemories(
  supabase: ReturnType<typeof createServiceClient>,
  job: TerminalJobRow,
  fetchFn: typeof fetch,
): Promise<number> {
  if (!['succeeded', 'failed', 'superseded'].includes(job.status) || !job.actor_user_id) return 0;
  const { data: version, error: versionError } = await supabase
    .from('family_member_portrait_versions')
    .select('family_member_id')
    .eq('id', job.portrait_version_id)
    .maybeSingle();
  if (versionError) throw versionError;
  if (!version) return 0;

  // Query through the tag join so three unrelated pending memories cannot
  // starve the memory that was actually waiting on this portrait.
  const { data: rows, error: rowsError } = await supabase
    .from('memory_family_members')
    .select('memory_id, memories!inner(id, family_id, memory_type, illustration_status, created_at)')
    .eq('family_member_id', version.family_member_id)
    .eq('memories.family_id', job.family_id)
    .eq('memories.memory_type', 'text_illustration')
    .eq('memories.illustration_status', 'pending')
    .lt('memories.created_at', new Date(Date.now() - RETRIGGER_MIN_AGE_MS).toISOString())
    .limit(RETRIGGER_MAX_CANDIDATES);
  if (rowsError) throw rowsError;

  const memoryIds = [...new Set((rows ?? []).map((row) => row.memory_id))];
  const results = await Promise.allSettled(memoryIds.map((memoryId) =>
    invokeMemoryRecovery(fetchFn, memoryId, job.actor_user_id!, job.family_id)
  ));
  if (results.some((result) => result.status === 'rejected')) {
    // This turns a bridge operation into a retryable Workflow failure. The
    // request itself remains idempotent and 409 has already been treated as
    // a successful concurrent dispatch in invokeMemoryRecovery.
    throw new Error('Dependent memory recovery dispatch failed');
  }
  return memoryIds.length;
}

export async function handleWorkflowPortraitBridge(
  req: Request,
  dependencyOverrides: Partial<WorkflowPortraitBridgeDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  const rawBody = await req.text();
  if (!(await isSignedPortraitWorkflowRequest(req, rawBody))) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: BridgeRequest;
  try {
    body = JSON.parse(rawBody) as BridgeRequest;
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  const operations = new Set<BridgeOperation>([
    'get_input', 'reserve_attempt', 'authorize_upload', 'record_upload_complete',
    'publish', 'fail', 'reconcile', 'retrigger_memories',
  ]);
  if (!body || typeof body.jobId !== 'string' || !UUID_PATTERN.test(body.jobId) ||
    !operations.has(body.operation)) {
    return errorResponse('Invalid workflow operation', 400, 'validation_error');
  }

  const nonce = req.headers.get('x-workflow-nonce');
  if (!nonce || !UUID_PATTERN.test(nonce)) return errorResponse('Missing workflow nonce', 401, 'unauthorized');
  const supabase = dependencies.createServiceClient();
  const { error: nonceError } = await supabase
    .from('portrait_generation_workflow_bridge_nonces')
    .insert({ nonce });
  const nonceState = classifyPortraitNonceInsertError(nonceError);
  if (nonceState === 'replay') return errorResponse('Workflow request replayed', 409, 'replayed_request');
  if (nonceState === 'error') return errorResponse('Workflow replay guard unavailable', 500, 'internal_error');
  await supabase
    .from('portrait_generation_workflow_bridge_nonces')
    .delete()
    .lt('received_at', new Date(Date.now() - 10 * 60_000).toISOString());

  try {
    switch (body.operation) {
      case 'get_input': {
        const { data, error } = await supabase
          .from('portrait_generation_jobs')
          .select('id, status, output_key, old_portrait_key, provider_deadline_at, source_photo_key, style_reference_key, portrait_prompt')
          .eq('id', body.jobId)
          .maybeSingle();
        if (error) throw error;
        if (!data) return errorResponse('Job not found', 404, 'JOB_NOT_FOUND');
        if (data.status !== 'queued' && data.status !== 'running') {
          return errorResponse('Job is no longer active', 409, 'JOB_SUPERSEDED');
        }
        if (!data.source_photo_key || !data.style_reference_key || !data.portrait_prompt) {
          return errorResponse('Job input unavailable', 409, 'JOB_SUPERSEDED');
        }
        const { error: markRunningError } = await supabase
          .from('portrait_generation_jobs')
          .update({ status: 'running' })
          .eq('id', body.jobId)
          .eq('status', 'queued');
        if (markRunningError) throw markRunningError;
        return jsonResponse(toPortraitWorkflowJobInput(data));
      }
      case 'reserve_attempt': {
        const expectedModel = body.provider === 'primary' ? 'gpt-image-2' : 'gpt-image-1.5';
        if ((body.provider !== 'primary' && body.provider !== 'fallback') ||
          body.model !== expectedModel || body.attemptNumber !== 1) {
          return errorResponse('Invalid provider', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('reserve_portrait_generation_provider_attempt', {
          p_job_id: body.jobId,
          p_provider: body.provider,
          p_attempt_number: 1,
        });
        if (error) throw error;
        return jsonResponse({ reserved: Boolean(data) });
      }
      case 'authorize_upload': {
        if (typeof body.outputKey !== 'string' || !body.outputKey) {
          return errorResponse('outputKey is required', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('authorize_portrait_generation_workflow_upload', {
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
          typeof body.uploadToken !== 'string' || !UUID_PATTERN.test(body.uploadToken)) {
          return errorResponse('outputKey and uploadToken are required', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc(
          'record_portrait_generation_workflow_upload_complete',
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
        if ((body.model !== 'gpt-image-2' && body.model !== 'gpt-image-1.5') ||
          typeof body.outputKey !== 'string' || !body.outputKey) {
          return errorResponse('model and outputKey are required', 400, 'validation_error');
        }
        const { data: job, error: jobError } = await supabase
          .from('portrait_generation_jobs')
          .select('output_key')
          .eq('id', body.jobId)
          .maybeSingle();
        if (jobError) throw jobError;
        if (!job || job.output_key !== body.outputKey) {
          return errorResponse('Output key mismatch', 409, 'JOB_SUPERSEDED');
        }
        const { data, error } = await supabase.rpc('publish_portrait_generation_workflow_job', {
          p_job_id: body.jobId,
          p_model: body.model,
        });
        if (error) throw error;
        return jsonResponse(mapPortraitPublishOutcome(data?.[0] as PublishOutcome | undefined));
      }
      case 'fail': {
        if (body.errorCode !== undefined &&
          (typeof body.errorCode !== 'string' || body.errorCode.length > 100)) {
          return errorResponse('Invalid error code', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('fail_portrait_generation_workflow_job', {
          p_job_id: body.jobId,
          p_error_code: body.errorCode ?? 'GENERATION_FAILED',
        });
        if (error) throw error;
        const outcome = data?.[0] as { terminal_status?: string; output_key?: string | null } | undefined;
        const terminalStatus = outcome?.terminal_status ?? 'superseded';
        return jsonResponse({
          failed: terminalStatus === 'failed',
          outputKey: outcome?.output_key ?? null,
          terminalStatus,
          // A failed/superseded job can never own the published pointer, so
          // its deterministic object is safe to remove. A replay after a
          // successful publish must preserve the ready portrait.
          deleteOutput: terminalStatus !== 'succeeded',
        });
      }
      case 'reconcile': {
        if ((body.model !== 'gpt-image-2' && body.model !== 'gpt-image-1.5') ||
          typeof body.outputKey !== 'string' || !body.outputKey) {
          return errorResponse('outputKey and model are required', 400, 'validation_error');
        }
        const { data: job, error: jobError } = await supabase
          .from('portrait_generation_jobs')
          .select('status, output_key, old_portrait_key')
          .eq('id', body.jobId)
          .maybeSingle();
        if (jobError) throw jobError;
        const action = job
          ? getPortraitReconcileAction({ status: job.status, outputKey: job.output_key, expectedOutputKey: body.outputKey })
          : 'delete';
        if (action === 'succeeded') {
          return jsonResponse({ published: true, oldPortraitKey: job!.old_portrait_key ?? null, deleteOutput: false });
        }
        if (action === 'republish') {
          const { data, error } = await supabase.rpc('reconcile_portrait_generation_workflow_job', {
            p_job_id: body.jobId,
            p_model: body.model,
          });
          if (error) throw error;
          return jsonResponse(mapPortraitPublishOutcome(data?.[0] as PublishOutcome | undefined));
        }
        return jsonResponse({ published: false, oldPortraitKey: null, deleteOutput: true });
      }
      case 'retrigger_memories': {
        const { data: job, error } = await supabase
          .from('portrait_generation_jobs')
          .select('status, family_id, actor_user_id, portrait_version_id')
          .eq('id', body.jobId)
          .maybeSingle();
        if (error) throw error;
        if (!job) return errorResponse('Job not found', 404, 'JOB_NOT_FOUND');
        if (!['succeeded', 'failed', 'superseded'].includes(job.status)) {
          return errorResponse('Job is not terminal', 409, 'JOB_NOT_TERMINAL');
        }
        const requested = await retriggerAffectedMemories(supabase, job as TerminalJobRow, dependencies.fetch);
        return jsonResponse({ requested });
      }
    }
  } catch {
    // Do not log prompt, source/style keys, or user-generated content.
    console.error('workflow portrait bridge operation failed', body.operation, body.jobId);
    return errorResponse('Workflow bridge operation failed', 500, 'internal_error');
  }
}

if (import.meta.main) Deno.serve((request) => handleWorkflowPortraitBridge(request));
