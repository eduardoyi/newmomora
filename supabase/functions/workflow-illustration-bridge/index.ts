import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

export interface WorkflowIllustrationBridgeDependencies {
  createServiceClient: typeof createServiceClient;
}

const DEFAULT_DEPENDENCIES: WorkflowIllustrationBridgeDependencies = { createServiceClient };

interface BridgeRequest {
  operation:
    | 'get_input'
    | 'reserve_attempt'
    | 'record_prompt'
    | 'authorize_upload'
    | 'record_upload_complete'
    | 'publish'
    | 'fail'
    | 'reconcile'
    | 'record_usage';
  jobId: string;
  provider?: 'primary' | 'fallback';
  attemptNumber?: number;
  prompt?: string;
  model?: string;
  outputKey?: string;
  uploadToken?: string;
  errorCode?: string;
  aiCallId?: string;
  usageRequestId?: string;
  usage?: unknown;
  success?: boolean;
  billingStatus?: 'known' | 'unknown';
  protocolVersion?: number;
  pricingVersion?: string;
  costBasis?: 'provider_usage' | 'unpriced';
  costIsComplete?: boolean;
  estimatedCostUsd?: number;
  aiOperation?: 'image_generation';
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
  usage_request_id?: string | null;
  usage_protocol_version?: number | null;
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
  const usageProtocol = toWorkflowUsageProtocol(
    data.usage_request_id,
    data.usage_protocol_version,
  );
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
    ...usageProtocol,
  } };
}

function toWorkflowUsageProtocol(
  usageRequestId: string | null | undefined,
  providerProtocolVersion: number | null | undefined,
) {
  if (providerProtocolVersion === 2) {
    if (!isUuid(usageRequestId)) {
      throw new TypeError('A v2 workflow job requires a usage request id');
    }
    return { usageRequestId, providerProtocolVersion: 2 as const };
  }
  if (providerProtocolVersion !== null && providerProtocolVersion !== undefined &&
    providerProtocolVersion !== 1) {
    throw new TypeError('Unsupported workflow usage protocol version');
  }
  if (usageRequestId !== null && usageRequestId !== undefined) {
    throw new TypeError('A legacy workflow job cannot carry a usage request id');
  }
  return {};
}

interface ProviderReservationResult {
  outcome: 'reserved_now' | 'already_reserved' | 'denied';
  protocolVersion: 2;
}

/**
 * The bridge must never turn a replay into permission for another paid call.
 * During the schema rollout the RPC may return a boolean (v1) or the v2
 * object; normalize both into the strict Worker protocol.
 */
export function toProviderReservationResult(data: unknown): ProviderReservationResult {
  if (Array.isArray(data)) return toProviderReservationResult(data[0]);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const value = data as Record<string, unknown>;
    if (value.outcome === 'reserved_now' || value.outcome === 'already_reserved' || value.outcome === 'denied') {
      return { outcome: value.outcome, protocolVersion: 2 };
    }
  }
  return { outcome: data === true ? 'reserved_now' : 'already_reserved', protocolVersion: 2 };
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Drop arbitrary provider fields (which can unexpectedly contain content). */
export function allowlistedUsage(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  // Worker sends this exact ImageUsage shape. Do not accept raw OpenAI usage
  // here: it is untrusted bridge input and the SQL ledger has scalar columns.
  const allowed = [
    'inputTextTokens', 'inputImageTokens', 'inputCachedTokens',
    'outputTextTokens', 'outputImageTokens',
  ];
  const result: Record<string, number> = {};
  for (const key of allowed) {
    const candidate = source[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      result[key] = candidate;
    }
  }
  return result;
}

function detailedProviderUsage(body: BridgeRequest): Record<string, number | string> {
  const usage = allowlistedUsage(body.usage);
  return {
    provider: body.provider!,
    ...(usage?.inputTextTokens !== undefined ? { input_text_tokens: usage.inputTextTokens } : {}),
    ...(usage?.inputImageTokens !== undefined ? { input_image_tokens: usage.inputImageTokens } : {}),
    ...(usage?.inputCachedTokens !== undefined ? { cached_input_tokens: usage.inputCachedTokens } : {}),
    ...(usage?.outputTextTokens !== undefined ? { output_text_tokens: usage.outputTextTokens } : {}),
    ...(usage?.outputImageTokens !== undefined ? { output_image_tokens: usage.outputImageTokens } : {}),
  };
}

