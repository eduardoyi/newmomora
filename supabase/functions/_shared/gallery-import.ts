import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { getAuthenticatedNonAnonymousUser } from './auth.ts';
import { handleCors } from './cors.ts';
import { errorResponse, jsonResponse } from './errors.ts';
import {
  createPresignedGetUrls,
  createPresignedPutUrl,
  headObject,
  R2_URL_EXPIRY,
} from './r2.ts';
import { createServiceClient, createUserClient } from './supabase-admin.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const CLUSTER_SIGNATURE = /^[a-f0-9]{64}$/;
const PREVIEW_CONTENT_TYPE = 'image/jpeg';
const ORIGINAL_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']);
const MAX_PREVIEW_BYTES = 1_500_000;
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

export interface GalleryImportRequestContext {
  userId: string;
  userClient: SupabaseClient;
  serviceClient: SupabaseClient;
  body: Record<string, unknown>;
}

type GalleryHandler = (context: GalleryImportRequestContext) => Promise<Response>;
interface RpcResult<T> { data: T | null; response?: Response; }
interface CandidateRunResult { response?: Response; candidate?: { id: string; run_id: string }; run?: Record<string, unknown>; }
interface ApprovalAssetResult { response?: Response; lease?: { id: string; candidate_id: string; state: string; expires_at: string; expected_assets: unknown }; expected?: Record<string, unknown>; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function hasText(value: unknown, maximum = 500): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function finiteInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function normalizedContentType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.split(';', 1)[0].trim().toLowerCase() || null;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function rpcFailure(error: { code?: string; message?: string } | null, fallback = 'Unable to complete gallery import request'): Response {
  if (!error) return errorResponse(fallback, 500, 'internal_error');
  if (error.code === '42501' || error.code === '28000') return errorResponse('Not authorized', 403, 'forbidden');
  if (error.code === 'P0002') return errorResponse('Gallery import item not found', 404, 'not_found');
  if (error.code === '22023' || error.code === '23514') return errorResponse('Invalid gallery import request', 400, 'validation_error');
  if (error.code === 'P0001') return errorResponse('Gallery import is not available for this request', 409, 'not_available');
  // PostgreSQL/provider details can contain sensitive semantic content. Never
  // reflect them to an authenticated client.
  console.error('gallery-import rpc failed', error.code ?? 'unknown');
  return errorResponse(fallback, 500, 'internal_error');
}

export function withGalleryImportRequest(handler: GalleryHandler) {
  return async (req: Request): Promise<Response> => {
    const cors = handleCors(req);
    if (cors) return cors;
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
    const user = await getAuthenticatedNonAnonymousUser(req);
    if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Unauthorized', 401, 'unauthorized');
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON body', 400, 'invalid_json');
    }
    if (!isRecord(body)) return errorResponse('Invalid gallery import request', 400, 'validation_error');
    try {
      return await handler({
        userId: user.id,
        userClient: createUserClient(authHeader),
        serviceClient: createServiceClient(),
        body,
      });
    } catch (error) {
      // Object metadata and model-related values must not enter logs.
      console.error('gallery-import endpoint failed', error instanceof Error ? error.name : 'unknown');
      return errorResponse('Unable to complete gallery import request', 500, 'internal_error');
    }
  };
}

async function userRpc<T>(context: GalleryImportRequestContext, name: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  const { data, error } = await context.userClient.rpc(name, args);
  if (error) return { data: null, response: rpcFailure(error) };
  return { data: data as T };
}

async function assertRun(context: GalleryImportRequestContext, runId: unknown, capability: unknown): Promise<RpcResult<Record<string, unknown>>> {
  if (!isUuid(runId) || !hasText(capability, 512)) return { data: null, response: errorResponse('Invalid gallery import request', 400, 'validation_error') };
  return await userRpc<Record<string, unknown>>(context, 'get_gallery_import_run', {
    p_run_id: runId,
    p_capability: capability,
  });
}

function previewKey(userId: string, runId: string, assetToken: string): string {
  return `${userId}/gallery-import/${runId}/previews/${assetToken}.jpg`;
}

/**
 * `createPresignedPutUrl` deliberately keeps metadata as signed, non-hoisted
 * headers so R2 persists it for the post-upload HEAD check. Return those exact
 * headers to the native uploader together with the intended media type.
 */
