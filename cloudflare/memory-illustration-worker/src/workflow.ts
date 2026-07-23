import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import {
  authorizeMemoryUpload,
  callBridge,
  BridgeError,
  failMemoryJob,
  recordMemoryUploadComplete,
} from './bridge';
import { editImage, ImageProviderError } from './openai';
import { loadIllustrationReferences } from './references';
import {
  confirmExistingUploadWithLease,
  hasAmbiguousUploadOutput,
  uploadWithLease,
  UploadLeaseError,
} from './upload-lease';
import type {
  BridgeGetInputResponse,
  BridgePublishResponse,
  BridgeReconcileResponse,
  BridgeReserveAttemptResponse,
  GenerationStepResult,
  IllustrationModel,
  WorkflowDispatchPayload,
  WorkflowJobInput,
} from './types';
// This module is deliberately pure and is shared with the Supabase dispatcher
// so both runtimes produce the exact same illustration prompt.
import { buildIllustrationPrompt } from '../../../supabase/functions/_shared/prompts';

const PRIMARY_MODEL: IllustrationModel = 'gpt-image-2';
const FALLBACK_MODEL: IllustrationModel = 'gpt-image-1.5';
const PROVIDER_RESERVE_MS = 30_000;
const PRIMARY_ATTEMPT_WINDOW_MS = 180_000;
const FALLBACK_ATTEMPT_WINDOW_MS = 60_000;
const MINIMUM_PRIMARY_WINDOW_MS = 60_000;
const BRIDGE_STEP_RETRIES = { limit: 3, delay: '2 seconds', backoff: 'exponential' } as const;
const BRIDGE_OPERATION_ATTEMPTS = 3;

interface PublicationResult {
  published: boolean;
  oldIllustrationKey: string | null;
  deleteOutput: boolean;
}

function errorCode(error: unknown): string {
  if (error instanceof ImageProviderError || error instanceof BridgeError || error instanceof UploadLeaseError) {
    return error.code;
  }
  if (
    error instanceof Error &&
    ['NO_USABLE_REFERENCES', 'GENERATION_TIMEOUT', 'ATTEMPT_CAP_EXHAUSTED', 'INVALID_JOB_INPUT'].includes(error.message)
  ) {
    return error.message;
  }
  return 'GENERATION_FAILED';
}

export function canStartProviderAttempt(
  provider: 'primary' | 'fallback',
  deadlineMs: number,
  now = Date.now(),
): boolean {
  const minimumWindowMs = provider === 'primary'
    ? MINIMUM_PRIMARY_WINDOW_MS + FALLBACK_ATTEMPT_WINDOW_MS
    : FALLBACK_ATTEMPT_WINDOW_MS;
  return now + minimumWindowMs + PROVIDER_RESERVE_MS <= deadlineMs;
}

export function providerAttemptTimeoutMs(
  provider: 'primary' | 'fallback',
  deadlineMs: number,
  now = Date.now(),
): number {
  const preserveFallbackMs = provider === 'primary' ? FALLBACK_ATTEMPT_WINDOW_MS : 0;
  const providerMaximumMs = provider === 'primary' ? PRIMARY_ATTEMPT_WINDOW_MS : FALLBACK_ATTEMPT_WINDOW_MS;
  return Math.min(deadlineMs - now - PROVIDER_RESERVE_MS - preserveFallbackMs, providerMaximumMs);
}

function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ImageProviderError && error.retryable;
}

function assertDeadline(job: WorkflowJobInput): number {
  const deadlineMs = Date.parse(job.providerDeadlineAt);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
    throw new NonRetryableError('GENERATION_TIMEOUT');
  }
  return deadlineMs;
}

async function reserveProviderAttempt(
  env: Env,
  jobId: string,
  provider: 'primary' | 'fallback',
  model: IllustrationModel,
  attemptNumber: number,
): Promise<void> {
  const reservation = await callBridgeWithRetry<BridgeReserveAttemptResponse>(env, 'reserve_attempt', {
    jobId,
    provider,
    model,
    attemptNumber,
  });
  if (!reservation.reserved) {
    throw new NonRetryableError('ATTEMPT_CAP_EXHAUSTED');
  }
}

