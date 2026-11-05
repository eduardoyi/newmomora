import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { BridgeError } from './bridge';
import { reencodeToWebp, sniffImageFormat } from './image-output';
import { checkMotionSheet, editMotionSheetWithUsage, ImageProviderError } from './openai';
import {
  failMotion,
  getMotionInput,
  publishMotion,
  recordMotionUsage,
} from './portrait-bridge';
import {
  IMAGE_PRICING_VERSION,
  VISION_PRICING_VERSION,
  priceImageUsage,
  priceVisionUsage,
} from './pricing';
import type {
  BridgeMotionInput,
  ImageUsage,
  MotionCheckResult,
  MotionGenerationResult,
  PortraitMotionDispatchPayload,
  VisionUsage,
} from './types';

const BRIDGE_STEP_RETRIES = { limit: 3, delay: '2 seconds', backoff: 'exponential' } as const;
const BRIDGE_OPERATION_ATTEMPTS = 3;
const MAX_GENERATION_ATTEMPTS = 2;
// Two attempts of (edit + QA) must fit inside the 6 minute step timeout.
const EDIT_TIMEOUT_MS = 120_000;
const QA_TIMEOUT_MS = 30_000;
const QA_MAX_EDGE = 768;
const QA_CHECK_MODEL = 'gpt-4o-mini';
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/;

function errorCode(error: unknown): string {
  if (error instanceof ImageProviderError || error instanceof BridgeError) return error.code;
  // Inside a real Workflow, step errors are re-created as plain Errors that
  // keep only their message; every error thrown here uses its code as message.
  if (error instanceof Error && ERROR_CODE_PATTERN.test(error.message)) return error.message;
  return 'MOTION_GENERATION_FAILED';
}

function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ImageProviderError && error.retryable;
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

function queueMotionUsageBestEffort(
  env: Env,
  versionId: string,
  motionToken: string,
  attemptNumber: number,
  kind: 'image' | 'check',
  model: string,
  usage: ImageUsage | VisionUsage | null,
  success: boolean,
): void {
  const isImage = kind === 'image';
  const pricing = isImage
    ? priceImageUsage(model as BridgeMotionInput['model'], usage as ImageUsage | null)
    : priceVisionUsage(usage as VisionUsage | null);
  // The check's usage is mapped onto the portrait bridge's allowlisted usage
  // keys (text in / text out); a vision call has no image-token breakdown.
  const bridgeUsage = isImage
    ? usage
    : usage
      ? { inputTextTokens: (usage as VisionUsage).inputTokens, outputTextTokens: (usage as VisionUsage).outputTokens }
      : null;
  void recordMotionUsage(env, {
    jobId: versionId,
    motionToken,
    aiCallId: `${isImage ? 'motion' : 'motion-check'}:${motionToken}:${attemptNumber}`,
    // Not `operation`: the signed bridge operation owns that field name
    // (callBridgeAt overwrites it), so the plan's `operation: 'image'|'check'`
    // is sent as `aiOperation`, as the portrait bridge already does.
    aiOperation: kind,
    model,
    success,
    usage: bridgeUsage,
    pricingVersion: isImage ? IMAGE_PRICING_VERSION : VISION_PRICING_VERSION,
    ...pricing,
  }).catch(() => {
    // Cost telemetry cannot change a completed generation.
  });
}

async function downscaleForQa(env: Env, bytes: ArrayBuffer): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const transformed = await env.IMAGES
    .input(new Blob([bytes]).stream())
    .transform({ width: QA_MAX_EDGE, height: QA_MAX_EDGE, fit: 'scale-down' })
    .output({ format: 'image/webp', quality: 85 });
  return { bytes: await new Response(transformed.image()).arrayBuffer(), contentType: 'image/webp' };
}

/**
 * Runs the vision QA for one sheet. Never throws: anything short of a clean
 * all-true verdict (provider failure after one retry, downscale failure,
 * unparseable output) is a QA failure, so an unchecked sheet is never published.
 */
async function runMotionQa(
  env: Env,
  input: BridgeMotionInput,
  versionId: string,
  motionToken: string,
  attemptNumber: number,
  qaStill: { bytes: ArrayBuffer; contentType: string } | null,
  sheet: ArrayBuffer,
): Promise<boolean> {
  if (!qaStill) return false;
  let qaSheet: { bytes: ArrayBuffer; contentType: string };
  try {
    qaSheet = await downscaleForQa(env, sheet);
  } catch {
    return false;
  }
  let result: MotionCheckResult | null = null;
  for (let call = 0; call < 2 && !result; call += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), QA_TIMEOUT_MS);
    try {
      result = await checkMotionSheet(env, input.checkPrompt, qaStill, qaSheet, controller.signal);
    } catch (error) {
      if (!isRetryableProviderError(error)) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  queueMotionUsageBestEffort(
    env, versionId, motionToken, attemptNumber, 'check', QA_CHECK_MODEL, result?.usage ?? null, Boolean(result),
  );
  return result?.passed === true;
}