export function galleryUploadRequiredHeaders(
  contentType: string,
  metadata: Record<string, string>,
): Record<string, string> {
  return {
    'Content-Type': contentType,
    ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`x-amz-meta-${key}`, value])),
  };
}

/**
 * Clusters registered with the server but not yet resolved (no caption
 * written, and not explicitly skipped/refused) -- see
 * `publish_gallery_cluster_result` and the `gallery_import_cluster_results`
 * table in the foundation migration: a row is inserted (state 'pending')
 * the moment a chunk's assets register, and moves out of 'pending' the
 * instant that cluster's result lands, independent of chunk-level status.
 *
 * Round 4, device-tested finding: the client previously counted "+N coming"
 * from its own LOCAL upload plan (checkpoint.chunks), which goes stale the
 * moment a run is resumed after a stall/reload -- a real production run
 * showed "+51 coming" all day from a phantom plan the server had already
 * moved past. This is server truth instead: cheap (one indexed count against
 * a join on the chunk's own primary key), and correct across any number of
 * resumes/devices. Best-effort -- a failure here must never break the run
 * status response itself; the caller treats `null` as "unknown, don't show
 * a number".
 */
async function countPendingGalleryClusters(context: GalleryImportRequestContext, runId: unknown): Promise<number | null> {
  try {
    const { count, error } = await context.serviceClient
      .from('gallery_import_cluster_results')
      .select('id, gallery_import_chunks!inner(run_id)', { count: 'exact', head: true })
      .eq('state', 'pending')
      .eq('gallery_import_chunks.run_id', runId as string);
    if (error || typeof count !== 'number') return null;
    return count;
  } catch {
    return null;
  }
}

export async function clientRun(context: GalleryImportRequestContext, run: Record<string, unknown>) {
  const { data: stored } = await context.serviceClient.from('gallery_import_runs')
    .select('limit_snapshot').eq('id', run.id).maybeSingle();
  const limits = isRecord(stored?.limit_snapshot) ? stored.limit_snapshot : {};
  const numberAt = (key: string, fallback: number) => typeof limits[key] === 'number' ? limits[key] : fallback;
  return {
    id: run.id,
    familyId: run.familyId,
    status: run.status,
    reviewExpiresAt: run.expiresAt ?? null,
    readyCandidates: run.readyCandidates ?? 0,
    // SQL returns this as an aggregate integer. Do not reuse the former
    // `chunks` array name: a polymorphic field quietly breaks checkpoint and
    // resume callers when a run is reloaded from the server.
    chunkCount: finiteInteger(run.chunks, 0, 500) ? run.chunks : 0,
    // Additive, optional: older clients that don't read it are unaffected.
    // null means "server could not compute it right now" -- never rendered
    // as a number, never treated as 0.
    pendingClusters: await countPendingGalleryClusters(context, run.id),
    limits: {
      maxClusters: numberAt('maxCandidatesPerRun', 60),
      maxAssetsPerCluster: numberAt('maxImagesPerCluster', 10),
      maxChunks: numberAt('maxChunksPerRun', 20),
    },
  };
}

export function parseGalleryImportManifest(body: Record<string, unknown>) {
  const clusters = body.clusters;
  if (!Array.isArray(clusters) || clusters.length < 1 || clusters.length > 50) return null;
  const flattened: Array<Record<string, unknown>> = [];
  const signatures = new Set<string>();
  for (const cluster of clusters) {
    if (!isRecord(cluster)) return null;
    const signature = cluster.clusterSignature ?? cluster.signature;
    const assets = cluster.assets;
    if (typeof signature !== 'string' || !CLUSTER_SIGNATURE.test(signature) ||
      !Array.isArray(assets) || assets.length < 1 || assets.length > 10 || signatures.has(signature)) return null;
    signatures.add(signature);
    for (const asset of assets) {
      if (!isRecord(asset)) return null;
      // Date is canonicalized in the device's local calendar before this
      // request. Never derive it from a UTC epoch here: that silently moves
      // late-night photos into a different family-memory date.
      const captureDate = typeof asset.captureDate === 'string' ? asset.captureDate : null;
      if (!isUuid(asset.opaqueToken ?? asset.assetToken) ||
        !captureDate || !isCalendarDate(captureDate) ||
        !(asset.width === null || finiteInteger(asset.width, 1, 100_000)) || !(asset.height === null || finiteInteger(asset.height, 1, 100_000)) ||
        typeof asset.isFavorite !== 'boolean') return null;
      // Keep raw OS IDs and local URI/file fields out of the server even if a
      // future client accidentally serializes its checkpoint object.
      if (['id', 'assetId', 'localUri', 'uri', 'filename', 'location', 'exif'].some((key) => key in asset)) return null;
      flattened.push({
        opaqueToken: asset.opaqueToken ?? asset.assetToken,
        clusterSignature: signature,
        captureDate,
        width: asset.width,
        height: asset.height,
        isFavorite: asset.isFavorite,
      });
    }
  }
  if (flattened.length > 500 || new Set(flattened.map((asset) => asset.opaqueToken as string)).size !== flattened.length) return null;
  return { clusters, assets: flattened };
}

