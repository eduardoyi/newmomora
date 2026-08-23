import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { BridgeError } from './bridge';
import {
  failGalleryChunk,
  failGalleryCluster,
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
  GalleryVisionValidationFailure,
  GalleryWorkflowDispatchPayload,
  VisionUsage,
} from './types';

const BRIDGE_ATTEMPTS = 3;
/**
 * Applied before attempt index `n` is retried (never after the final
 * attempt, which throws immediately). Only the first two entries are ever
 * used at `BRIDGE_ATTEMPTS = 3`; the third is kept so the sequence still
 * reads correctly if the attempt budget is ever raised.
 */
const BRIDGE_RETRY_BACKOFF_MS = [1_000, 3_000, 9_000] as const;
const BRIDGE_STEP_RETRIES = { limit: 3, delay: '2 seconds', backoff: 'exponential' } as const;
const MAX_WORKER_IMAGES_PER_CLUSTER = 10;
const MAX_PREVIEW_BYTES = 1_500_000;
/**
 * Groups below this confidence are dropped before publication; a cluster
 * whose groups are all dropped this way publishes as a `low_confidence` skip
 * instead of staging a weak card. No settings object reaches the Worker's
 * chunk input yet (`GalleryChunkInput` carries no per-run admission fields),
 * so this stays a fixed constant. Promote it to an optional bridge-supplied
 * override — falling back to this constant — once one does.
 */
const DEFAULT_GALLERY_MIN_CONFIDENCE = 0.6;
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

/**
 * A `BridgeError` marked retryable is one classification of transient
 * failure; a plain network failure (fetch could not even complete, or the
 * request was aborted) is another -- neither proves the request reached the
 * bridge, so both are worth a bounded retry here.
 */
function isRetryableBridgeFailure(error: unknown): boolean {
  if (error instanceof BridgeError) return error.retryable;
  if (error instanceof TypeError) return true;
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') return true;
  return false;
}

async function bridgeRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < BRIDGE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableBridgeFailure(error) || attempt === BRIDGE_ATTEMPTS - 1) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, BRIDGE_RETRY_BACKOFF_MS[attempt]));
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

/**
 * Minimum viable server-side dedup: drops later assets within one cluster
 * that share an earlier asset's expected byte hash, keeping the first
 * occurrence. This is exact-hash only — perceptual/near-duplicate detection
 * stays out of scope for this fix.
 */
