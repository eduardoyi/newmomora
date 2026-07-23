import { BridgeError, callBridgeAt } from './bridge';
import type {
  BridgePortraitFailResponse,
  BridgePortraitGetInputResponse,
  BridgePortraitPublishResponse,
  BridgePortraitReconcileResponse,
  BridgePortraitReserveAttemptResponse,
  BridgeAuthorizeUploadResponse,
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

  return {
    jobId: value.jobId,
    outputKey: value.outputKey,
    oldPortraitKey: value.oldPortraitKey,
    providerDeadlineAt: value.providerDeadlineAt,
    prompt: value.prompt,
    sourcePhotoKey: value.sourcePhotoKey,
    styleReferenceKey: value.styleReferenceKey,
  };
}

async function callPortraitBridge<T>(
  env: Env,
  operation: 'get_input' | 'reserve_attempt' | 'authorize_upload' | 'record_upload_complete' |
    'publish' | 'fail' | 'reconcile' | 'retrigger_memories',
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
): Promise<BridgePortraitReserveAttemptResponse> {
  const response = await callPortraitBridge<unknown>(env, 'reserve_attempt', {
    jobId,
    provider,
    model,
    attemptNumber,
  });
  if (!isRecord(response) || typeof response.reserved !== 'boolean') return invalidBridgeResponse();
  return { reserved: response.reserved };
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

/**
 * This uses a bridge-only credential rather than a user's expiring JWT. The
 * bridge revalidates the original actor's current family-manager authority.
 */
export async function retriggerPortraitDependentMemories(env: Env, jobId: string): Promise<void> {
  await callPortraitBridge<unknown>(env, 'retrigger_memories', { jobId });
}