export async function createGalleryImportRun(context: GalleryImportRequestContext): Promise<Response> {
  const { familyId, algorithmVersion, consentVersion, permissionMode } = context.body;
  if (!isUuid(familyId) || algorithmVersion !== 'gallery-v1' || consentVersion !== 'gallery-import-v1' ||
    !['full', 'limited'].includes(String(permissionMode))) {
    return errorResponse('Invalid gallery import request', 400, 'validation_error');
  }
  // A server-generated capability is returned only once to the originating
  // device. It is intentionally absent from analytics, logs, and any later
  // active-run lookup, so another signed-in device cannot control this run.
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const capability = [...random].map((part) => part.toString(16).padStart(2, '0')).join('');
  const result = await userRpc<string>(context, 'create_gallery_import_run', {
    p_family_id: familyId,
    p_capability: capability,
    p_algorithm_version: algorithmVersion,
    p_consent_version: consentVersion,
    p_permission_mode: permissionMode === 'full' ? 'all' : 'limited',
  });
  if (result.response || !result.data) return result.response ?? errorResponse('Unable to start gallery import', 500, 'internal_error');
  const run = await assertRun(context, result.data, capability);
  if (run.response || !run.data) return run.response ?? errorResponse('Unable to start gallery import', 500, 'internal_error');
  return jsonResponse({ run: await clientRun(context, run.data), runCapability: capability }, 201);
}

export async function getGalleryImportRun(context: GalleryImportRequestContext): Promise<Response> {
  const result = await assertRun(context, context.body.runId, context.body.capability ?? context.body.runCapability);
  if (result.response || !result.data) return result.response ?? errorResponse('Gallery import item not found', 404, 'not_found');
  return jsonResponse(await clientRun(context, result.data));
}

export async function registerGalleryImportChunk(context: GalleryImportRequestContext): Promise<Response> {
  const { runId, runCapability, ordinal } = context.body;
  const run = await assertRun(context, runId, runCapability);
  if (run.response) return run.response;
  if (!finiteInteger(ordinal, 0, 500)) return errorResponse('Invalid gallery import request', 400, 'validation_error');
  const manifest = parseGalleryImportManifest(context.body);
  if (!manifest) return errorResponse('Invalid gallery import manifest', 400, 'validation_error');
  const chunk = await userRpc<string>(context, 'register_gallery_import_chunk', {
    p_run_id: runId, p_capability: runCapability, p_ordinal: ordinal,
    p_cluster_count: manifest.clusters.length, p_asset_count: manifest.assets.length,
  });
  if (chunk.response || !chunk.data) return chunk.response ?? errorResponse('Unable to register gallery import chunk', 500, 'internal_error');
  const assets = await userRpc<Record<string, unknown>>(context, 'register_gallery_import_assets', {
    p_run_id: runId, p_chunk_id: chunk.data, p_capability: runCapability, p_assets: manifest.assets,
  });
  if (assets.response) return assets.response;
  const acceptedAssetTokens = Array.isArray(assets.data?.acceptedAssetTokens)
    ? assets.data.acceptedAssetTokens.filter(isUuid)
    : [];
  const suppressedClusterSignatures = Array.isArray(assets.data?.suppressedClusterSignatures)
    ? assets.data.suppressedClusterSignatures.filter((value): value is string => typeof value === 'string' && CLUSTER_SIGNATURE.test(value))
    : [];
  return jsonResponse({ chunkId: chunk.data, acceptedAssetTokens, suppressedClusterSignatures });
}

