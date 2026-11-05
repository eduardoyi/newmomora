import { BridgeError, callBridgeAt } from './bridge';
import type {
  BridgePortraitFailResponse,
  BridgePortraitGetInputResponse,
  BridgePortraitPublishResponse,
  BridgePortraitReconcileResponse,
  BridgePortraitReserveAttemptResponse,
  BridgeAuthorizeUploadResponse,
  BridgeMotionFailResponse,
  BridgeMotionInput,
  BridgeMotionPublishResponse,
  BridgeMotionStartResponse,
  BridgeRecordUploadCompleteResponse,
  IllustrationModel,
  PortraitWorkflowJobInput,
} from './types';

type PortraitProvider = 'primary' | 'fallback';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function invalidBridgeResponse(): never {
  throw new BridgeError('BRIDGE_INVALID_RESPONSE', false);
}

function parseJob(value: unknown): PortraitWorkflowJobInput {
  if (!isRecord(value) ||
    typeof value.jobId !== 'string' ||
    typeof value.outputKey !== 'string' ||
    !isNullableString(value.oldPortraitKey) ||
    typeof value.providerDeadlineAt !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.sourcePhotoKey !== 'string' ||
    typeof value.styleReferenceKey !== 'string') {
    return invalidBridgeResponse();
  }

  const base = {
    jobId: value.jobId,
    outputKey: value.outputKey,
    oldPortraitKey: value.oldPortraitKey,
    providerDeadlineAt: value.providerDeadlineAt,
    prompt: value.prompt,
    sourcePhotoKey: value.sourcePhotoKey,
    styleReferenceKey: value.styleReferenceKey,
  };
  if (value.providerProtocolVersion === 2 && typeof value.usageRequestId === 'string') {
    return { ...base, providerProtocolVersion: 2, usageRequestId: value.usageRequestId };
  }
  if ((value.providerProtocolVersion === undefined || value.providerProtocolVersion === null ||
    value.providerProtocolVersion === 1) &&
    (value.usageRequestId === undefined || value.usageRequestId === null)) return base;
  return invalidBridgeResponse();
}

async function callPortraitBridge<T>(
  env: Env,
  operation: 'get_input' | 'reserve_attempt' | 'authorize_upload' | 'record_upload_complete' |
    'publish' | 'fail' | 'reconcile' | 'retrigger_memories' | 'record_usage' |
    'motion_start' | 'motion_get_input' | 'motion_record_usage' | 'motion_publish' | 'motion_fail',
  payload: Record<string, unknown>,
): Promise<T> {
  return await callBridgeAt<T>(
    env.PORTRAIT_SUPABASE_BRIDGE_URL,
    env.PORTRAIT_SUPABASE_BRIDGE_HMAC_SECRET,
    operation,
    payload,
  );
}

export async function getPortraitInput(
  env: Env,
  jobId: string,
): Promise<BridgePortraitGetInputResponse> {
  const response = await callPortraitBridge<unknown>(env, 'get_input', { jobId });
  if (!isRecord(response)) return invalidBridgeResponse();
  return { job: parseJob(response.job) };
}

export async function reservePortraitAttempt(
  env: Env,
  jobId: string,
  provider: PortraitProvider,
  model: IllustrationModel,
  attemptNumber: number,
  usageRequestId: string,
  aiCallId: string,
): Promise<BridgePortraitReserveAttemptResponse> {
  const response = await callPortraitBridge<unknown>(env, 'reserve_attempt', {
    jobId,
    provider,
    model,
    attemptNumber,
    usageRequestId,
    aiCallId,
    protocolVersion: 2,
  });
  if (!isRecord(response) || response.protocolVersion !== 2 ||
    (response.outcome !== 'reserved_now' && response.outcome !== 'already_reserved' && response.outcome !== 'denied')) {
    return invalidBridgeResponse();
  }
  return { outcome: response.outcome, protocolVersion: 2 };
}

export async function reservePortraitAttemptV1(
  env: Env,
  jobId: string,
  provider: PortraitProvider,
  model: IllustrationModel,
  attemptNumber: number,
): Promise<boolean> {
  const response = await callPortraitBridge<unknown>(env, 'reserve_attempt', { jobId, provider, model, attemptNumber });
  if (!isRecord(response)) return invalidBridgeResponse();
  if (typeof response.reserved === 'boolean') return response.reserved;
  if (response.protocolVersion === 2 &&
    (response.outcome === 'reserved_now' || response.outcome === 'already_reserved' || response.outcome === 'denied')) {
    return response.outcome === 'reserved_now';
  }
  return invalidBridgeResponse();
}