function dedupeClusterAssets(cluster: GalleryClusterInput): GalleryClusterInput {
  const seenHashes = new Set<string>();
  const assets = cluster.assets.filter((asset) => {
    const hash = asset.expectedSha256.toLowerCase();
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });
  return assets.length === cluster.assets.length ? cluster : { ...cluster, assets };
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

interface GalleryClusterOutcome {
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
 * Fetches and validates the whole-chunk input. This is the only place
 * `INVALID_GALLERY_CHUNK_INPUT` (a whole-chunk structural failure, as
 * opposed to one bad cluster) is raised.
 */
async function getValidatedGalleryChunk(env: Env, chunkId: string): Promise<GalleryChunkInput> {
  const { chunk } = await bridgeRetry(() => getGalleryChunkInput(env, chunkId));
  if (!validChunkInput(chunk, chunkId)) throw new Error('INVALID_GALLERY_CHUNK_INPUT');
  return chunk;
}

/**
 * Performs all content-bearing work for one cluster in a single no-retry
 * sensitive step. Its return value is deliberately scalar: captions, prompt
 * text, provider output and preview bytes never enter Workflow history,
 * logs, or event payloads. A thrown non-ambiguous error here fails only this
 * cluster (via `fail_gallery_cluster`, applied by the caller) -- it must
 * never propagate as a whole-chunk failure.
 */
async function processGalleryCluster(
  env: Env,
  chunkId: string,
  chunk: GalleryChunkInput,
  rawCluster: GalleryClusterInput,
): Promise<GalleryClusterOutcome> {
  if (!validCluster(rawCluster, chunk.maxImagesPerCluster)) throw new Error('INVALID_GALLERY_CLUSTER_INPUT');
  const cluster = dedupeClusterAssets(rawCluster);
  if (cluster.assets.length < 1) {
    // Dedup only drops later duplicates and always keeps one asset per
    // hash, so an empty cluster cannot occur today; this guards a future
    // dedup strategy that could remove every asset in a cluster.
    await publishCluster(env, chunkId, rawCluster.clusterSignature, [], 'invalid_preview');
    return { stagedCandidates: 0, skippedClusters: 1 };
  }
  let previews: ValidatedGalleryPreview[];
  try {
    previews = await loadClusterPreviews(env, cluster);
  } catch (error) {
    if (!(error instanceof GalleryPreviewError)) throw error;
    await publishCluster(env, chunkId, cluster.clusterSignature, [], 'invalid_preview');
    return { stagedCandidates: 0, skippedClusters: 1 };
  }

  // A schema-conformant-but-invalid response is a DEFINITE completed call
  // (never ambiguous), so it may reuse this cluster's existing attempt
  // budget for exactly one corrective retry -- distinct from the 429/5xx
  // retry path below, which may use the remaining budget without this cap.
  let malformedRetryUsed = false;
  let pendingCorrection: GalleryVisionValidationFailure | null = null;
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
    try {
      const correctionForThisAttempt = pendingCorrection;
      pendingCorrection = null;
      let result: Awaited<ReturnType<typeof curateGalleryCluster>>;
      try {
        result = await curateGalleryCluster(
          env, cluster, previews, chunk.captionLocale, chunk.captionInstructions, controller.signal,
          correctionForThisAttempt,
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
        if (error instanceof GalleryVisionError && error.code === 'VISION_RETRYABLE' && attemptNumber < chunk.maxProviderAttempts) continue;
        if (error instanceof GalleryVisionError && error.code === 'VISION_MALFORMED_RESPONSE' &&
          !malformedRetryUsed && attemptNumber < chunk.maxProviderAttempts) {
          // Exactly one corrective retry per cluster, regardless of how
          // much of the shared attempt budget remains.
          malformedRetryUsed = true;
          pendingCorrection = error.validationFailureCode;
          continue;
        }
        if (error instanceof GalleryVisionError && error.code === 'VISION_REFUSAL') {
          await publishCluster(env, chunkId, cluster.clusterSignature, [], 'provider_refusal');
          return { stagedCandidates: 0, skippedClusters: 1 };
        }
        if (error instanceof GalleryVisionError && error.code === 'VISION_MALFORMED_RESPONSE') {
          // Closed-code diagnostic only -- never the raw response, prompt,
          // or caption content -- so future prompt/schema tuning has data
          // on which validation rule the provider keeps missing.
          console.warn('gallery_curation_invalid_provider_output', {
            chunkId,
            clusterSignature: cluster.clusterSignature,
            validationFailureCode: error.validationFailureCode ?? 'unknown',
            correctiveRetryAttempted: malformedRetryUsed,
          });
          await publishCluster(env, chunkId, cluster.clusterSignature, [], 'invalid_provider_output');
          return { stagedCandidates: 0, skippedClusters: 1 };
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
      const acceptedGroups = result.groups.filter((group) => group.confidence >= DEFAULT_GALLERY_MIN_CONFIDENCE);
      const droppedAllForLowConfidence = result.groups.length > 0 && acceptedGroups.length === 0;
      const skipReason = acceptedGroups.length === 0
        ? (droppedAllForLowConfidence ? 'low_confidence' : closedSkipReason(result.skipReason))
        : null;
      await publishCluster(env, chunkId, cluster.clusterSignature, acceptedGroups, skipReason);
      return { stagedCandidates: acceptedGroups.length, skippedClusters: acceptedGroups.length === 0 ? 1 : 0 };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('GALLERY_ATTEMPT_CAP_EXHAUSTED');
}

export class GalleryImportWorkflow extends WorkflowEntrypoint<Env, GalleryWorkflowDispatchPayload> {
  async run(event: Readonly<WorkflowEvent<GalleryWorkflowDispatchPayload>>, step: WorkflowStep) {
    const { chunkId } = event.payload;

    // Deliberately NOT a step.do: a step's return value is persisted in
    // Workflow history for replay (sensitive:'output' only redacts the
    // dashboard, not history). The chunk input carries preview keys,
    // captionInstructions, and cluster signatures, which must never enter
    // step state -- so this is a plain await. bridgeRetry already bounds its
    // retries, and a replay simply re-fetches: get_gallery_chunk_input only
    // returns still-pending clusters, so this call is idempotent.
    let chunk: GalleryChunkInput;
    try {
      chunk = await getValidatedGalleryChunk(this.env, chunkId);
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

    let stagedCandidates = 0;
    let skippedClusters = 0;
    let failedClusters = 0;
    for (let index = 0; index < chunk.clusters.length; index += 1) {
      const cluster = chunk.clusters[index];
      try {
        const outcome = await step.do(
          `cluster ${index}`,
          { retries: { limit: 0, delay: '1 second' }, timeout: '4 minutes', sensitive: 'output' },
          async () => await processGalleryCluster(this.env, chunkId, chunk, cluster),
        );
        stagedCandidates += outcome.stagedCandidates;
        skippedClusters += outcome.skippedClusters;
      } catch (error) {
        // Ambiguous cluster failures fence a possibly-paid provider call
        // that this invocation cannot safely retry. They abort the whole
        // instance so reconciliation (S7) can re-dispatch a fresh attempt --
        // they must never be treated as an ordinary per-cluster failure.
        if (error instanceof GalleryWorkflowAmbiguousError) throw error;
        const code = errorCode(error);
        await step.do(
          `fail cluster ${index}`,
          { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
          async () => {
            await failGalleryCluster(this.env, { chunkId, clusterSignature: cluster.clusterSignature, errorCode: code });
            return { chunkId, clusterSignature: cluster.clusterSignature, failed: true };
          },
        );
        failedClusters += 1;
      }
    }

    await step.do(
      'scrub gallery chunk',
      { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds', sensitive: 'output' },
      async () => {
        await scrubGalleryChunk(this.env, chunkId);
        return { chunkId, scrubbed: true };
      },
    );
    return { chunkId, status: 'ready', stagedCandidates, skippedClusters, failedClusters };
  }
}