export async function getGalleryImportUploadUrl(context: GalleryImportRequestContext): Promise<Response> {
  const { runId, runCapability, assetToken, contentType, byteLength, sha256, previewWidth, previewHeight } = context.body;
  const run = await assertRun(context, runId, runCapability);
  if (run.response) return run.response;
  if (!isUuid(assetToken) || normalizedContentType(contentType) !== PREVIEW_CONTENT_TYPE ||
    !finiteInteger(byteLength, 1, MAX_PREVIEW_BYTES) || !finiteInteger(previewWidth, 1, 512) || !finiteInteger(previewHeight, 1, 512) ||
    typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    return errorResponse('Invalid preview upload request', 400, 'validation_error');
  }
  const { data: asset, error } = await context.serviceClient.from('gallery_import_assets')
    .select('opaque_token, preview_object_key, run_id').eq('run_id', runId).eq('opaque_token', assetToken).maybeSingle();
  if (error || !asset || asset.preview_object_key) return errorResponse('Gallery preview is not available for upload', 409, 'not_available');
  const objectKey = previewKey(context.userId, runId as string, assetToken as string);
  const metadata = {
    sha256: sha256 as string,
    bytes: String(byteLength), width: String(previewWidth), height: String(previewHeight),
  };
  const uploadUrl = await createPresignedPutUrl(objectKey, PREVIEW_CONTENT_TYPE, R2_URL_EXPIRY.upload, metadata);
  return jsonResponse({
    uploadUrl,
    objectKey,
    expiresIn: R2_URL_EXPIRY.upload,
    requiredHeaders: galleryUploadRequiredHeaders(PREVIEW_CONTENT_TYPE, metadata),
  });
}

async function verifyObject(
  objectKey: string,
  contentType: string,
  byteLength: number,
  sha256?: string,
  width?: number,
  height?: number,
): Promise<boolean> {
  const head = await headObject(objectKey);
  return Boolean(head && head.contentLength === byteLength && normalizedContentType(head.contentType) === contentType &&
    (sha256 === undefined || head.metadata.sha256?.toLowerCase() === sha256) && head.metadata.bytes === String(byteLength) &&
    (width === undefined || head.metadata.width === String(width)) && (height === undefined || head.metadata.height === String(height)));
}

export type GalleryDispatchResult = 'accepted' | 'mark_failed' | 'dispatch_unavailable';

/**
 * The Workflow is allowed to read a chunk only once its server-side state is
 * `dispatched`.  Mark before sending the deterministic workflow create
 * request: dispatch retries are then harmless and Cloudflare treats the
 * duplicate ID as accepted, while a Worker can never win a status race.
 */
export async function markAndDispatchGalleryChunk(
  serviceClient: Pick<SupabaseClient, 'rpc'>,
  input: { chunkId: string; workerUrl: string; signingSecret: string; fetch?: typeof fetch },
): Promise<GalleryDispatchResult> {
  const workflowId = `gallery:${input.chunkId}`;
  const { data: marked, error: markedError } = await serviceClient.rpc('mark_gallery_chunk_dispatched', {
    p_chunk_id: input.chunkId,
    p_workflow_id: workflowId,
  });
  if (markedError || marked !== true) return 'mark_failed';

  const raw = JSON.stringify({ chunkId: input.chunkId });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(input.signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${raw}`)))]
    .map((part) => part.toString(16).padStart(2, '0')).join('');
  try {
    const response = await (input.fetch ?? fetch)(`${input.workerUrl.replace(/\/$/, '')}/dispatch/gallery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dispatch-timestamp': timestamp, 'x-dispatch-nonce': nonce, 'x-dispatch-signature': signature },
      body: raw,
    });
    return response.ok ? 'accepted' : 'dispatch_unavailable';
  } catch {
    // The DB fence has already made this retry-safe. Keep an unavailable
    // Worker transport distinct from validation/authorization failures.
    return 'dispatch_unavailable';
  }
}