export async function generateMotionSheetAndUpload(
  env: Env,
  versionId: string,
  motionToken: string,
): Promise<MotionGenerationResult> {
  const input = await callBridgeWithRetry(() => getMotionInput(env, versionId, motionToken));

  // The key is minted from this claim's token, so an object already there is
  // ours from a prior run of this step: never repeat the paid calls.
  if (await env.CHARACTER_PORTRAITS.head(input.outputKey)) {
    return { outputKey: input.outputKey, columns: input.columns, rows: input.rows };
  }

  const stillObject = await env.CHARACTER_PORTRAITS.get(input.sourceKey);
  if (!stillObject?.body) throw new NonRetryableError('SOURCE_REFERENCE_UNAVAILABLE');
  const still = await new Response(stillObject.body).arrayBuffer();
  let qaStill: { bytes: ArrayBuffer; contentType: string } | null = null;
  try {
    qaStill = await downscaleForQa(env, still);
  } catch {
    // Leaves every QA check failing closed; the edit itself does not need it.
  }

  let passingSheet: ArrayBuffer | null = null;
  let lastError: unknown = new NonRetryableError('MOTION_QA_FAILED');
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS && !passingSheet; attempt += 1) {
    // The enclosing step has retries disabled, so a replay never repeats this
    // paid call; the second attempt below is the only deliberate repeat.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EDIT_TIMEOUT_MS);
    let sheet: ArrayBuffer;
    try {
      const result = await editMotionSheetWithUsage(
        env, input.model, input.prompt, still, input, controller.signal,
      );
      queueMotionUsageBestEffort(env, versionId, motionToken, attempt, 'image', input.model, result.usage, true);
      sheet = result.bytes;
    } catch (error) {
      queueMotionUsageBestEffort(env, versionId, motionToken, attempt, 'image', input.model, null, false);
      // Moderation / non-retryable rejections stop immediately.
      if (!isRetryableProviderError(error)) throw error;
      lastError = error;
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (await runMotionQa(env, input, versionId, motionToken, attempt, qaStill, sheet)) {
      passingSheet = sheet;
    } else {
      lastError = new NonRetryableError('MOTION_QA_FAILED');
    }
  }
  if (!passingSheet) throw lastError;

  let webp: ArrayBuffer;
  try {
    webp = sniffImageFormat(new Uint8Array(passingSheet)) === 'webp'
      ? passingSheet
      : await reencodeToWebp(env, passingSheet);
  } catch {
    throw new NonRetryableError('MOTION_ENCODE_FAILED');
  }
  try {
    const stored = await env.CHARACTER_PORTRAITS.put(input.outputKey, webp, {
      httpMetadata: { contentType: 'image/webp' },
      customMetadata: { model: input.model },
    });
    if (!stored) throw new Error('R2_PUT_OUTCOME_AMBIGUOUS');
  } catch (error) {
    // An ambiguous put may have landed; the key is ours alone, so clean it up.
    await deleteMotionIfPresent(env, input.outputKey).catch(() => undefined);
    throw error;
  }
  return { outputKey: input.outputKey, columns: input.columns, rows: input.rows };
}

async function deleteMotionIfPresent(env: Env, key: string | null | undefined): Promise<void> {
  if (key) await env.CHARACTER_PORTRAITS.delete(key);
}

export class PortraitMotionWorkflow extends WorkflowEntrypoint<Env, PortraitMotionDispatchPayload> {
  async run(event: Readonly<WorkflowEvent<PortraitMotionDispatchPayload>>, step: WorkflowStep) {
    const { versionId, motionToken } = event.payload;
    let generation: MotionGenerationResult;

    try {
      generation = await step.do(
        'generate motion sheet',
        { retries: { limit: 0, delay: '1 second' }, timeout: '6 minutes', sensitive: 'output' },
        async () => await generateMotionSheetAndUpload(this.env, versionId, motionToken),
      );
    } catch (error) {
      const code = errorCode(error);
      await this.recordFailure(step, versionId, motionToken, code);
      return { versionId, status: 'failed', code };
    }

    let publication: { published: boolean; oldMotionKey: string | null };
    try {
      publication = await step.do(
        'publish motion',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => await publishMotion(
          this.env, versionId, motionToken, generation.outputKey, generation.columns, generation.rows,
        ),
      );
    } catch (error) {
      const code = errorCode(error);
      // Bridge unavailability is ambiguous: the publish may have committed.
      // motion_fail is a CAS on the pending claim, so `failed: true` proves
      // it did not; a definitive (non-retryable) rejection also proves it.
      const failed = await this.recordFailure(step, versionId, motionToken, code);
      if (failed || (error instanceof BridgeError && !error.retryable)) {
        await this.deleteOutput(step, 'delete unpublished motion output', generation.outputKey);
      }
      return { versionId, status: 'failed', code };
    }

    if (!publication.published) {
      await this.deleteOutput(step, 'delete superseded motion output', generation.outputKey);
      return { versionId, status: 'superseded' };
    }

    if (publication.oldMotionKey && publication.oldMotionKey !== generation.outputKey) {
      await this.deleteOutput(step, 'delete replaced motion sheet', publication.oldMotionKey);
    }
    return { versionId, status: 'ready' };
  }

  /** Returns whether the bridge confirmed the claim moved to `failed`. */
  private async recordFailure(
    step: WorkflowStep,
    versionId: string,
    motionToken: string,
    code: string,
  ): Promise<boolean> {
    try {
      const result = await step.do(
        'record motion failure',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => await failMotion(this.env, versionId, motionToken, code),
      );
      return result.failed;
    } catch {
      return false;
    }
  }

  private async deleteOutput(step: WorkflowStep, name: string, key: string): Promise<void> {
    try {
      await step.do(name, { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' }, async () => {
        await deleteMotionIfPresent(this.env, key);
        return { deleted: true };
      });
    } catch {
      // A leaked unreferenced object is preferable to failing a finished run.
    }
  }
}