export async function recordPortraitUsage(env: Env, payload: Record<string, unknown>): Promise<void> {
  await callPortraitBridge<unknown>(env, 'record_usage', payload);
}

export async function authorizePortraitUpload(
  env: Env,
  jobId: string,
  outputKey: string,
): Promise<BridgeAuthorizeUploadResponse> {
  const response = await callPortraitBridge<unknown>(env, 'authorize_upload', { jobId, outputKey });
  if (!isRecord(response) ||
    typeof response.authorized !== 'boolean' ||
    (typeof response.uploadToken !== 'string' && response.uploadToken !== null) ||
    typeof response.existingLease !== 'boolean') {
    return invalidBridgeResponse();
  }
  return {
    authorized: response.authorized,
    uploadToken: response.uploadToken,
    existingLease: response.existingLease,
  };
}

export async function recordPortraitUploadComplete(
  env: Env,
  jobId: string,
  outputKey: string,
  uploadToken: string,
): Promise<BridgeRecordUploadCompleteResponse> {
  const response = await callPortraitBridge<unknown>(env, 'record_upload_complete', {
    jobId,
    outputKey,
    uploadToken,
  });
  if (!isRecord(response) || typeof response.completed !== 'boolean') return invalidBridgeResponse();
  return { completed: response.completed };
}

function parsePublication(value: unknown): BridgePortraitPublishResponse {
  if (!isRecord(value) ||
    typeof value.published !== 'boolean' ||
    !isNullableString(value.oldPortraitKey) ||
    typeof value.deleteOutput !== 'boolean' ||
    (value.alreadyPublished !== undefined && typeof value.alreadyPublished !== 'boolean')) {
    return invalidBridgeResponse();
  }
  return {
    // The bridge normally normalizes the RPC's `already_published` outcome.
    // Keep this defensive normalization here too: a post-CAS replay must
    // never enter cleanup and delete the just-published object.
    published: value.published || value.alreadyPublished === true,
    oldPortraitKey: value.oldPortraitKey,
    deleteOutput: value.published || value.alreadyPublished === true ? false : value.deleteOutput,
  };
}

export async function publishPortrait(
  env: Env,
  jobId: string,
  outputKey: string,
  model: IllustrationModel,
): Promise<BridgePortraitPublishResponse> {
  const response = await callPortraitBridge<unknown>(env, 'publish', { jobId, outputKey, model });
  return parsePublication(response);
}

export async function reconcilePortraitPublication(
  env: Env,
  jobId: string,
  outputKey: string,
  model: IllustrationModel,
): Promise<BridgePortraitReconcileResponse> {
  const response = await callPortraitBridge<unknown>(env, 'reconcile', { jobId, outputKey, model });
  return parsePublication(response);
}

export async function failPortrait(
  env: Env,
  jobId: string,
  errorCode: string,
): Promise<BridgePortraitFailResponse> {
  const response = await callPortraitBridge<unknown>(env, 'fail', { jobId, errorCode });
  if (!isRecord(response) ||
    typeof response.failed !== 'boolean' ||
    !isNullableString(response.outputKey) ||
    typeof response.deleteOutput !== 'boolean') {
    return invalidBridgeResponse();
  }
  return {
    failed: response.failed,
    outputKey: response.outputKey,
    deleteOutput: response.deleteOutput,
  };
}

/** Upper bound the bridge may ask the Worker to wait (floor 30s + 1s margin). */
export const MAX_RETRIGGER_RETRY_AFTER_MS = 31_000;

/**
 * This uses a bridge-only credential rather than a user's expiring JWT. The
 * bridge revalidates the original actor's current family-manager authority.
 *
 * Returns the bridge's optional `retryAfterMs` hint (set when dependent
 * pending memories were too young to retrigger yet), or null when it is
 * absent or invalid. An older bridge omits the field, which is also null.
 */
export async function retriggerPortraitDependentMemories(env: Env, jobId: string): Promise<number | null> {
  const response = await callPortraitBridge<unknown>(env, 'retrigger_memories', { jobId });
  if (!isRecord(response)) return null;
  const value = response.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 &&
    value <= MAX_RETRIGGER_RETRY_AFTER_MS
    ? value
    : null;
}