export async function dispatchGalleryImportChunk(context: GalleryImportRequestContext): Promise<Response> {
  const { runId, runCapability, chunkId } = context.body;
  const run = await assertRun(context, runId, runCapability);
  if (run.response) return run.response;
  if (!isUuid(chunkId)) return errorResponse('Invalid gallery import request', 400, 'validation_error');
  const uploads = context.body.previewUploads;
  if (!Array.isArray(uploads) || uploads.length < 1 || uploads.length > 500) return errorResponse('Preview upload receipts are required', 400, 'validation_error');
  const { data: expectedAssets, error: expectedAssetsError } = await context.serviceClient
    .from('gallery_import_assets').select('opaque_token').eq('run_id', runId).eq('chunk_id', chunkId);
  if (expectedAssetsError || !expectedAssets || expectedAssets.length === 0) {
    return errorResponse('Gallery import chunk is not available', 409, 'not_available');
  }
  const expectedTokens = new Set(expectedAssets.map((asset) => asset.opaque_token));
  if (uploads.length !== expectedTokens.size) return errorResponse('Every registered preview must be uploaded before dispatch.', 409, 'preview_not_ready');
  const seen = new Set<string>();
  for (const upload of uploads) {
    if (!isRecord(upload) || !isUuid(upload.assetToken) || seen.has(upload.assetToken) || normalizedContentType(upload.contentType) !== PREVIEW_CONTENT_TYPE ||
      !finiteInteger(upload.byteLength, 1, MAX_PREVIEW_BYTES) || !finiteInteger(upload.previewWidth, 1, 512) || !finiteInteger(upload.previewHeight, 1, 512) ||
      typeof upload.sha256 !== 'string' || !SHA256.test(upload.sha256)) {
      return errorResponse('Invalid preview upload receipt', 400, 'validation_error');
    }
    seen.add(upload.assetToken);
    if (!expectedTokens.has(upload.assetToken)) return errorResponse('Preview upload does not belong to this chunk', 400, 'validation_error');
    const objectKey = previewKey(context.userId, runId as string, upload.assetToken);
    if (!(await verifyObject(objectKey, PREVIEW_CONTENT_TYPE, upload.byteLength, upload.sha256, upload.previewWidth, upload.previewHeight))) {
      return errorResponse('A preview upload is incomplete. Please retry it.', 409, 'preview_not_ready');
    }
    const { error: recordError } = await context.serviceClient.rpc('record_gallery_import_preview_upload', {
      p_run_id: runId, p_opaque_token: upload.assetToken, p_object_key: objectKey, p_content_type: PREVIEW_CONTENT_TYPE,
      p_width: upload.previewWidth, p_height: upload.previewHeight, p_bytes: upload.byteLength, p_sha256: upload.sha256,
    });
    if (recordError) return rpcFailure(recordError);
  }
  if (expectedTokens.size !== seen.size || [...expectedTokens].some((token) => !seen.has(token))) {
    return errorResponse('Every registered preview must be uploaded before dispatch.', 409, 'preview_not_ready');
  }
  const workerUrl = Deno.env.get('GALLERY_WORKER_URL');
  const secret = Deno.env.get('GALLERY_DISPATCH_SIGNING_SECRET');
  if (!workerUrl || !secret) return errorResponse('Gallery import is temporarily unavailable', 503, 'unavailable');
  const dispatch = await markAndDispatchGalleryChunk(context.serviceClient, { chunkId, workerUrl, signingSecret: secret });
  if (dispatch === 'mark_failed') return errorResponse('Gallery previews are not ready for dispatch', 409, 'preview_not_ready');
  if (dispatch === 'dispatch_unavailable') return errorResponse('Gallery import dispatch is temporarily unavailable', 503, 'dispatch_unavailable');
  return jsonResponse({ accepted: true });
}

function candidateResponse(row: Record<string, unknown>, previewUrls: string[]) {
  const clientStatus = row.status === 'staged' ? 'ready'
    : row.status === 'posting' ? 'approving'
    : row.status === 'unavailable' ? 'expired'
    : row.status;
  return {
    id: row.id, caption: row.caption, memoryDate: row.memory_date,
    selectedAssetTokens: row.selected_asset_tokens, familyMemberIds: row.family_member_ids,
    status: clientStatus, previewUrls,
  };
}