async function callBridgeWithRetry<T>(
  env: Env,
  operation: Parameters<typeof callBridge>[1],
  payload: Record<string, unknown>,
): Promise<T> {
  return await callTypedBridgeWithRetry(() => callBridge<T>(env, operation, payload));
}

async function callTypedBridgeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < BRIDGE_OPERATION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof BridgeError) || !error.retryable || attempt === BRIDGE_OPERATION_ATTEMPTS - 1) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function uploadOutputWithLease(
  env: Env,
  jobId: string,
  outputKey: string,
  bytes: ArrayBuffer,
  model: IllustrationModel,
): Promise<void> {
  await uploadWithLease({
    authorize: async () => await callTypedBridgeWithRetry(
      () => authorizeMemoryUpload(env, jobId, outputKey),
    ),
    existingObject: async () => Boolean(await env.MEMORY_ILLUSTRATIONS.head(outputKey)),
    put: async () => {
      const stored = await env.MEMORY_ILLUSTRATIONS.put(outputKey, bytes, {
        httpMetadata: { contentType: 'image/webp' },
        customMetadata: { model },
      });
      if (!stored) throw new Error('R2_PUT_OUTCOME_AMBIGUOUS');
    },
    recordComplete: async (uploadToken) => await callTypedBridgeWithRetry(
      () => recordMemoryUploadComplete(env, jobId, outputKey, uploadToken),
    ),
  });
}

async function confirmExistingOutputUpload(
  env: Env,
  jobId: string,
  outputKey: string,
): Promise<void> {
  await confirmExistingUploadWithLease({
    authorize: async () => await callTypedBridgeWithRetry(
      () => authorizeMemoryUpload(env, jobId, outputKey),
    ),
    recordComplete: async (uploadToken) => await callTypedBridgeWithRetry(
      () => recordMemoryUploadComplete(env, jobId, outputKey, uploadToken),
    ),
  });
}

