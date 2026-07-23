import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { BridgeError } from './bridge';
import {
  authorizePortraitUpload,
  failPortrait,
  getPortraitInput,
  publishPortrait,
  reconcilePortraitPublication,
  recordPortraitUploadComplete,
  reservePortraitAttempt,
  retriggerPortraitDependentMemories,
} from './portrait-bridge';
import { PortraitReferenceError, loadPortraitReferences } from './portrait-references';
import { editPortraitImage, ImageProviderError } from './openai';
import {
  confirmExistingUploadWithLease,
  hasAmbiguousUploadOutput,
  uploadWithLease,
  UploadLeaseError,
} from './upload-lease';
import type {
  BridgePortraitFailResponse,
  BridgePortraitPublishResponse,
  GenerationStepResult,
  IllustrationModel,
  PortraitLoadedReferences,
  PortraitWorkflowJobInput,
  WorkflowDispatchPayload,
} from './types';

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
  oldPortraitKey: string | null;
  deleteOutput: boolean;
}

function errorCode(error: unknown): string {
  if (error instanceof ImageProviderError || error instanceof BridgeError ||
    error instanceof PortraitReferenceError || error instanceof UploadLeaseError) {
    return error.code;
  }
  if (
    error instanceof Error &&
    [
      'GENERATION_TIMEOUT',
      'ATTEMPT_CAP_EXHAUSTED',
      'INVALID_JOB_INPUT',
    ].includes(error.message)
  ) {
    return error.message;
  }
  return 'GENERATION_FAILED';
}

function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ImageProviderError && error.retryable;
}

export function canStartPortraitProviderAttempt(
  provider: 'primary' | 'fallback',
  deadlineMs: number,
  now = Date.now(),
): boolean {
  const minimumWindowMs = provider === 'primary'
    ? MINIMUM_PRIMARY_WINDOW_MS + FALLBACK_ATTEMPT_WINDOW_MS
    : FALLBACK_ATTEMPT_WINDOW_MS;
  return now + minimumWindowMs + PROVIDER_RESERVE_MS <= deadlineMs;
}

export function portraitProviderAttemptTimeoutMs(
  provider: 'primary' | 'fallback',
  deadlineMs: number,
  now = Date.now(),
): number {
  const preserveFallbackMs = provider === 'primary' ? FALLBACK_ATTEMPT_WINDOW_MS : 0;
  const providerMaximumMs = provider === 'primary' ? PRIMARY_ATTEMPT_WINDOW_MS : FALLBACK_ATTEMPT_WINDOW_MS;
  return Math.min(deadlineMs - now - PROVIDER_RESERVE_MS - preserveFallbackMs, providerMaximumMs);
}

function assertDeadline(job: PortraitWorkflowJobInput): number {
  const deadlineMs = Date.parse(job.providerDeadlineAt);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
    throw new NonRetryableError('GENERATION_TIMEOUT');
  }
  return deadlineMs;
}

async function callBridgeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
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

async function uploadPortraitOutputWithLease(
  env: Env,
  jobId: string,
  outputKey: string,
  bytes: ArrayBuffer,
  model: IllustrationModel,
): Promise<void> {
  await uploadWithLease({
    authorize: async () => await callBridgeWithRetry(
      () => authorizePortraitUpload(env, jobId, outputKey),
    ),
    existingObject: async () => Boolean(await env.CHARACTER_PORTRAITS.head(outputKey)),
    put: async () => {
      const stored = await env.CHARACTER_PORTRAITS.put(outputKey, bytes, {
        httpMetadata: { contentType: 'image/webp' },
        customMetadata: { model },
      });
      if (!stored) throw new Error('R2_PUT_OUTCOME_AMBIGUOUS');
    },
    recordComplete: async (uploadToken) => await callBridgeWithRetry(
      () => recordPortraitUploadComplete(env, jobId, outputKey, uploadToken),
    ),
  });
}

async function confirmExistingPortraitUpload(
  env: Env,
  jobId: string,
  outputKey: string,
): Promise<void> {
  await confirmExistingUploadWithLease({
    authorize: async () => await callBridgeWithRetry(
      () => authorizePortraitUpload(env, jobId, outputKey),
    ),
    recordComplete: async (uploadToken) => await callBridgeWithRetry(
      () => recordPortraitUploadComplete(env, jobId, outputKey, uploadToken),
    ),
  });
}