export async function getGalleryImportCandidates(context: GalleryImportRequestContext): Promise<Response> {
  const { runId, capability } = context.body;
  const candidates = await userRpc<Array<Record<string, unknown>>>(context, 'get_gallery_import_candidates', { p_run_id: runId, p_capability: capability });
  if (candidates.response) return candidates.response;
  const rows = candidates.data ?? [];
  const allTokens = rows.flatMap((row) => Array.isArray(row.selected_asset_tokens) ? row.selected_asset_tokens : []).filter(isUuid);
  const { data: assets } = allTokens.length === 0 ? { data: [] as Array<{ opaque_token: string; preview_object_key: string | null }> } : await context.serviceClient
    .from('gallery_import_assets').select('opaque_token, preview_object_key').eq('run_id', runId).in('opaque_token', allTokens);
  const keys = (assets ?? []).map((asset) => asset.preview_object_key).filter((key): key is string => Boolean(key));
  const urls = keys.length ? await createPresignedGetUrls(keys, 300) : {};
  const keyByToken = new Map((assets ?? []).map((asset) => [asset.opaque_token, asset.preview_object_key]));
  return jsonResponse({ candidates: rows.map((row) => candidateResponse(row,
    (Array.isArray(row.selected_asset_tokens) ? row.selected_asset_tokens : []).map((token) => {
      const key = keyByToken.get(token as string); return key ? urls[key] : undefined;
    }).filter((url): url is string => Boolean(url)),
  )) });
}

async function candidateRun(context: GalleryImportRequestContext, candidateId: unknown, capability: unknown): Promise<CandidateRunResult> {
  if (!isUuid(candidateId) || !hasText(capability, 512)) return { response: errorResponse('Invalid gallery import request', 400, 'validation_error') };
  const { data: candidate, error } = await context.serviceClient.from('gallery_import_candidates').select('id, run_id').eq('id', candidateId).maybeSingle();
  if (error || !candidate) return { response: errorResponse('Gallery import item not found', 404, 'not_found') };
  const run = await assertRun(context, candidate.run_id, capability);
  if (run.response || !run.data) return { response: run.response ?? errorResponse('Gallery import item not found', 404, 'not_found') };
  return { candidate, run: run.data };
}

export async function setGalleryImportCandidateSkip(context: GalleryImportRequestContext): Promise<Response> {
  const verified = await candidateRun(context, context.body.candidateId, context.body.capability);
  if (verified.response) return verified.response;
  // A deliberate, capability-bound in-run undo is permitted. The permanent
  // receipt still suppresses the card in later scans/runs; no endpoint ever
  // auto-restores or resurfaces it.
  if (typeof context.body.skip !== 'boolean') return errorResponse('Invalid gallery import request', 400, 'validation_error');
  const result = await userRpc<Record<string, unknown>>(context, 'set_gallery_import_candidate_skip', {
    p_candidate_id: context.body.candidateId, p_capability: context.body.capability, p_skip: context.body.skip,
  });
  if (result.response || !result.data) return result.response ?? errorResponse('Unable to update gallery suggestion', 500, 'internal_error');
  return jsonResponse({ candidate: candidateResponse(result.data, []) });
}

export function isValidGalleryImportCandidateDraft(input: Record<string, unknown>): boolean {
  const { caption, memoryDate, assetTokens, familyMemberIds } = input;
  return typeof caption === 'string' && caption.trim().length >= 1 && caption.length <= 1_000 &&
    hasText(memoryDate, 10) && isCalendarDate(memoryDate) &&
    Array.isArray(assetTokens) && assetTokens.length >= 1 && assetTokens.length <= 10 && assetTokens.every(isUuid) &&
    Array.isArray(familyMemberIds) && familyMemberIds.every(isUuid);
}

export async function updateGalleryImportCandidate(context: GalleryImportRequestContext): Promise<Response> {
  const verified = await candidateRun(context, context.body.candidateId, context.body.capability);
  if (verified.response) return verified.response;
  if (!isValidGalleryImportCandidateDraft(context.body)) return errorResponse('Invalid gallery suggestion', 400, 'validation_error');
  const { caption, memoryDate, assetTokens, familyMemberIds } = context.body as {
    caption: string; memoryDate: string; assetTokens: string[]; familyMemberIds: string[];
  };
  const result = await userRpc<Record<string, unknown>>(context, 'update_gallery_import_candidate_draft', {
    p_candidate_id: context.body.candidateId, p_capability: context.body.capability, p_caption: caption.trim(), p_memory_date: memoryDate,
    p_asset_tokens: assetTokens, p_family_member_ids: familyMemberIds,
  });
  if (result.response || !result.data) return result.response ?? errorResponse('Unable to update gallery suggestion', 500, 'internal_error');
  return jsonResponse({ candidate: candidateResponse(result.data, []) });
}