function isValidUsageEvent(body: BridgeRequest, maxPrimaryAttempt: number): boolean {
  const expectedModel = body.provider === 'primary' ? 'gpt-image-2' : 'gpt-image-1.5';
  return (body.provider === 'primary' || body.provider === 'fallback') &&
    body.model === expectedModel &&
    Number.isInteger(body.attemptNumber) && body.attemptNumber! >= 1 &&
    body.attemptNumber! <= (body.provider === 'primary' ? maxPrimaryAttempt : 1) &&
    typeof body.aiCallId === 'string' && body.aiCallId.length <= 200 &&
    typeof body.success === 'boolean' &&
    (body.billingStatus === undefined || body.billingStatus === 'known' || body.billingStatus === 'unknown') &&
    body.aiOperation === 'image_generation' &&
    (body.pricingVersion === undefined || (typeof body.pricingVersion === 'string' && body.pricingVersion.length <= 100)) &&
    (body.costBasis === undefined || body.costBasis === 'provider_usage' || body.costBasis === 'unpriced') &&
    (body.costIsComplete === undefined || typeof body.costIsComplete === 'boolean') &&
    (body.estimatedCostUsd === undefined || body.estimatedCostUsd === null || isNonNegativeNumber(body.estimatedCostUsd));
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

export async function handleWorkflowIllustrationBridge(
  req: Request,
  dependencyOverrides: Partial<WorkflowIllustrationBridgeDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
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
    'record_usage',
  ]);
  if (typeof body.jobId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.jobId) ||
    !validOperations.has(body.operation)) {
    return errorResponse('Invalid workflow operation', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();
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
          .select('id, status, output_key, old_illustration_key, provider_deadline_at, style_description, safe_scene_description, expression_style, color_palette, emotion, memory_date, reference_candidates, usage_request_id, usage_protocol_version')
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
        const { data: job, error: jobError } = await supabase
          .from('memory_illustration_jobs')
          .select('usage_request_id, usage_protocol_version')
          .eq('id', body.jobId)
          .maybeSingle();
        if (jobError || !job) throw jobError ?? new Error('Job not found');
        const isV2 = job.usage_protocol_version === 2;
        if (isV2 && (!isUuid(body.usageRequestId) || body.usageRequestId !== job.usage_request_id || body.protocolVersion !== 2)) {
          return jsonResponse({ outcome: 'denied', protocolVersion: 2 });
        }
        const { data, error } = isV2
          ? await supabase.rpc('reserve_ai_image_provider_attempt_v2', {
            p_request_id: job.usage_request_id,
            p_job_kind: 'memory',
            p_job_id: body.jobId,
            p_provider: body.provider,
            p_attempt_number: body.attemptNumber,
          })
          : await supabase.rpc('reserve_memory_illustration_provider_attempt', {
            p_job_id: body.jobId,
            p_provider: body.provider,
            p_attempt_number: body.attemptNumber,
          });
        if (error) throw error;
        return isV2
          ? jsonResponse(toProviderReservationResult(data))
          : jsonResponse({ reserved: Boolean(data) });
      }
      case 'record_usage': {
        if (!isValidUsageEvent(body, 2)) {
          return errorResponse('Invalid usage event', 400, 'validation_error');
        }
        const isV2 = isUuid(body.usageRequestId) && body.protocolVersion === 2;
        if (isV2 && body.aiCallId !== `${body.usageRequestId}:${body.provider}:${body.attemptNumber}`) {
          return errorResponse('Invalid usage event', 400, 'validation_error');
        }
        if (!isV2 && (body.usageRequestId !== null && body.usageRequestId !== undefined ||
          (body.protocolVersion !== undefined && body.protocolVersion !== 1) ||
          body.aiCallId !== `${body.jobId}:${body.provider}:${body.attemptNumber}`)) {
          return errorResponse('Invalid usage event', 400, 'validation_error');
        }
        let error: { message?: string } | null = null;
        if (isV2) {
          // SQL owns v2 idempotency and verifies the job/request/provider slot.
          ({ error } = await supabase.rpc('record_ai_usage_event', {
            p_ai_call_id: body.aiCallId, p_usage_request_id: body.usageRequestId, p_job_kind: 'memory', p_job_id: body.jobId,
            p_provider: body.provider, p_attempt_number: body.attemptNumber, p_operation: 'illustration', p_model: body.model,
            p_provider_usage: allowlistedUsage(body.usage), p_success: body.success, p_billing_status: body.billingStatus ?? 'unknown',
            p_pricing_version: body.pricingVersion ?? null, p_cost_basis: body.costBasis ?? 'unpriced', p_cost_is_complete: body.costIsComplete ?? false,
            p_estimated_cost_usd: body.estimatedCostUsd ?? null, p_input_text_tokens: allowlistedUsage(body.usage)?.inputTextTokens ?? null,
            p_input_image_tokens: allowlistedUsage(body.usage)?.inputImageTokens ?? null, p_cached_input_tokens: allowlistedUsage(body.usage)?.inputCachedTokens ?? null,
            p_output_text_tokens: allowlistedUsage(body.usage)?.outputTextTokens ?? null, p_output_image_tokens: allowlistedUsage(body.usage)?.outputImageTokens ?? null,
            p_audio_seconds: null,
          }));
        } else {
          const { data: job, error: jobError } = await supabase.from('memory_illustration_jobs')
            .select('family_id, memory_id, usage_request_id, usage_protocol_version').eq('id', body.jobId).maybeSingle();
          if (jobError || !job || job.usage_protocol_version === 2 || job.usage_request_id) return errorResponse('Invalid usage event', 400, 'validation_error');
          const { data: memory, error: memoryError } = await supabase.from('memories')
            .select('user_id, family_id').eq('id', job.memory_id).maybeSingle();
          if (memoryError || !memory || memory.family_id !== job.family_id) return errorResponse('Invalid usage event', 400, 'validation_error');
          // v1 jobs did not persist the requester. `memories.user_id` is
          // creator attribution only; it is observability metadata, never a
          // source for fair-use enforcement.
          ({ error } = await supabase.rpc('record_ai_usage_event_detailed', {
            p_ai_call_id: body.aiCallId, p_usage_request_id: null, p_family_id: job.family_id, p_actor_user_id: memory.user_id,
            p_operation: 'illustration', p_model: body.model, p_success: body.success, p_provider_usage: detailedProviderUsage(body),
            p_estimated_cost_usd: body.estimatedCostUsd ?? null, p_cost_basis: body.costBasis ?? 'unpriced',
            p_billing_status: body.billingStatus ?? 'unknown', p_cost_is_complete: body.costIsComplete ?? false, p_pricing_version: body.pricingVersion ?? null,
          }));
        }
        if (error) throw error;
        return jsonResponse({ recorded: true });
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

if (import.meta.main) Deno.serve((request) => handleWorkflowIllustrationBridge(request));