// ── Living-portrait motion ────────────────────────────────────────────────
// Same bridge URL/secret/signing as the portrait operations above. For every
// motion_* operation except motion_start, `jobId` carries the portrait
// VERSION id (the bridge contract reuses the required UUID field).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MOTION_MODELS: ReadonlySet<string> = new Set([
  'gpt-image-2.6-flare', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5',
]);
const MOTION_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

/** `jobId` is the portrait job id; the bridge resolves its version and claims motion. */
export async function startPortraitMotion(env: Env, portraitJobId: string): Promise<BridgeMotionStartResponse> {
  const response = await callPortraitBridge<unknown>(env, 'motion_start', { jobId: portraitJobId });
  if (!isRecord(response) || typeof response.started !== 'boolean') return invalidBridgeResponse();
  if (response.started) {
    if (typeof response.versionId !== 'string' || !UUID_PATTERN.test(response.versionId) ||
      typeof response.motionToken !== 'string' || !UUID_PATTERN.test(response.motionToken)) {
      return invalidBridgeResponse();
    }
    return { started: true, versionId: response.versionId, motionToken: response.motionToken };
  }
  return { started: false, outcome: typeof response.outcome === 'string' ? response.outcome : 'unknown' };
}

export async function getMotionInput(
  env: Env,
  versionId: string,
  motionToken: string,
): Promise<BridgeMotionInput> {
  const response = await callPortraitBridge<unknown>(env, 'motion_get_input', { jobId: versionId, motionToken });
  if (!isRecord(response) ||
    typeof response.sourceKey !== 'string' || !response.sourceKey ||
    typeof response.outputKey !== 'string' || !response.outputKey ||
    typeof response.prompt !== 'string' || !response.prompt ||
    typeof response.checkPrompt !== 'string' || !response.checkPrompt ||
    !Number.isInteger(response.columns) || (response.columns as number) < 1 || (response.columns as number) > 4 ||
    !Number.isInteger(response.rows) || (response.rows as number) < 1 || (response.rows as number) > 4 ||
    typeof response.size !== 'string' || !/^\d{3,4}x\d{3,4}$/.test(response.size) ||
    typeof response.model !== 'string' || !MOTION_MODELS.has(response.model) ||
    typeof response.quality !== 'string' || !MOTION_LEVELS.has(response.quality) ||
    typeof response.complexity !== 'string' || !MOTION_LEVELS.has(response.complexity)) {
    return invalidBridgeResponse();
  }
  return {
    sourceKey: response.sourceKey,
    outputKey: response.outputKey,
    prompt: response.prompt,
    checkPrompt: response.checkPrompt,
    columns: response.columns as number,
    rows: response.rows as number,
    size: response.size,
    model: response.model as IllustrationModel,
    quality: response.quality as BridgeMotionInput['quality'],
    complexity: response.complexity as BridgeMotionInput['complexity'],
  };
}

export async function recordMotionUsage(env: Env, payload: Record<string, unknown>): Promise<void> {
  await callPortraitBridge<unknown>(env, 'motion_record_usage', payload);
}

export async function publishMotion(
  env: Env,
  versionId: string,
  motionToken: string,
  outputKey: string,
  columns: number,
  rows: number,
): Promise<BridgeMotionPublishResponse> {
  const response = await callPortraitBridge<unknown>(env, 'motion_publish', {
    jobId: versionId, motionToken, outputKey, columns, rows,
  });
  if (!isRecord(response) || typeof response.published !== 'boolean' ||
    (response.oldMotionKey !== undefined && !isNullableString(response.oldMotionKey))) {
    return invalidBridgeResponse();
  }
  return { published: response.published, oldMotionKey: (response.oldMotionKey as string | null | undefined) ?? null };
}

export async function failMotion(
  env: Env,
  versionId: string,
  motionToken: string,
  errorCode: string,
): Promise<BridgeMotionFailResponse> {
  const response = await callPortraitBridge<unknown>(env, 'motion_fail', {
    jobId: versionId, motionToken, errorCode: errorCode.slice(0, 100),
  });
  if (!isRecord(response) || typeof response.failed !== 'boolean') return invalidBridgeResponse();
  return { failed: response.failed };
}
