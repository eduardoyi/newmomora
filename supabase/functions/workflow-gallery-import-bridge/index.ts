import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[a-f0-9]{64}$/i;
const CLUSTER_SIGNATURE = /^[a-f0-9]{64}$/i;
const GALLERY_SKIP_REASONS = new Set(['no_candidate', 'low_confidence', 'safety_refusal', 'invalid_provider_output', 'invalid_preview', 'provider_refusal']);

type Operation =
  | 'get_gallery_chunk_input'
  | 'reserve_gallery_attempt'
  | 'record_gallery_usage'
  | 'mark_gallery_attempt_ambiguous'
  | 'publish_gallery_cluster_result'
  | 'fail_gallery_chunk'
  | 'fail_gallery_cluster'
  | 'scrub_gallery_chunk';

interface BridgeRequest extends Record<string, unknown> {
  operation: Operation;
  chunkId?: string;
  clusterSignature?: string;
  attemptId?: string;
  reservationToken?: string;
  attemptNumber?: number;
  usage?: unknown;
  candidates?: unknown;
  skipReason?: string | null;
  errorCode?: string;
}

export interface WorkflowGalleryImportBridgeDependencies {
  createServiceClient: typeof createServiceClient;
  now: () => number;
  secret: () => string | undefined;
}

const DEFAULT_DEPENDENCIES: WorkflowGalleryImportBridgeDependencies = {
  createServiceClient,
  now: () => Date.now(),
  secret: () => Deno.env.get('CLOUDFLARE_GALLERY_BRIDGE_SECRET'),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const toBytes = (value: string): Uint8Array => {
    const result = new Uint8Array(32);
    if (!SIGNATURE.test(value)) return result;
    for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    return result;
  };
  const a = toBytes(left);
  const b = toBytes(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export async function isSignedGalleryWorkflowRequest(
  req: Request,
  rawBody: string,
  dependencies: Pick<WorkflowGalleryImportBridgeDependencies, 'now' | 'secret'> = DEFAULT_DEPENDENCIES,
): Promise<boolean> {
  const timestamp = req.headers.get('x-workflow-timestamp');
  const nonce = req.headers.get('x-workflow-nonce');
  const signature = req.headers.get('x-workflow-signature');
  const secret = dependencies.secret();
  if (!timestamp || !nonce || !signature || !secret || !isUuid(nonce)) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(dependencies.now() - timestampMs) > MAX_SIGNATURE_AGE_MS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`));
  return constantTimeEqual(hex(digest), signature);
}

function validUsage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || JSON.stringify(value).length > 1024) return false;
  const allowed = ['success', 'providerStatus', 'inputTokens', 'outputTokens', 'totalTokens'];
  // This payload is retained for billing/audit. Use an exact scalar schema,
  // not a deny-list, so a future Worker cannot accidentally store prompts,
  // captions, provider responses, or arbitrary error text under a new key.
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) return false;
  return typeof value.success === 'boolean' && ['completed', 'failed', 'ambiguous'].includes(String(value.providerStatus)) &&
    ['inputTokens', 'outputTokens', 'totalTokens'].every((key) => value[key] === null || (Number.isInteger(value[key]) && (value[key] as number) >= 0));
}

function validCandidates(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 3) return false;
  return value.every((candidate) => isRecord(candidate) && typeof candidate.caption === 'string' && candidate.caption.trim().length > 0 &&
    candidate.caption.length <= 1_000 && !/[\x00-\x1F]/.test(candidate.caption) && /^\d{4}-\d{2}-\d{2}$/.test(String(candidate.memoryDate)) &&
    typeof candidate.confidence === 'number' && candidate.confidence >= 0 && candidate.confidence <= 1 &&
    (candidate.emotion === null || ['joy', 'funny', 'tender', 'calm', 'wonder', 'mischief', 'pride', 'bittersweet', 'worry', 'weary', 'sad'].includes(String(candidate.emotion))) &&
    Array.isArray(candidate.selectedAssetTokens) && candidate.selectedAssetTokens.length >= 1 && candidate.selectedAssetTokens.length <= 10 && candidate.selectedAssetTokens.every(isUuid));
}

async function consumeNonce(client: SupabaseClient, nonce: string): Promise<'ok' | 'replayed' | 'failed'> {
  const { error } = await client.from('gallery_import_workflow_bridge_nonces').insert({ nonce });
  if (!error) return 'ok';
  return error.code === '23505' ? 'replayed' : 'failed';
}

const CLOSED_ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

function validRequest(body: unknown): body is BridgeRequest {
  if (!isRecord(body) || typeof body.operation !== 'string') return false;
  const operation = body.operation as Operation;
  if (!['get_gallery_chunk_input', 'reserve_gallery_attempt', 'record_gallery_usage', 'mark_gallery_attempt_ambiguous', 'publish_gallery_cluster_result', 'fail_gallery_chunk', 'fail_gallery_cluster', 'scrub_gallery_chunk'].includes(operation)) return false;
  if (!isUuid(body.chunkId)) return false;
  if (operation === 'reserve_gallery_attempt') return typeof body.clusterSignature === 'string' && CLUSTER_SIGNATURE.test(body.clusterSignature) && Number.isInteger(body.attemptNumber) && (body.attemptNumber as number) >= 1 && (body.attemptNumber as number) <= 3;
  if (operation === 'record_gallery_usage') return isUuid(body.attemptId) && isUuid(body.reservationToken) && validUsage(body.usage);
  if (operation === 'mark_gallery_attempt_ambiguous') return isUuid(body.attemptId) && isUuid(body.reservationToken);
  if (operation === 'publish_gallery_cluster_result') return typeof body.clusterSignature === 'string' && CLUSTER_SIGNATURE.test(body.clusterSignature) && validCandidates(body.candidates) &&
    (body.skipReason === null || body.skipReason === undefined || (typeof body.skipReason === 'string' && GALLERY_SKIP_REASONS.has(body.skipReason)));
  if (operation === 'fail_gallery_chunk') return typeof body.errorCode === 'string' && CLOSED_ERROR_CODE.test(body.errorCode);
  if (operation === 'fail_gallery_cluster') return typeof body.clusterSignature === 'string' && CLUSTER_SIGNATURE.test(body.clusterSignature) &&
    typeof body.errorCode === 'string' && CLOSED_ERROR_CODE.test(body.errorCode);
  return true;
}

/**
 * S6. Only a small allowlist of Postgres errors are genuinely non-retryable
 * business/validation outcomes (`P0001` domain rule, `22023` bad input,
 * `42501` authorization, `28000` unauthenticated) -- those map to the
 * existing 409 `bridge_rejected`. Everything else (deadlock `40P01`,
 * statement timeout `57014`, connection-class `08xxx`, resource-class
 * `53xxx`, `P0002` not-found races, or any unexpected code) is treated as a
 * transient server condition and maps to a retryable 503
 * `bridge_unavailable`, so the Worker's bridge-retry policy can distinguish
 * "never retry this" from "try again".
 */
const NON_RETRYABLE_BRIDGE_ERROR_CODES = new Set(['P0001', '22023', '42501', '28000']);

function classifyGalleryBridgeError(error: { code?: string } | null): { status: number; code: string } {
  if (error?.code && NON_RETRYABLE_BRIDGE_ERROR_CODES.has(error.code)) return { status: 409, code: 'bridge_rejected' };
  return { status: 503, code: 'bridge_unavailable' };
}

export async function handleWorkflowGalleryImportBridge(
  req: Request,
  overrides: Partial<WorkflowGalleryImportBridgeDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  const rawBody = await req.text();
  if (!(await isSignedGalleryWorkflowRequest(req, rawBody, dependencies))) return errorResponse('Unauthorized', 401, 'unauthorized');
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return errorResponse('Invalid JSON body', 400, 'invalid_json'); }
  if (!validRequest(body)) return errorResponse('Invalid workflow operation', 400, 'validation_error');
  const supabase = dependencies.createServiceClient();
  const nonce = req.headers.get('x-workflow-nonce') as string;
  const nonceResult = await consumeNonce(supabase, nonce);
  if (nonceResult === 'replayed') return errorResponse('Workflow request replayed', 409, 'replayed_request');
  if (nonceResult === 'failed') return errorResponse('Workflow replay guard unavailable', 500, 'internal_error');

  let data: unknown;
  let error: { code?: string } | null;
  switch (body.operation) {
    case 'get_gallery_chunk_input': ({ data, error } = await supabase.rpc('get_gallery_chunk_input', { p_chunk_id: body.chunkId })); break;
    case 'reserve_gallery_attempt': ({ data, error } = await supabase.rpc('reserve_gallery_attempt', { p_chunk_id: body.chunkId, p_cluster_signature: body.clusterSignature, p_attempt_ordinal: body.attemptNumber })); break;
    case 'record_gallery_usage': ({ data, error } = await supabase.rpc('record_gallery_usage', { p_attempt_id: body.attemptId, p_reservation_token: body.reservationToken, p_usage: body.usage })); break;
    case 'mark_gallery_attempt_ambiguous': ({ data, error } = await supabase.rpc('mark_gallery_attempt_ambiguous', { p_attempt_id: body.attemptId, p_reservation_token: body.reservationToken })); break;
    case 'publish_gallery_cluster_result': ({ data, error } = await supabase.rpc('publish_gallery_cluster_result', { p_chunk_id: body.chunkId, p_cluster_signature: body.clusterSignature, p_candidates: body.candidates, p_skip_reason: body.skipReason ?? null })); break;
    case 'fail_gallery_chunk': ({ data, error } = await supabase.rpc('fail_gallery_chunk', { p_chunk_id: body.chunkId, p_closed_error_code: body.errorCode })); break;
    case 'fail_gallery_cluster': ({ data, error } = await supabase.rpc('fail_gallery_cluster', { p_chunk_id: body.chunkId, p_cluster_signature: body.clusterSignature, p_closed_error_code: body.errorCode })); break;
    case 'scrub_gallery_chunk': ({ data, error } = await supabase.rpc('scrub_gallery_chunk', { p_chunk_id: body.chunkId })); break;
  }
  if (error) {
    // Worker classifies non-2xx; never surface SQL/input/model context.
    console.error('gallery bridge rpc failed', error.code ?? 'unknown');
    const classified = classifyGalleryBridgeError(error);
    return errorResponse('Workflow bridge request failed', classified.status, classified.code);
  }
  if (body.operation === 'get_gallery_chunk_input') return jsonResponse({ chunk: data });
  if (body.operation === 'reserve_gallery_attempt') {
    const row = Array.isArray(data) ? data[0] : data;
    if (!isRecord(row)) return errorResponse('Workflow bridge request failed', 409, 'bridge_rejected');
    return jsonResponse({ attempt_id: row.attempt_id, reservation_token: row.reservation_token, outcome: row.outcome });
  }
  if (body.operation === 'publish_gallery_cluster_result') return jsonResponse({ published: true, publishedCount: typeof data === 'number' ? data : 0 });
  return jsonResponse({ ok: data === true || data !== null });
}

if (import.meta.main) Deno.serve((req) => handleWorkflowGalleryImportBridge(req));