export async function beginGalleryImportApproval(context: GalleryImportRequestContext): Promise<Response> {
  const verified = await candidateRun(context, context.body.candidateId, context.body.capability);
  if (verified.response) return verified.response;
  const assets = context.body.assets;
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > 10 || !assets.every((asset) =>
    isRecord(asset) && isUuid(asset.assetToken) && ORIGINAL_CONTENT_TYPES.has(String(normalizedContentType(asset.contentType))))) {
    return errorResponse('Invalid approval asset manifest', 400, 'validation_error');
  }
  const result = await userRpc<Record<string, unknown>>(context, 'begin_gallery_import_approval', {
    p_candidate_id: context.body.candidateId, p_capability: context.body.capability, p_selected_assets: assets,
  });
  if (result.response || !result.data) return result.response ?? errorResponse('Unable to begin approval', 500, 'internal_error');
  return jsonResponse(result.data);
}

async function approvalAsset(context: GalleryImportRequestContext): Promise<ApprovalAssetResult> {
  const verified = await candidateRun(context, context.body.candidateId, context.body.capability);
  if (verified.response) return { response: verified.response };
  const { leaseId, assetToken } = context.body;
  if (!isUuid(leaseId) || !isUuid(assetToken)) return { response: errorResponse('Invalid approval upload request', 400, 'validation_error') };
  const { data: lease, error } = await context.serviceClient.from('gallery_import_approval_leases')
    .select('id, candidate_id, state, expires_at, expected_assets').eq('id', leaseId).eq('candidate_id', context.body.candidateId).maybeSingle();
  if (error || !lease || !['reserved', 'uploading', 'finalizing'].includes(lease.state) || Date.parse(lease.expires_at) <= Date.now()) {
    return { response: errorResponse('Approval lease is not available', 409, 'not_available') };
  }
  const expected = Array.isArray(lease.expected_assets) ? lease.expected_assets.find((asset) => isRecord(asset) && asset.assetToken === assetToken) : null;
  if (!isRecord(expected) || typeof expected.objectKey !== 'string' || !ORIGINAL_CONTENT_TYPES.has(String(expected.contentType))) {
    return { response: errorResponse('Approval asset is not available', 404, 'not_found') };
  }
  return { lease, expected };
}

export async function getGalleryImportApprovalUploadUrl(context: GalleryImportRequestContext): Promise<Response> {
  const approval = await approvalAsset(context);
  if (approval.response) return approval.response;
  const { contentType, byteLength } = context.body;
  if (normalizedContentType(contentType) !== approval.expected?.contentType || !finiteInteger(byteLength, 1, MAX_ORIGINAL_BYTES) ||
    !ORIGINAL_CONTENT_TYPES.has(String(normalizedContentType(contentType)))) return errorResponse('Invalid approval upload request', 400, 'validation_error');
  const metadata = {
    bytes: String(byteLength),
  };
  const uploadUrl = await createPresignedPutUrl(
    approval.expected?.objectKey as string,
    approval.expected?.contentType as string,
    R2_URL_EXPIRY.upload,
    metadata,
  );
  return jsonResponse({
    objectKey: approval.expected?.objectKey,
    uploadUrl,
    expiresIn: R2_URL_EXPIRY.upload,
    requiredHeaders: galleryUploadRequiredHeaders(approval.expected?.contentType as string, metadata),
  });
}

export async function recordGalleryImportApprovalUpload(context: GalleryImportRequestContext): Promise<Response> {
  const approval = await approvalAsset(context);
  if (approval.response) return approval.response;
  const { contentType, byteLength, aspectRatio } = context.body;
  if (normalizedContentType(contentType) !== approval.expected?.contentType || !finiteInteger(byteLength, 1, MAX_ORIGINAL_BYTES) ||
    (aspectRatio !== undefined && (typeof aspectRatio !== 'number' || aspectRatio < 0.1 || aspectRatio > 10))) {
    return errorResponse('Invalid approval upload request', 400, 'validation_error');
  }
  if (!(await verifyObject(approval.expected?.objectKey as string, approval.expected?.contentType as string, byteLength))) {
    return errorResponse('The original upload could not be verified', 409, 'object_not_verified');
  }
  const { data, error } = await context.serviceClient.rpc('record_gallery_import_approval_upload', {
    p_lease_id: context.body.leaseId, p_object_key: approval.expected?.objectKey, p_content_type: approval.expected?.contentType,
    p_aspect_ratio: aspectRatio ?? null, p_byte_length: byteLength, p_sha256: null,
  });
  if (error) return rpcFailure(error);
  return jsonResponse({ recorded: data === true });
}