async function runImageAttempt(
  env: Env,
  job: WorkflowJobInput,
  prompt: string,
  references: Awaited<ReturnType<typeof loadIllustrationReferences>>,
  provider: 'primary' | 'fallback',
  model: IllustrationModel,
  attemptNumber: number,
  deadlineMs: number,
): Promise<GenerationStepResult> {
  await reserveProviderAttempt(env, job.jobId, provider, model, attemptNumber);
  const remainingMs = providerAttemptTimeoutMs(provider, deadlineMs);
  if (remainingMs <= 0) {
    throw new NonRetryableError('GENERATION_TIMEOUT');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const bytes = await editImage(
      env,
      model,
      prompt,
      references,
      references.length >= 3 ? 'medium' : undefined,
      controller.signal,
    );
    await uploadOutputWithLease(env, job.jobId, job.outputKey, bytes, model);
    return { outputKey: job.outputKey, model };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateAndUpload(env: Env, jobId: string): Promise<GenerationStepResult> {
  const { job } = await callBridgeWithRetry<BridgeGetInputResponse>(env, 'get_input', { jobId });
  if (job.jobId !== jobId || !job.outputKey) {
    throw new NonRetryableError('INVALID_JOB_INPUT');
  }

  const alreadyUploaded = await env.MEMORY_ILLUSTRATIONS.head(job.outputKey);
  if (alreadyUploaded) {
    // A prior PUT may have succeeded while its completion response was lost.
    // Confirm the exact upload fence before allowing publication.
    await confirmExistingOutputUpload(env, job.jobId, job.outputKey);
    const model = alreadyUploaded.customMetadata?.model;
    return {
      outputKey: job.outputKey,
      model: model === FALLBACK_MODEL ? FALLBACK_MODEL : PRIMARY_MODEL,
    };
  }

  const references = await loadIllustrationReferences(env, job.referenceCandidates);
  if (references.length === 0) {
    throw new NonRetryableError('NO_USABLE_REFERENCES');
  }

  const prompt = buildIllustrationPrompt({
    safeSceneDescription: job.safeSceneDescription,
    characterReferences: references.map((reference, index) => ({
      referenceIndex: index + 1,
      description: reference.description,
    })),
    colorPalette: job.colorPalette,
    emotion: job.emotion,
    expressionStyle: job.expressionStyle ?? undefined,
    memoryDate: job.memoryDate,
    styleDescription: job.styleDescription,
  });
  await callBridgeWithRetry(env, 'record_prompt', { jobId, prompt });

  const deadlineMs = assertDeadline(job);
  let lastError: unknown;

  // A primary can take three minutes—well beyond the former Edge Function
  // limit—while preserving one minute for fallback and thirty seconds for
  // publication. A second primary only runs when the first failed quickly.
  for (let primaryAttempt = 0; primaryAttempt < 2; primaryAttempt += 1) {
    if (!canStartProviderAttempt('primary', deadlineMs)) {
      break;
    }
    try {
      return await runImageAttempt(
        env,
        job,
        prompt,
        references,
        'primary',
        PRIMARY_MODEL,
        primaryAttempt + 1,
        deadlineMs,
      );
    } catch (error) {
      if (!isRetryableProviderError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  if (!canStartProviderAttempt('fallback', deadlineMs)) {
    throw new NonRetryableError(lastError ? errorCode(lastError) : 'GENERATION_TIMEOUT');
  }

  return await runImageAttempt(
    env,
    job,
    prompt,
    references,
    'fallback',
    FALLBACK_MODEL,
    1,
    deadlineMs,
  );
}

async function deleteIfPresent(env: Env, key: string | null | undefined): Promise<void> {
  if (key) {
    await env.MEMORY_ILLUSTRATIONS.delete(key);
  }
}

export class MemoryIllustrationWorkflow extends WorkflowEntrypoint<Env, WorkflowDispatchPayload> {
  async run(event: Readonly<WorkflowEvent<WorkflowDispatchPayload>>, step: WorkflowStep) {
    const { jobId } = event.payload;
    let generation: GenerationStepResult;

    try {
      generation = await step.do(
        'generate and upload illustration',
        // The job-level deadline controls paid calls; the step itself gets the
        // full five-minute lease so reference loading and the direct R2 PUT do
        // not steal time from the 180s-primary/60s-fallback provider budget.
        { retries: { limit: 0, delay: '1 second' }, timeout: 300_000, sensitive: 'output' },
        async () => await generateAndUpload(this.env, jobId),
      );
    } catch (error) {
      if (hasAmbiguousUploadOutput(error)) {
        // The deterministic object may exist. Leave the job and upload lease
        // for recovery rather than terminalizing and deleting a valid result.
        throw error;
      }
      const code = errorCode(error);
      const terminal = await step.do(
        'record generation failure',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => await failMemoryJob(this.env, jobId, code),
      );
      if (terminal.deleteOutput) {
        await step.do('delete failed illustration output', { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' }, async () => {
          await deleteIfPresent(this.env, terminal.outputKey);
          return { jobId, deleted: Boolean(terminal.outputKey) };
        });
      }
      return { jobId, status: 'failed', code };
    }

    let publication: PublicationResult;
    try {
      publication = await step.do(
        'publish illustration',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => {
          const response = await callBridge<BridgePublishResponse>(this.env, 'publish', {
            jobId,
            outputKey: generation.outputKey,
            model: generation.model,
          });
          return response;
        },
      );
    } catch {
      publication = await step.do(
        'reconcile illustration publication',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => {
          const response = await callBridge<BridgeReconcileResponse>(this.env, 'reconcile', {
            jobId,
            outputKey: generation.outputKey,
            model: generation.model,
          });
          return response;
        },
      );
    }

    if (!publication.published || publication.deleteOutput) {
      await step.do('delete superseded illustration', { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' }, async () => {
        await deleteIfPresent(this.env, generation.outputKey);
        return { jobId, deleted: true };
      });
      return { jobId, status: 'superseded' };
    }

    if (publication.oldIllustrationKey && publication.oldIllustrationKey !== generation.outputKey) {
      await step.do('delete replaced illustration', { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' }, async () => {
        await deleteIfPresent(this.env, publication.oldIllustrationKey);
        return { jobId, deleted: true };
      });
    }

    return { jobId, status: 'ready', model: generation.model };
  }
}
