import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { BridgeError } from './bridge';
import {
  failGalleryChunk,
  getGalleryChunkInput,
  markGalleryAttemptAmbiguous,
  publishGalleryClusterResult,
  recordGalleryUsage,
  reserveGalleryAttempt,
  scrubGalleryChunk,
} from './gallery-bridge';
import { GalleryPreviewError, validateGalleryPreview, type ValidatedGalleryPreview } from './gallery-preview-validation';
import { GalleryVisionError, curateGalleryCluster } from './gallery-vision';
import type {
  GalleryCandidateDraft,
  GalleryChunkInput,
  GalleryClusterInput,
  GalleryPreviewAsset,
  GallerySkipReason,
  GalleryWorkflowDispatchPayload,
  VisionUsage,
} from './types';

const BRIDGE_ATTEMPTS = 3;
const BRIDGE_STEP_RETRIES = { limit: 3, delay: '2 seconds', backoff: 'exponential' } as const;
const MAX_WORKER_IMAGES_PER_CLUSTER = 10;
const MAX_PREVIEW_BYTES = 1_500_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREVIEW_KEY_PATTERN = /^[0-9a-f-]{36}\/gallery-import\/[0-9a-f-]{36}\/previews\/[0-9a-f-]{36}\.jpg$/i;

export class GalleryWorkflowAmbiguousError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof GalleryVisionError || error instanceof GalleryPreviewError || error instanceof BridgeError) return error.code;
  if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) return error.message;
  return 'GALLERY_CURATION_FAILED';
}

async function bridgeRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < BRIDGE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof BridgeError) || !error.retryable || attempt === BRIDGE_ATTEMPTS - 1) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

function isExactIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function hasOnlyKeys(value: object, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validAsset(asset: GalleryPreviewAsset, cluster: GalleryClusterInput): boolean {
  if (!asset || typeof asset !== 'object') return false;
  return hasOnlyKeys(asset, [
    'assetToken', 'previewKey', 'expectedByteLength', 'expectedSha256', 'expectedContentType',
    'previewWidth', 'previewHeight', 'captureDate', 'width', 'height', 'isFavorite',
  ]) && UUID_PATTERN.test(asset.assetToken) && PREVIEW_KEY_PATTERN.test(asset.previewKey) &&
    Number.isSafeInteger(asset.expectedByteLength) && asset.expectedByteLength >= 1 && asset.expectedByteLength <= MAX_PREVIEW_BYTES &&
    /^[a-f0-9]{64}$/i.test(asset.expectedSha256) && asset.expectedContentType === 'image/jpeg' &&
    isExactIsoDate(asset.captureDate) && asset.captureDate >= cluster.clusterStartDate && asset.captureDate <= cluster.clusterEndDate &&
    Number.isSafeInteger(asset.previewWidth) && asset.previewWidth >= 1 && asset.previewWidth <= 512 &&
    Number.isSafeInteger(asset.previewHeight) && asset.previewHeight >= 1 && asset.previewHeight <= 512 &&
    (asset.width === null || (Number.isSafeInteger(asset.width) && asset.width >= 1 && asset.width <= 100_000)) &&
    (asset.height === null || (Number.isSafeInteger(asset.height) && asset.height >= 1 && asset.height <= 100_000)) &&
    typeof asset.isFavorite === 'boolean';
}

function validChunkInput(chunk: GalleryChunkInput, chunkId: string): boolean {
  return chunk.chunkId === chunkId &&
    hasOnlyKeys(chunk, [
      'chunkId', 'runId', 'providerDeadlineAt', 'maxProviderAttempts', 'maxImagesPerCluster',
      'captionLocale', 'captionInstructions', 'clusters',
    ]) && UUID_PATTERN.test(chunk.runId) &&
    Number.isSafeInteger(chunk.maxProviderAttempts) && chunk.maxProviderAttempts >= 1 && chunk.maxProviderAttempts <= 3 &&
    Number.isSafeInteger(chunk.maxImagesPerCluster) && chunk.maxImagesPerCluster >= 1 &&
    chunk.maxImagesPerCluster <= MAX_WORKER_IMAGES_PER_CLUSTER &&
    typeof chunk.captionLocale === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(chunk.captionLocale) && chunk.captionLocale.length <= 35 &&
    (chunk.captionInstructions === null || (typeof chunk.captionInstructions === 'string' && chunk.captionInstructions.length <= 500 && !/[\u0000-\u001f\u007f]/.test(chunk.captionInstructions))) &&
    Array.isArray(chunk.clusters) && chunk.clusters.length <= 50 &&
    Number.isFinite(Date.parse(chunk.providerDeadlineAt)) && Date.parse(chunk.providerDeadlineAt) > Date.now();
}

function validCluster(cluster: GalleryClusterInput, maxImages: number): boolean {
  return Boolean(cluster) && typeof cluster === 'object' &&
    hasOnlyKeys(cluster, ['clusterSignature', 'clusterStartDate', 'clusterEndDate', 'assets']) &&
    typeof cluster.clusterSignature === 'string' && /^[a-f0-9]{64}$/i.test(cluster.clusterSignature) &&
    isExactIsoDate(cluster.clusterStartDate) && isExactIsoDate(cluster.clusterEndDate) &&
    cluster.clusterStartDate <= cluster.clusterEndDate && Array.isArray(cluster.assets) &&
    cluster.assets.length >= 1 && cluster.assets.length <= Math.min(maxImages, MAX_WORKER_IMAGES_PER_CLUSTER) &&
    new Set(cluster.assets.map((asset) => asset.assetToken)).size === cluster.assets.length &&
    cluster.assets.every((asset) => validAsset(asset, cluster));
}

async function loadClusterPreviews(
  env: Env,
  cluster: GalleryClusterInput,
): Promise<ValidatedGalleryPreview[]> {
  return await Promise.all(cluster.assets.map(async (asset) => await validateGalleryPreview(
    asset,
    await env.GALLERY_IMPORT_PREVIEWS.get(asset.previewKey),
  )));
}

async function markAmbiguous(
  env: Env,
  chunkId: string,
  attemptId: string,
  reservationToken: string,
  code: string,
): Promise<never> {
  // If the bridge itself is unavailable after a paid call, its surviving
  // reservation still fences replays. Do not terminal-clean a possibly paid
  // attempt merely because the quarantine acknowledgement was lost.
  try {
    await bridgeRetry(() => markGalleryAttemptAmbiguous(env, { chunkId, attemptId, reservationToken }));
  } catch {
    // The reserved attempt remains the recovery/reconciliation record.
  }
  throw new GalleryWorkflowAmbiguousError(code);
}

interface GalleryStepSummary {
  chunkId: string;
  stagedCandidates: number;
  skippedClusters: number;
}

function usageRecord(usage: VisionUsage | null, success: boolean) {
  return {
    success,
    providerStatus: success ? 'completed' as const : 'failed' as const,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };
}

function closedSkipReason(reason: GallerySkipReason | null): GallerySkipReason {
  switch (reason) {
    case null:
      return 'no_candidate';
    default:
      return reason;
  }
}

async function publishCluster(
  env: Env,
  chunkId: string,
  clusterSignature: string,
  candidates: GalleryCandidateDraft[],
  skipReason: GallerySkipReason | null,
): Promise<void> {
  try {
    await bridgeRetry(() => publishGalleryClusterResult(env, { chunkId, clusterSignature, candidates, skipReason }));
  } catch (error) {
    // A lost response may mean the DB transaction committed. The cluster
    // ledger is the authority, so no provider call is automatically replayed.
    if (error instanceof BridgeError && error.retryable) {
      throw new GalleryWorkflowAmbiguousError('GALLERY_PUBLICATION_AMBIGUOUS');
    }
    throw error;
  }
}

/**
 * Performs all content-bearing work in one no-retry sensitive step.  Its
 * return value is deliberately scalar: captions, prompt text, provider output
 * and preview bytes never enter Workflow history, logs, or event payloads.
 */
export async function processGalleryChunk(env: Env, chunkId: string): Promise<GalleryStepSummary> {
  const { chunk } = await bridgeRetry(() => getGalleryChunkInput(env, chunkId));
  if (!validChunkInput(chunk, chunkId)) throw new Error('INVALID_GALLERY_CHUNK_INPUT');

  let stagedCandidates = 0;
  let skippedClusters = 0;
  for (const cluster of chunk.clusters) {
    if (!validCluster(cluster, chunk.maxImagesPerCluster)) throw new Error('INVALID_GALLERY_CLUSTER_INPUT');
    let previews: ValidatedGalleryPreview[];
    try {
      previews = await loadClusterPreviews(env, cluster);
    } catch (error) {
      if (!(error instanceof GalleryPreviewError)) throw error;
      await publishCluster(env, chunkId, cluster.clusterSignature, [], 'invalid_preview');
      skippedClusters += 1;
      continue;
    }

    let published = false;
    for (let attemptNumber = 1; attemptNumber <= chunk.maxProviderAttempts; attemptNumber += 1) {
      const reservation = await bridgeRetry(() => reserveGalleryAttempt(env, {
        chunkId, clusterSignature: cluster.clusterSignature, attemptNumber,
      }));
      // A replayed reservation cannot prove whether the prior paid request
      // reached OpenAI. Quarantine rather than issuing an automatic duplicate.
      if (reservation.outcome !== 'reserved_now') {
        // Denied attempts are durably closed. A later externally dispatched
        // recovery may advance to a new ordinal; this Workflow invocation
        // itself still has retries disabled after an ambiguous paid call.
        if (reservation.outcome === 'denied') continue;
        if (!reservation.attemptId || !reservation.reservationToken) throw new Error('INVALID_GALLERY_ATTEMPT_RESERVATION');
        await markAmbiguous(env, chunkId, reservation.attemptId, reservation.reservationToken, 'PROVIDER_ATTEMPT_ALREADY_RESERVED');
      }
      if (!reservation.attemptId || !reservation.reservationToken) throw new Error('INVALID_GALLERY_ATTEMPT_RESERVATION');
      const attemptId = reservation.attemptId;
      const reservationToken = reservation.reservationToken;

      const controller = new AbortController();
      const remaining = Date.parse(chunk.providerDeadlineAt) - Date.now();
      if (remaining <= 0) throw new Error('GALLERY_PROVIDER_TIMEOUT');
      const timeout = setTimeout(() => controller.abort(), Math.min(remaining, 120_000));
      let result: Awaited<ReturnType<typeof curateGalleryCluster>>;
      try {
        try {
          result = await curateGalleryCluster(
            env, cluster, previews, chunk.captionLocale, chunk.captionInstructions, controller.signal,
          );
        } catch (error) {
          if (error instanceof GalleryVisionError && error.ambiguous) {
            await markAmbiguous(env, chunkId, attemptId, reservationToken, error.code);
          }
          try {
            await bridgeRetry(() => recordGalleryUsage(env, {
              chunkId, attemptId, reservationToken,
              usage: usageRecord(error instanceof GalleryVisionError ? error.usage : null, false),
            }));
          } catch (usageError) {
            if (usageError instanceof BridgeError && usageError.retryable) {
              await markAmbiguous(env, chunkId, attemptId, reservationToken, 'GALLERY_USAGE_RECORD_AMBIGUOUS');
            }
            throw usageError;
          }
          if (error instanceof GalleryVisionError && error.retryable && attemptNumber < chunk.maxProviderAttempts) continue;
          if (error instanceof GalleryVisionError && error.code === 'VISION_REFUSAL') {
            await publishCluster(env, chunkId, cluster.clusterSignature, [], 'provider_refusal');
            skippedClusters += 1;
            published = true;
            break;
          }
          if (error instanceof GalleryVisionError && error.code === 'VISION_MALFORMED_RESPONSE') {
            await publishCluster(env, chunkId, cluster.clusterSignature, [], 'invalid_provider_output');
            skippedClusters += 1;
            published = true;
            break;
          }
          throw error;
        }
        try {
          await bridgeRetry(() => recordGalleryUsage(env, {
            chunkId, attemptId, reservationToken,
            usage: usageRecord(result.usage, true),
          }));
        } catch (error) {
          if (error instanceof BridgeError && error.retryable) {
            await markAmbiguous(env, chunkId, attemptId, reservationToken, 'GALLERY_USAGE_RECORD_AMBIGUOUS');
          }
          throw error;
        }
        await publishCluster(
          env,
          chunkId,
          cluster.clusterSignature,
          result.groups,
          result.groups.length === 0 ? closedSkipReason(result.skipReason) : null,
        );
        stagedCandidates += result.groups.length;
        if (result.groups.length === 0) skippedClusters += 1;
        published = true;
        break;
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!published) throw new Error('GALLERY_ATTEMPT_CAP_EXHAUSTED');
  }
  return { chunkId, stagedCandidates, skippedClusters };
}

export class GalleryImportWorkflow extends WorkflowEntrypoint<Env, GalleryWorkflowDispatchPayload> {
  async run(event: Readonly<WorkflowEvent<GalleryWorkflowDispatchPayload>>, step: WorkflowStep) {
    const { chunkId } = event.payload;
    let summary: GalleryStepSummary;
    try {
      summary = await step.do(
        'curate and publish gallery chunk',
        { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes', sensitive: 'output' },
        async () => await processGalleryChunk(this.env, chunkId),
      );
    } catch (error) {
      if (error instanceof GalleryWorkflowAmbiguousError) throw error;
      const code = errorCode(error);
      await step.do(
        'record gallery chunk failure',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => {
          await failGalleryChunk(this.env, { chunkId, errorCode: code });
          return { chunkId, failed: true };
        },
      );
      await step.do(
        'scrub failed gallery chunk',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
        async () => {
          await scrubGalleryChunk(this.env, chunkId);
          return { chunkId, scrubbed: true };
        },
      );
      return { chunkId, status: 'failed', code };
    }

    await step.do(
      'scrub published gallery chunk',
      { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
      async () => {
        await scrubGalleryChunk(this.env, chunkId);
        return { chunkId, scrubbed: true };
      },
    );
    return { chunkId, status: 'ready', stagedCandidates: summary.stagedCandidates, skippedClusters: summary.skippedClusters };
  }
}