export async function finalizeGalleryImportCandidate(context: GalleryImportRequestContext): Promise<Response> {
  const verified = await candidateRun(context, context.body.candidateId, context.body.capability);
  if (verified.response) return verified.response;
  const { data: lease, error: leaseError } = await context.serviceClient
    .from('gallery_import_approval_leases')
    .select('uploaded_assets')
    .eq('candidate_id', context.body.candidateId)
    .maybeSingle();
  if (leaseError || !lease || !Array.isArray(lease.uploaded_assets) || lease.uploaded_assets.length < 1) {
    return errorResponse('Approval uploads are not ready', 409, 'object_not_verified');
  }
  // A valid presigned URL can remain live after the upload receipt is stored.
  // Re-HEAD each persisted receipt immediately before the atomic finalization
  // RPC, preventing a later overwrite from being accepted as the memory.
  for (const asset of lease.uploaded_assets) {
    if (!isRecord(asset) || typeof asset.objectKey !== 'string' ||
      !ORIGINAL_CONTENT_TYPES.has(String(asset.contentType)) || !finiteInteger(asset.byteLength, 1, MAX_ORIGINAL_BYTES) ||
      (asset.sha256 !== undefined && (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256))) ||
      !(await verifyObject(asset.objectKey, asset.contentType as string, asset.byteLength, asset.sha256 as string | undefined))) {
      return errorResponse('An original upload could not be verified', 409, 'object_not_verified');
    }
  }
  const result = await userRpc<string>(context, 'finalize_gallery_import_candidate', {
    p_candidate_id: context.body.candidateId, p_capability: context.body.capability,
  });
  if (result.response || !result.data) return result.response ?? errorResponse('Unable to finalize gallery memory', 500, 'internal_error');
  return jsonResponse({ memoryId: result.data });
}

export async function cancelGalleryImportRun(context: GalleryImportRequestContext): Promise<Response> {
  const { runId, capability } = context.body;
  const result = await userRpc<boolean>(context, 'cancel_gallery_import_run', { p_run_id: runId, p_capability: capability });
  if (result.response) return result.response;
  return jsonResponse({ cancelled: result.data === true });
}

export async function completeGalleryImportRun(context: GalleryImportRequestContext): Promise<Response> {
  const { runId, capability } = context.body;
  const result = await userRpc<boolean>(context, 'complete_gallery_import_run', { p_run_id: runId, p_capability: capability });
  if (result.response) return result.response;
  return jsonResponse({ completed: result.data === true });
}

export async function getGalleryCaptionSettings(context: GalleryImportRequestContext): Promise<Response> {
  if (!isUuid(context.body.familyId)) return errorResponse('Invalid gallery settings request', 400, 'validation_error');
  const result = await userRpc<Record<string, unknown>>(context, 'get_gallery_caption_settings', { p_family_id: context.body.familyId });
  if (result.response || !result.data) return result.response ?? errorResponse('Unable to load gallery settings', 500, 'internal_error');
  return jsonResponse(result.data);
}

export async function updateGalleryCaptionSettings(context: GalleryImportRequestContext): Promise<Response> {
  const { familyId, language, instructions } = context.body;
  if (!isUuid(familyId) || !hasText(language, 35) || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language) ||
    typeof instructions !== 'string' || instructions.length > 500 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(instructions)) {
    return errorResponse('Invalid gallery settings request', 400, 'validation_error');
  }
  const result = await userRpc<Record<string, unknown>>(context, 'update_gallery_caption_settings', {
    p_family_id: familyId, p_language: language, p_instructions: instructions,
  });
  if (result.response || !result.data) return result.response ?? errorResponse('Unable to save gallery settings', 500, 'internal_error');
  return jsonResponse(result.data);
}