async function runImageAttempt(
  env: Env,
  job: PortraitWorkflowJobInput,
  references: PortraitLoadedReferences,
  provider: 'primary' | 'fallback',
  model: IllustrationModel,
  deadlineMs: number,
): Promise<GenerationStepResult> {
  const reservation = await callBridgeWithRetry(() => reservePortraitAttempt(
    env,
    job.jobId,
    provider,
    model,
    1,
  ));
  if (!reservation.reserved) throw new NonRetryableError('ATTEMPT_CAP_EXHAUSTED');

  const remainingMs = portraitProviderAttemptTimeoutMs(provider, deadlineMs);
  if (remainingMs <= 0) throw new NonRetryableError('GENERATION_TIMEOUT');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    // Bounded R2 PUT retries below reuse these in-memory bytes. The enclosing
    // Workflow step itself has retries disabled so a replay never repeats an
    // OpenAI call after an ambiguous/crashed provider request.
    const bytes = await editPortraitImage(
      env,
      model,
      job.prompt,
      references.style,
      references.source,
      controller.signal,
    );
    await uploadPortraitOutputWithLease(env, job.jobId, job.outputKey, bytes, model);
    return { outputKey: job.outputKey, model };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generatePortraitAndUpload(env: Env, jobId: string): Promise<GenerationStepResult> {
  const { job } = await callBridgeWithRetry(() => getPortraitInput(env, jobId));
  if (
    job.jobId !== jobId ||
    !job.outputKey ||
    !job.prompt ||
    !job.sourcePhotoKey ||
    !job.styleReferenceKey
  ) {
    throw new NonRetryableError('INVALID_JOB_INPUT');
  }

  const alreadyUploaded = await env.CHARACTER_PORTRAITS.head(job.outputKey);
  if (alreadyUploaded) {
    // A prior PUT may have succeeded while its completion response was lost.
    // Confirm the exact upload fence before allowing publication.
    await confirmExistingPortraitUpload(env, job.jobId, job.outputKey);
    const model = alreadyUploaded.customMetadata?.model;
    return {
      outputKey: job.outputKey,
      model: model === FALLBACK_MODEL ? FALLBACK_MODEL : PRIMARY_MODEL,
    };
  }

  const references = await loadPortraitReferences(env, job.sourcePhotoKey, job.styleReferenceKey);
  const deadlineMs = assertDeadline(job);

  if (!canStartPortraitProviderAttempt('primary', deadlineMs)) {
    throw new NonRetryableError('GENERATION_TIMEOUT');
  }
  try {
    return await runImageAttempt(env, job, references, 'primary', PRIMARY_MODEL, deadlineMs);
  } catch (error) {
    // gpt-image-1.5 is only a provider fallback—not a shortcut when the
    // primary has not had a chance to run within the durable job deadline.
    if (!isRetryableProviderError(error)) throw error;
  }

  if (!canStartPortraitProviderAttempt('fallback', deadlineMs)) {
    throw new NonRetryableError('GENERATION_TIMEOUT');
  }
  return await runImageAttempt(env, job, references, 'fallback', FALLBACK_MODEL, deadlineMs);
}

async function deletePortraitIfPresent(env: Env, key: string | null | undefined): Promise<void> {
  if (key) await env.CHARACTER_PORTRAITS.delete(key);
}

async function retriggerDependentMemories(
  env: Env,
  step: WorkflowStep,
  jobId: string,
): Promise<void> {
  try {
    await step.do(
      'retrigger portrait-dependent memories',
      { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
      async () => {
        await retriggerPortraitDependentMemories(env, jobId);
        return { jobId, requested: true };
      },
    );
  } catch {
    // Publication/failure has already been committed. A client recovery loop
    // remains the backstop when this best-effort server retrigger is offline.
  }
}

export class PortraitGenerationWorkflow extends WorkflowEntrypoint<Env, WorkflowDispatchPayload> {
  async run(event: Readonly<WorkflowEvent<WorkflowDispatchPayload>>, step: WorkflowStep) {
    const { jobId } = event.payload;
    let generation: GenerationStepResult;

    try {
      generation = await step.do(
        'generate and upload portrait',
        { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes', sensitive: 'output' },
        async () => await generatePortraitAndUpload(this.env, jobId),
      );
    } catch (error) {
      if (hasAmbiguousUploadOutput(error)) {
        // The PUT or lease-clear response was ambiguous. Recovery owns the
        // deterministic key; terminal cleanup here could delete valid bytes.
        throw error;
      }
      const code = errorCode(error);
      const terminal = await step.do(
        'record portrait generation failure',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => await failPortrait(this.env, jobId, code),
      );
      if (terminal.deleteOutput) {
        await step.do('delete failed portrait output', { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' }, async () => {
          await deletePortraitIfPresent(this.env, terminal.outputKey);
          return { jobId, deleted: Boolean(terminal.outputKey) };
        });
      }
      await retriggerDependentMemories(this.env, step, jobId);
      return { jobId, status: 'failed', code };
    }

    let publication: PublicationResult;
    try {
      publication = await step.do(
        'publish portrait',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => await publishPortrait(this.env, jobId, generation.outputKey, generation.model),
      );
    } catch {
      try {
        publication = await step.do(
          'reconcile portrait publication',
          { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
          async () => await reconcilePortraitPublication(this.env, jobId, generation.outputKey, generation.model),
        );
      } catch (reconciliationError) {
        // A non-retryable bridge rejection means the job/version was deleted
        // or superseded while the provider was running. It is safe to remove
        // only this attempt object. Never delete it on bridge unavailability:
        // the original publish may have committed despite a lost response.
        if (reconciliationError instanceof BridgeError && !reconciliationError.retryable) {
          await step.do('delete deleted portrait output', { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' }, async () => {
            await deletePortraitIfPresent(this.env, generation.outputKey);
            return { jobId, deleted: true };
          });
          await retriggerDependentMemories(this.env, step, jobId);
          return { jobId, status: 'superseded' };
        }
        throw reconciliationError;
      }
    }

    if (!publication.published || publication.deleteOutput) {
      await step.do('delete superseded portrait output', { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' }, async () => {
        await deletePortraitIfPresent(this.env, generation.outputKey);
        return { jobId, deleted: true };
      });
      await retriggerDependentMemories(this.env, step, jobId);
      return { jobId, status: 'superseded' };
    }

    if (publication.oldPortraitKey && publication.oldPortraitKey !== generation.outputKey) {
      await step.do('delete replaced portrait', { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' }, async () => {
        await deletePortraitIfPresent(this.env, publication.oldPortraitKey);
        return { jobId, deleted: true };
      });
    }

    await retriggerDependentMemories(this.env, step, jobId);
    return { jobId, status: 'ready', model: generation.model };
  }
}
