import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';

import { uploadToPresignedUrl } from '@/services/media';
import {
  createGalleryImportRun,
  dispatchGalleryImportChunk,
  getGalleryImportRun,
  getGalleryImportUploadUrl,
  registerGalleryImportChunk,
  type GalleryImportRegisteredChunk,
  type GalleryImportManifestCluster,
} from '@/services/gallery-import';
import {
  clearGalleryImportCheckpoint,
  clearGalleryImportPreviewCache,
  loadGalleryImportCheckpoint,
  pruneGalleryImportCheckpoint,
  saveGalleryImportCheckpoint,
  updateGalleryImportCheckpoint,
  type GalleryImportCheckpoint,
} from '@/utils/gallery-import-checkpoint';
import { isGalleryImportRunTerminal } from '@/utils/gallery-import-deck';
import { createGalleryImportPreview } from '@/utils/gallery-import-preview';
import { getGalleryImportE2eAdapter } from '@/utils/gallery-import-e2e-adapter';
import {
  loadGalleryImportFrontier,
  mergeGalleryImportFrontierCoverage,
  saveGalleryImportFrontier,
} from '@/utils/gallery-import-frontier';
import {
  createExpoGalleryMediaLibraryAdapter,
  scanGallerySnapshot,
  type GalleryCluster,
  type GalleryMediaLibraryAdapter,
  type GalleryScanSnapshot,
} from '@/utils/gallery-import-scanner';
import {
  GALLERY_IMPORT_ALGORITHM_VERSION,
  GALLERY_IMPORT_CHECKPOINT_VERSION,
  GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS,
  GALLERY_IMPORT_CLUSTERS_PER_CHUNK,
  GALLERY_IMPORT_TARGET_BACKLOG,
  GALLERY_IMPORT_WINDOW_CLUSTERS,
} from '@/constants/gallery-import';

export const GALLERY_IMPORT_CONSENT_VERSION = 'gallery-import-v1';
export const GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS = 30_000;
export const GALLERY_IMPORT_PREPARATION_BUDGET_MS = 5 * 60_000;

class GalleryImportAssetPreparationTimeoutError extends Error {
  constructor() {
    super('A photo took too long to prepare. Keep Momora open and try continuing this import again.');
  }
}

class GalleryImportAssetUnavailableError extends Error {
  constructor() {
    super('A photo is not available locally on this device. Try continuing after it has downloaded.');
  }
}

class GalleryImportPreparationBudgetExceededError extends Error {
  constructor() {
    super('This gallery preparation pass reached its time limit. Try continuing the import again.');
  }
}

let galleryImportPreviewAttemptSequence = 0;

function nextGalleryImportPreviewCacheKey(assetToken: string): string {
  galleryImportPreviewAttemptSequence += 1;
  return `${assetToken}-attempt-${Date.now().toString(36)}-${galleryImportPreviewAttemptSequence.toString(36)}`;
}

export class GalleryImportWaitingForWifiError extends Error {
  constructor() {
    super('Waiting for Wi-Fi. You can choose to use cellular data instead.');
  }
}

/** A distinguishable type for "this phone's photo library had nothing dated
 * to group" -- lets the entry screen show the design's dedicated emptyLibrary
 * outcome (gi-entry.jsx GIOutcomeEmpty) instead of a generic error card. */
export class GalleryImportEmptyLibraryError extends Error {
  constructor() {
    super('Momora could not find dated photos to group into moments. Your photo library was not changed.');
  }
}

/** Preserves the Edge Function's error `code` (see GalleryImportServiceError
 * in gallery-import.ts) across the throw boundary. Used only for the one
 * server call the fresh-start path makes before a checkpoint exists
 * (createGalleryImportRun) -- every server code that reaches this point is
 * `not_available` (subscription lapsed, run cap reached, or an already-active
 * run all collapse into the same Postgres errcode; see
 * docs/design/gallery-import/README.md and supabase/functions/_shared/gallery-import.ts's
 * rpcFailure) or `forbidden`. The entry screen maps `not_available` onto the
 * design's `capped` exception screen -- the closest designed state when the
 * server does not distinguish the reason any further. */
export class GalleryImportServiceRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Continuous model (S2, 2026-08-23): a chunk registration was refused because
 * the family's rolling 24h cluster limit is exhausted. Thrown by
 * `resumeGalleryImportRunner`/`startGalleryImportRunner` the same way
 * `GalleryImportWaitingForWifiError` is -- an `instanceof` check, not a
 * content-bearing message -- so the driver (gallery-import-driver.ts) can
 * report `phase: 'paused_fair_use'` distinctly from a real error. The
 * checkpoint's own `pausedUntil` field (set right before this throws) is the
 * durable record; this error is only the in-call signal for whoever awaited
 * the call that hit the pause.
 */
export class GalleryImportFairUsePausedError extends Error {
  readonly pausedUntil: string;

  constructor(pausedUntil: string) {
    super('Momora will keep looking tomorrow.');
    this.pausedUntil = pausedUntil;
  }
}

/**
 * Carries a service-error `code` (see GalleryImportServiceError in
 * gallery-import.ts) across a throw boundary so a catch block far from the
 * original `{ data, error }` result can still classify the failure --
 * specifically, whether it should count against a chunk's
 * GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS budget (see errorCountsAsAttempt below).
 * `uploadGalleryPreviewWithRetry` throws this instead of a plain Error so a
 * stalled connection (no HTTP code) is distinguishable from a genuine server
 * refusal (an HTTP code) once it reaches processGalleryImportChunks's catch.
 */
class GalleryImportServiceCallError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** A chunk's own local checkpoint record is missing an asset it already
 * proved it could prepare a preview for -- an internal consistency bug, not
 * a transient network condition, so it counts toward the chunk's attempt
 * budget like a genuine server refusal (see errorCountsAsAttempt). */
class GalleryImportIncompleteCheckpointError extends Error {
  readonly code = 'incomplete_checkpoint';

  constructor() {
    super('A local import checkpoint is incomplete.');
  }
}

export interface GalleryImportRunnerProgress {
  stage: 'scanning' | 'preparing' | 'uploading' | 'dispatching';
  completed: number;
  total: number;
  scannedAssetCount?: number;
}

function isWifiAvailable(network: Awaited<ReturnType<typeof NetInfo.fetch>>): boolean {
  return network.isConnected === true
    && network.isInternetReachable !== false
    && network.type === 'wifi'
    && network.details?.isConnectionExpensive !== true;
}

function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message : fallback;
}

function localCaptureDate(captureAtMs: number): string {
  const date = new Date(captureAtMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function prepareGalleryImportAssetPreview(input: {
  adapter: GalleryMediaLibraryAdapter;
  osAssetId: string;
  runId: string;
  assetToken: string;
  preparationDeadlineAtMs: number;
}): Promise<Awaited<ReturnType<typeof createGalleryImportPreview>>> {
  const remainingBudgetMs = input.preparationDeadlineAtMs - Date.now();
  if (remainingBudgetMs <= 0) {
    // Do not start native work after exhaustion: hundreds of losing iCloud
    // promises would otherwise continue outside the bounded foreground pass.
    throw new GalleryImportPreparationBudgetExceededError();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const localCacheKey = nextGalleryImportPreviewCacheKey(input.assetToken);
  const operation = (async () => {
    const isAvailableLocally = await input.adapter.isAssetAvailableLocally?.(input.osAssetId) ?? true;
    if (!isAvailableLocally) throw new GalleryImportAssetUnavailableError();
    const sourceUri = await input.adapter.resolveAssetUri(input.osAssetId);
    return createGalleryImportPreview({ sourceUri, runId: input.runId, assetToken: input.assetToken, localCacheKey });
  })();
  const deadline = new Promise<never>((_resolve, reject) => {
    const didReachInvocationBudget = remainingBudgetMs <= GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS;
    timeout = setTimeout(
      () => reject(didReachInvocationBudget ? new GalleryImportPreparationBudgetExceededError() : new GalleryImportAssetPreparationTimeoutError()),
      Math.min(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS, remainingBudgetMs),
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (error instanceof GalleryImportAssetPreparationTimeoutError || error instanceof GalleryImportPreparationBudgetExceededError) {
      // Native iCloud resolution/manipulation cannot be cancelled reliably.
      // If it completes after our deadline, delete that attempt's preview
      // without logging or persisting any source identifier.
      void operation
        .then((preview) => FileSystem.deleteAsync(preview.uri, { idempotent: true }))
        .catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const GALLERY_PREVIEW_UPLOAD_TIMEOUT_MS = 60_000;
const GALLERY_PREVIEW_UPLOAD_ATTEMPTS = 2;
/** Hard ceiling on ONE attempt of presign + PUT + record combined. The PUT
 * has its own cancellable 60s timeout, but the presign/record Edge Function
 * calls ride supabase.functions.invoke (itself now bounded by
 * GALLERY_IMPORT_EDGE_TIMEOUT_MS -- see gallery-import.ts), but a raced
 * deadline here still cannot abort an orphaned native PUT, so this stays as
 * an outer safety net: it lets the loop fail the attempt, retry once, and
 * then park the run recoverably rather than hanging indefinitely. */
const GALLERY_PREVIEW_ATTEMPT_DEADLINE_MS = 90_000;

class GalleryPreviewAttemptTimeoutError extends Error {
  constructor() {
    super('The connection stalled while sending a preview. Your place is saved — try continuing.');
  }
}

async function withAttemptDeadline<T>(work: Promise<T>): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new GalleryPreviewAttemptTimeoutError()), GALLERY_PREVIEW_ATTEMPT_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Presign + PUT one preview with a hard per-attempt timeout and one bounded
 * retry. Without the timeout, a single hung connection froze the serial
 * upload loop indefinitely with no error (device-observed: "13 of 318
 * previews sent" forever). Each attempt re-presigns: after a 60s hang the
 * prior signed URL may be near expiry, and presigning is idempotent
 * server-side for the same asset manifest.
 */
async function uploadGalleryPreviewWithRetry(input: {
  familyId: string;
  runId: string;
  runCapability: string;
  assetToken: string;
  preview: { uri: string; width: number; height: number; byteLength: number; sha256: string };
  failureMessage: string;
}): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < GALLERY_PREVIEW_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await withAttemptDeadline((async () => {
        const signed = await getGalleryImportUploadUrl({
          familyId: input.familyId,
          runId: input.runId,
          runCapability: input.runCapability,
          assetToken: input.assetToken,
          contentType: 'image/jpeg',
          previewWidth: input.preview.width,
          previewHeight: input.preview.height,
          byteLength: input.preview.byteLength,
          sha256: input.preview.sha256,
        });
        // GalleryImportServiceCallError (not a plain Error) so a caller far
        // from this call site can still classify the failure -- see
        // errorCountsAsAttempt below.
        if (!signed.data || signed.error) throw new GalleryImportServiceCallError(signed.error?.message ?? input.failureMessage, signed.error?.code);
        const put = await uploadToPresignedUrl(
          signed.data.uploadUrl,
          input.preview.uri,
          'image/jpeg',
          signed.data.requiredHeaders,
          { timeoutMs: GALLERY_PREVIEW_UPLOAD_TIMEOUT_MS },
        );
        if (put.error) throw new GalleryImportServiceCallError(put.error.message, put.error.code);
      })());
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new GalleryImportServiceCallError(input.failureMessage);
    }
  }
  throw lastError ?? new GalleryImportServiceCallError(input.failureMessage);
}

/**
 * A failure "counts" against a chunk's GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS
 * budget only when it is a genuine server refusal (an HTTP-derived code from
 * an Edge Function response) or a distinguishable local-consistency bug
 * (GalleryImportIncompleteCheckpointError's synthetic 'incomplete_checkpoint'
 * code) -- never a transport/connectivity hiccup with no HTTP response at
 * all (no `code`), the Edge Function's own `'timeout'` (gallery-import.ts's
 * mapError, from GALLERY_IMPORT_EDGE_TIMEOUT_MS), or the raw preview PUT's
 * `'upload_timeout'` (media.ts's uploadToPresignedUrl). Three kicks during a
 * bad-connection stretch must not permanently abandon an otherwise-healthy
 * chunk -- only a real, repeated server-side rejection should.
 */
const GALLERY_TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set(['timeout', 'upload_timeout']);

function errorCountsAsAttempt(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.length > 0 && !GALLERY_TRANSIENT_ERROR_CODES.has(code);
}

/** Extracts a `.code` from anything thrown in this module (both custom error
 * classes below carry one; an ordinary Error or non-Error throw does not,
 * which correctly falls through errorCountsAsAttempt as non-counting). */
function extractErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Chunks a freshly-scanned window's clusters into fixed-size checkpoint
 * chunks (GALLERY_IMPORT_CLUSTERS_PER_CHUNK each), continuing ordinals from
 * `startingOrdinal` so a later window's chunks never collide with an earlier
 * one's (chunk ordinals continue across windows -- see the Internal model). */
function chunkClustersFromOrdinal(
  clusters: GalleryCluster[],
  startingOrdinal: number,
): GalleryImportCheckpoint['chunks'] {
  const chunks: GalleryImportCheckpoint['chunks'] = [];
  for (let offset = 0; offset < clusters.length; offset += GALLERY_IMPORT_CLUSTERS_PER_CHUNK) {
    const group = clusters.slice(offset, offset + GALLERY_IMPORT_CLUSTERS_PER_CHUNK);
    chunks.push({
      ordinal: startingOrdinal + chunks.length,
      clusters: group.map((cluster) => ({ clusterSignature: cluster.signature, assetTokens: cluster.assets.map((asset) => asset.assetToken) })),
      status: 'planned',
      previewUploads: [],
    });
  }
  return chunks;
}

function toCheckpoint(input: {
  userId: string;
  familyId: string;
  runId: string;
  runCapability: string;
  snapshot: GalleryScanSnapshot;
}): GalleryImportCheckpoint {
  return {
    version: GALLERY_IMPORT_CHECKPOINT_VERSION,
    userId: input.userId,
    familyId: input.familyId,
    runId: input.runId,
    runCapability: input.runCapability,
    algorithmVersion: input.snapshot.clusters[0]?.algorithmVersion ?? GALLERY_IMPORT_ALGORITHM_VERSION,
    status: 'scanning',
    // Captured only so the progress screen can tell the "nothing stood out"
    // empty outcome apart from "nothing stood out from the few photos you
    // allowed" (gi-entry.jsx GIOutcomeEmpty's limitedNothing) without a second
    // permission lookup. Optional on the type -- checkpoints saved before this
    // field existed simply read as unknown/'full'.
    permissionMode: input.snapshot.permission,
    assetByToken: Object.fromEntries(input.snapshot.clusters.flatMap((cluster) => cluster.assets)
      .map((asset) => [asset.assetToken, asset])),
    uploadedAssetTokens: [],
    clusterSignatures: input.snapshot.clusters.map((cluster) => cluster.signature),
    chunks: chunkClustersFromOrdinal(input.snapshot.clusters, 0),
    deckTotal: 0,
    deckCursor: 0,
    approvalOutbox: [],
    scanReachedLibraryEnd: input.snapshot.reachedLibraryEnd,
    scanCorpusMode: input.snapshot.corpusMode,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Progressive deepening: folds this checkpoint's actually-registered
 * coverage into the persisted frontier, but only once every chunk has left
 * every UNSETTLED status ('planned'/'failed'/'registered'/'uploaded') --
 * i.e. every chunk is either 'dispatched' or 'abandoned'. Coverage is
 * computed from 'dispatched' chunks ONLY: an 'abandoned' chunk contributes
 * nothing, even if it once had a chunkId (register succeeded but
 * upload/dispatch never did) -- the server never actually received/processed
 * those previews, so counting its capture-time range as "covered" would
 * silently skip photos that were never truly examined. This is a deliberate,
 * documented, accepted limitation (see the plan's "Risks / accepted
 * limitations": an abandoned chunk leaves a coverage hole inside its window).
 * Safe to call repeatedly (idempotent merge) and safe to call after a run
 * that never registered anything (every chunk abandoned pre-registration) --
 * that run simply contributes no tokens, so the frontier does not advance
 * past whatever it covered. A crash before every chunk settles means this
 * never runs for that pass, leaving the frontier exactly where it was.
 */
async function maybeAdvanceGalleryImportFrontier(
  userId: string,
  familyId: string,
  checkpoint: GalleryImportCheckpoint,
): Promise<void> {
  const unsettled = new Set(['planned', 'failed', 'registered', 'uploaded']);
  if (checkpoint.chunks.length === 0 || checkpoint.chunks.some((chunk) => unsettled.has(chunk.status))) return;
  let oldestCoveredMs: number | null = null;
  let newestCoveredMs: number | null = null;
  for (const chunk of checkpoint.chunks) {
    // Continuous model fix: an 'abandoned' chunk still contributes its
    // cluster tokens' capture-time range to coverage (never dropped from
    // `chunk.clusters` on abandon -- see the pre-admission abandon path
    // below), even though the server never actually received/processed its
    // previews. Excluding it entirely used to leave the frontier stuck at
    // the same not-yet-covered boundary forever: the next
    // maybeExtendGalleryImportPlan call would re-scan the identical window,
    // abandon it again, and loop indefinitely. The plan's own "Risks"
    // section explicitly accepts this as a coverage hole "treated as
    // settled" -- the trade-off is a silent gap in curated suggestions for
    // that one window, not an infinite non-advancing scan loop.
    if (chunk.status !== 'dispatched' && chunk.status !== 'abandoned') continue;
    for (const cluster of chunk.clusters) {
      for (const assetToken of cluster.assetTokens) {
        const captureAtMs = checkpoint.assetByToken[assetToken]?.captureAtMs;
        if (typeof captureAtMs !== 'number') continue;
        oldestCoveredMs = oldestCoveredMs === null ? captureAtMs : Math.min(oldestCoveredMs, captureAtMs);
        newestCoveredMs = newestCoveredMs === null ? captureAtMs : Math.max(newestCoveredMs, captureAtMs);
      }
    }
  }
  const registeredCoverage = oldestCoveredMs !== null && newestCoveredMs !== null ? { oldestCoveredMs, newestCoveredMs } : null;
  const existing = await loadGalleryImportFrontier(userId, familyId);
  // A checkpoint saved before corpus-mode tracking existed has no
  // scanCorpusMode; treat it as the conservative full-library default
  // (never a false 'camera_album' claim), which naturally resets a
  // persisted camera_album frontier rather than silently mixing under it.
  const corpusMode = checkpoint.scanCorpusMode ?? 'full_library_fallback';
  const next = mergeGalleryImportFrontierCoverage(existing, registeredCoverage, checkpoint.scanReachedLibraryEnd === true, corpusMode);
  if (next) await saveGalleryImportFrontier(userId, familyId, next);
}

function admittedTokens(
  response: GalleryImportRegisteredChunk,
  requestedTokens: string[],
): Set<string> {
  if (!Array.isArray(response.acceptedAssetTokens)) {
    throw new Error('The gallery import service returned an incomplete registration receipt.');
  }
  const accepted = new Set(response.acceptedAssetTokens);
  return new Set([...accepted].filter((token) => requestedTokens.includes(token)));
}

function pruneCheckpointChunk(
  checkpoint: GalleryImportCheckpoint,
  ordinal: number,
  accepted: Set<string>,
  chunkId: string,
): GalleryImportCheckpoint {
  return {
    ...checkpoint,
    chunks: checkpoint.chunks.map((chunk) => chunk.ordinal === ordinal ? {
      ...chunk,
      chunkId,
      status: 'registered',
      clusters: chunk.clusters
        .map((cluster) => ({ ...cluster, assetTokens: cluster.assetTokens.filter((token) => accepted.has(token)) }))
        .filter((cluster) => cluster.assetTokens.length > 0),
    } : chunk),
  };
}

/** A register/upload/dispatch attempt for this chunk was refused or threw.
 * Increments `attempts` ONLY when `countsAsAttempt` is true (see
 * errorCountsAsAttempt) -- a transient/transport failure marks the chunk
 * 'failed' without spending any of its GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS
 * budget, so it is retried indefinitely rather than eventually abandoned for
 * a bad-connection stretch that was never the chunk's fault. At
 * GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS the chunk becomes terminal ('abandoned')
 * instead of retrying forever. See GalleryImportCheckpointChunk['status'] for
 * why 'failed' must stay distinguishable from 'planned' (the "+N coming"
 * phantom-progress bug this fixed originally). */
function markChunkFailedOrAbandoned(checkpoint: GalleryImportCheckpoint, ordinal: number, countsAsAttempt: boolean): GalleryImportCheckpoint {
  return {
    ...checkpoint,
    chunks: checkpoint.chunks.map((chunk) => {
      if (chunk.ordinal !== ordinal) return chunk;
      const attempts = countsAsAttempt ? (chunk.attempts ?? 0) + 1 : (chunk.attempts ?? 0);
      return attempts >= GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS
        ? { ...chunk, status: 'abandoned' as const, attempts }
        : { ...chunk, status: 'failed' as const, attempts };
    }),
  };
}

/** Clears a persisted fair-use pause (see the driver's server re-check). */
export async function clearGalleryImportCheckpointPause(userId: string, familyId: string, runId: string): Promise<void> {
  await updateGalleryImportCheckpoint(userId, familyId, runId, (current) =>
    current.pausedUntil ? { ...current, pausedUntil: undefined } : current).catch(() => undefined);
}

export type GalleryImportProcessChunksReason = 'completed' | 'pass_deadline' | 'fair_use' | 'cancelled';

export interface GalleryImportProcessChunksResult {
  reason: GalleryImportProcessChunksReason;
  /** Present only when `reason === 'fair_use'`. */
  pausedUntil?: string;
}

/**
 * Processes every unsettled chunk in a checkpoint (prepare -> register ->
 * upload -> dispatch), in ordinal order, for at most one driver pass. Never
 * throws for a per-chunk problem -- a chunk-level failure (a register/upload/
 * dispatch call that was refused or errored) marks THAT chunk 'failed'
 * (or 'abandoned' once its attempts are exhausted) and processing continues
 * with the next chunk; only the pass-wide conditions below short-circuit the
 * whole call:
 *
 * - `'pass_deadline'`: `passDeadlineAtMs` was reached before starting new
 *   native work. Whatever chunk was in flight is left in its current
 *   (unclosed) status -- budget pauses work, it never drops it.
 * - `'fair_use'`: a register call was refused with the family's daily
 *   cluster limit (S2). The checkpoint's `pausedUntil` is set and the WHOLE
 *   pass stops immediately (this is a family-wide gate, not a per-chunk one).
 * - `'cancelled'`: `updateGalleryImportCheckpoint` returned `null`, meaning
 *   the checkpoint (and the run behind it) no longer exists.
 * - `'completed'`: every eligible chunk reached a settled status
 *   ('dispatched' or 'abandoned') this pass.
 */
export async function processGalleryImportChunks(input: {
  userId: string;
  familyId: string;
  runId: string;
  adapter: GalleryMediaLibraryAdapter;
  onProgress?: (progress: GalleryImportRunnerProgress) => void;
  passDeadlineAtMs: number;
}): Promise<GalleryImportProcessChunksResult> {
  const loaded = await loadGalleryImportCheckpoint(input.userId, input.familyId, input.runId);
  if (!loaded) return { reason: 'cancelled' };
  // Typed non-nullable (rather than `GalleryImportCheckpoint | null` kept
  // narrowed) so `applyUpdate` below can freely reassign it across this
  // function's whole body without every later read needing to re-check for
  // null -- a `null` update result is handled once, at the call site, by
  // returning `{ reason: 'cancelled' }` per the cancel-awareness rule.
  let checkpoint: GalleryImportCheckpoint = loaded;

  async function applyUpdate(update: (current: GalleryImportCheckpoint) => GalleryImportCheckpoint): Promise<boolean> {
    const next = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, update);
    if (!next) return false;
    checkpoint = next;
    return true;
  }

  /**
   * Marks a chunk failed/abandoned (see markChunkFailedOrAbandoned), but
   * first -- ONLY when this failure would push the chunk over
   * GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS AND it was already registered (has a
   * chunkId) -- makes one best-effort dispatchGalleryImportChunk call
   * reporting every not-yet-uploaded token as unavailable. Without this, an
   * abandoned REGISTERED chunk leaves its server-side chunk row 'uploading'
   * with pending cluster_results forever: pendingClusters over-counts and
   * complete_gallery_import_run refuses with "work in flight". The error
   * from this best-effort call is swallowed -- the cleanup cron's
   * stale-chunk reconciliation (claim_stale_gallery_chunks) is the backstop
   * if it also fails.
   */
  async function failChunk(ordinal: number, countsAsAttempt: boolean): Promise<boolean> {
    const plan = checkpoint.chunks.find((chunk) => chunk.ordinal === ordinal);
    const nextAttempts = countsAsAttempt ? (plan?.attempts ?? 0) + 1 : (plan?.attempts ?? 0);
    if (plan?.chunkId && nextAttempts >= GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS) {
      const uploadedTokens = new Set(plan.previewUploads.map((upload) => upload.assetToken));
      const unavailableAssetTokens = plan.clusters
        .flatMap((cluster) => cluster.assetTokens)
        .filter((token) => !uploadedTokens.has(token));
      await dispatchGalleryImportChunk({
        runId: input.runId,
        familyId: input.familyId,
        runCapability: checkpoint.runCapability,
        chunkId: plan.chunkId,
        previewUploads: plan.previewUploads.map((upload) => ({ ...upload, contentType: 'image/jpeg' as const })),
        ...(unavailableAssetTokens.length > 0 ? { unavailableAssetTokens } : {}),
      }).catch(() => undefined);
    }
    return applyUpdate((current) => markChunkFailedOrAbandoned(current, ordinal, countsAsAttempt));
  }

  const eligibleOrdinals = checkpoint.chunks
    .filter((chunk) => ['planned', 'failed', 'registered', 'uploaded'].includes(chunk.status) && (chunk.attempts ?? 0) < GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS)
    .map((chunk) => chunk.ordinal);

  const totalToPrepare = checkpoint.chunks
    .filter((chunk) => !chunk.chunkId && (chunk.status === 'planned' || chunk.status === 'failed'))
    .reduce((count, chunk) => count + chunk.clusters.reduce((assetCount, cluster) => assetCount + cluster.assetTokens.length, 0), 0);
  const totalAssets = checkpoint.chunks.reduce((count, chunk) => count + chunk.clusters.reduce((assetCount, cluster) => assetCount + cluster.assetTokens.length, 0), 0);
  let preparedCount = 0;
  let uploadedCount = checkpoint.uploadedAssetTokens.length;

  for (const ordinal of eligibleOrdinals) {
    const plan = checkpoint.chunks.find((chunk) => chunk.ordinal === ordinal);
    if (!plan || plan.status === 'dispatched' || plan.status === 'abandoned' || (plan.attempts ?? 0) >= GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS) continue;

    const preparedPreviews = new Map<string, Awaited<ReturnType<typeof createGalleryImportPreview>>>();
    let didRepairPreviewReceipts = false;
    try {
      let chunkId = plan.chunkId;
      if (!chunkId) {
        if (Date.now() >= input.passDeadlineAtMs) return { reason: 'pass_deadline' };
        // Prove each asset can produce a preview before declaring it to the
        // server, so an unavailable cloud original cannot strand an
        // immutable registered manifest.
        for (const cluster of plan.clusters) for (const assetToken of cluster.assetTokens) {
          const asset = checkpoint.assetByToken[assetToken];
          if (!asset) continue;
          try {
            const preview = await prepareGalleryImportAssetPreview({ adapter: input.adapter, osAssetId: asset.osAssetId, runId: input.runId, assetToken, preparationDeadlineAtMs: input.passDeadlineAtMs });
            preparedPreviews.set(assetToken, preview);
            preparedCount += 1;
            input.onProgress?.({ stage: 'preparing', completed: preparedCount, total: totalToPrepare });
          } catch (error) {
            if (error instanceof GalleryImportPreparationBudgetExceededError) return { reason: 'pass_deadline' };
            // Deliberately content-free: the failed local asset never reaches
            // a manifest, analytics, or server log. Continue the rest of the chunk.
          }
        }
        const availableClusters = plan.clusters
          .map((cluster) => ({ ...cluster, assetTokens: cluster.assetTokens.filter((assetToken) => preparedPreviews.has(assetToken)) }))
          .filter((cluster) => cluster.assetTokens.length > 0);

        if (availableClusters.length === 0) {
          // Every asset in this chunk is unavailable before admission --
          // abandon it now rather than fabricating a 'dispatched' outcome
          // (the audited silent-drop bug this replaces). No chunkId exists
          // yet, so there is nothing to dispatch/close server-side.
          // Deliberately keeps `clusters` as-is (never empties them): an
          // abandoned chunk still needs its asset tokens for
          // maybeAdvanceGalleryImportFrontier's coverage calculation, or the
          // frontier never advances past this window and
          // maybeExtendGalleryImportPlan re-scans (and re-abandons) the same
          // window forever.
          if (!await applyUpdate((current) => ({
            ...current,
            chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, status: 'abandoned' as const, attempts: GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS } : chunk),
          }))) return { reason: 'cancelled' };
          continue;
        }

        const manifestClusters: GalleryImportManifestCluster[] = availableClusters.map((cluster) => ({
          clusterSignature: cluster.clusterSignature,
          assets: cluster.assetTokens.map((assetToken) => {
            const asset = checkpoint.assetByToken[assetToken];
            if (!asset) throw new GalleryImportIncompleteCheckpointError();
            return { assetToken, captureDate: localCaptureDate(asset.captureAtMs), width: asset.width, height: asset.height, isFavorite: asset.isFavorite };
          }),
        }));
        const registered = await registerGalleryImportChunk({ familyId: input.familyId, runId: input.runId, runCapability: checkpoint.runCapability, ordinal, clusters: manifestClusters });
        if (!registered.data || registered.error) {
          if (registered.error?.code === 'fair_use') {
            const pausedUntil = new Date(Date.now() + (registered.error.retryAfterSeconds ?? 3600) * 1000).toISOString();
            if (!await applyUpdate((current) => ({ ...current, pausedUntil }))) return { reason: 'cancelled' };
            return { reason: 'fair_use', pausedUntil };
          }
          if (!await failChunk(ordinal, errorCountsAsAttempt(registered.error?.code))) return { reason: 'cancelled' };
          continue;
        }
        chunkId = registered.data.chunkId;
        const requestedTokens = availableClusters.flatMap((cluster) => cluster.assetTokens);
        const accepted = admittedTokens(registered.data, requestedTokens);
        if (!await applyUpdate((current) => {
          const pruned = pruneCheckpointChunk(current, ordinal, accepted, chunkId!);
          // A successful registration proves the family's fair-use window
          // has room again -- clear a stale pause the driver may still be
          // showing.
          return pruned.pausedUntil ? { ...pruned, pausedUntil: undefined } : pruned;
        })) return { reason: 'cancelled' };
        await Promise.all([...preparedPreviews.entries()].filter(([token]) => !accepted.has(token)).map(async ([, preview]) => {
          await FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined);
        }));
        for (const token of [...preparedPreviews.keys()]) if (!accepted.has(token)) preparedPreviews.delete(token);

        if (accepted.size === 0) {
          // Every cluster the server saw was suppressed (already covered by
          // a receipt) -- this chunk is legitimately resolved server-side,
          // not a device-local failure. Mark it 'dispatched' directly
          // (nothing to upload, no dispatch call needed) rather than
          // spending an attempt/abandoning it.
          if (!await applyUpdate((current) => ({
            ...current,
            chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, status: 'dispatched' as const, previewUploads: [] } : chunk),
          }))) return { reason: 'cancelled' };
          continue;
        }
      }

      // --- Upload remaining previews then dispatch. An asset this device can
      // no longer prepare AFTER admission is reported to the server as
      // unavailable (S3) rather than failing the whole chunk; only a real
      // upload/dispatch failure does that. ---
      while (true) {
        const livePlan = checkpoint.chunks.find((chunk) => chunk.ordinal === ordinal);
        if (!livePlan || !chunkId) break;
        for (const cluster of livePlan.clusters) for (const assetToken of cluster.assetTokens) {
          if (livePlan.previewUploads.some((upload) => upload.assetToken === assetToken)) continue;
          const asset = checkpoint.assetByToken[assetToken];
          if (!asset) continue; // reported as unavailable at dispatch time below
          let preview = preparedPreviews.get(assetToken);
          if (!preview) {
            if (Date.now() >= input.passDeadlineAtMs) return { reason: 'pass_deadline' };
            try {
              preview = await prepareGalleryImportAssetPreview({ adapter: input.adapter, osAssetId: asset.osAssetId, runId: input.runId, assetToken, preparationDeadlineAtMs: input.passDeadlineAtMs });
              preparedPreviews.set(assetToken, preview);
            } catch (error) {
              if (error instanceof GalleryImportPreparationBudgetExceededError) return { reason: 'pass_deadline' };
              continue; // S3: unavailable post-admission, not a chunk failure.
            }
          }
          await uploadGalleryPreviewWithRetry({ familyId: input.familyId, runId: input.runId, runCapability: checkpoint.runCapability, assetToken, preview, failureMessage: 'Could not resume a preview upload.' });
          await FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined);
          preparedPreviews.delete(assetToken);
          uploadedCount += 1;
          input.onProgress?.({ stage: 'uploading', completed: uploadedCount, total: totalAssets });
          const capturedPreview = preview;
          if (!await applyUpdate((current) => ({
            ...current,
            uploadedAssetTokens: current.uploadedAssetTokens.includes(assetToken) ? current.uploadedAssetTokens : [...current.uploadedAssetTokens, assetToken],
            chunks: current.chunks.map((chunk) => chunk.ordinal === livePlan.ordinal ? {
              ...chunk,
              previewUploads: chunk.previewUploads.some((upload) => upload.assetToken === assetToken)
                ? chunk.previewUploads
                : [...chunk.previewUploads, { assetToken, previewWidth: capturedPreview.width, previewHeight: capturedPreview.height, byteLength: capturedPreview.byteLength, sha256: capturedPreview.sha256 }],
            } : chunk),
          }))) return { reason: 'cancelled' };
        }

        const ready = checkpoint.chunks.find((chunk) => chunk.ordinal === ordinal);
        if (!ready?.chunkId) break;
        const uploadedTokens = new Set(ready.previewUploads.map((upload) => upload.assetToken));
        const unavailableAssetTokens = ready.clusters
          .flatMap((cluster) => cluster.assetTokens)
          .filter((token) => !uploadedTokens.has(token));
        const dispatched = await dispatchGalleryImportChunk({
          runId: input.runId,
          familyId: input.familyId,
          runCapability: checkpoint.runCapability,
          chunkId: ready.chunkId,
          previewUploads: ready.previewUploads.map((upload) => ({ ...upload, contentType: 'image/jpeg' as const })),
          ...(unavailableAssetTokens.length > 0 ? { unavailableAssetTokens } : {}),
        });
        if (dispatched.data && !dispatched.error) {
          if (!await applyUpdate((current) => ({ ...current, chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, status: 'dispatched' as const } : chunk) }))) return { reason: 'cancelled' };
          const dispatchedCount = checkpoint.chunks.filter((chunk) => chunk.status === 'dispatched' || chunk.status === 'abandoned').length;
          input.onProgress?.({ stage: 'dispatching', completed: dispatchedCount, total: checkpoint.chunks.length });
          break;
        }
        if (dispatched.error?.code === 'preview_not_ready' && !didRepairPreviewReceipts) {
          const staleTokens = new Set(ready.previewUploads.map((upload) => upload.assetToken));
          if (!await applyUpdate((current) => ({
            ...current,
            uploadedAssetTokens: current.uploadedAssetTokens.filter((assetToken) => !staleTokens.has(assetToken)),
            chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, previewUploads: [] } : chunk),
          }))) return { reason: 'cancelled' };
          uploadedCount = checkpoint.uploadedAssetTokens.length;
          didRepairPreviewReceipts = true;
          continue;
        }
        // A genuine dispatch refusal (any other error) is a chunk-level
        // failure classified like every other one -- handled inline (not
        // thrown) so it shares the same errorCountsAsAttempt classification
        // as register failures.
        if (!await failChunk(ordinal, errorCountsAsAttempt(dispatched.error?.code))) return { reason: 'cancelled' };
        break;
      }
    } catch (error) {
      if (error instanceof GalleryImportPreparationBudgetExceededError) return { reason: 'pass_deadline' };
      await failChunk(ordinal, errorCountsAsAttempt(extractErrorCode(error))).catch(() => undefined);
    } finally {
      await Promise.all([...preparedPreviews.values()].map((preview) =>
        FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined)));
    }
  }

  return { reason: 'completed' };
}

/**
 * A new window is only planned once every existing chunk has settled
 * ('dispatched' or 'abandoned'), the server+local backlog is below
 * GALLERY_IMPORT_TARGET_BACKLOG, the frontier says more history exists,
 * `autoContinue` is on, and no fair-use pause is active -- see the Internal
 * model's "Windows" paragraph. Returns the number of new chunks appended (0
 * when no extension happened, for any reason).
 */
export async function maybeExtendGalleryImportPlan(input: {
  userId: string;
  familyId: string;
  runId: string;
  adapter: GalleryMediaLibraryAdapter;
}): Promise<number> {
  const checkpoint = await loadGalleryImportCheckpoint(input.userId, input.familyId, input.runId);
  if (!checkpoint) return 0;
  if (checkpoint.pausedUntil && new Date(checkpoint.pausedUntil).getTime() > Date.now()) return 0;
  if (checkpoint.chunks.some((chunk) => chunk.status !== 'dispatched' && chunk.status !== 'abandoned')) return 0;

  const frontier = await loadGalleryImportFrontier(input.userId, input.familyId);
  if (frontier?.autoContinue === false) return 0;
  if (frontier?.completedLibrary) return 0;

  const remote = await getGalleryImportRun({ runId: input.runId, runCapability: checkpoint.runCapability });
  if (!remote.data || remote.error) return 0;
  if (isGalleryImportRunTerminal(remote.data.status)) return 0;

  // Cheaper than scanning and then being refused at register: if the server
  // already reports an active fair-use pause (S1's fairUse.pausedUntil),
  // record it locally and stop here.
  const serverPausedUntil = remote.data.fairUse?.pausedUntil ?? null;
  if (serverPausedUntil && new Date(serverPausedUntil).getTime() > Date.now()) {
    await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) => ({ ...current, pausedUntil: serverPausedUntil }));
    return 0;
  }

  const localUnsettledClusters = checkpoint.chunks
    .filter((chunk) => chunk.status !== 'dispatched' && chunk.status !== 'abandoned')
    .reduce((count, chunk) => count + chunk.clusters.length, 0);
  const backlog = (remote.data.readyCandidates ?? 0) + (remote.data.pendingClusters ?? 0) + localUnsettledClusters;
  if (backlog >= GALLERY_IMPORT_TARGET_BACKLOG) return 0;

  const snapshot = await scanGallerySnapshot(input.adapter, {
    frontier: frontier ? { coveredThroughNewestMs: frontier.coveredThroughNewestMs, oldestCoveredMs: frontier.oldestCoveredMs, corpusMode: frontier.corpusMode } : null,
    targetClusterCount: GALLERY_IMPORT_WINDOW_CLUSTERS,
  });
  // Safety net: an abandoned-then-re-scanned window (or any other overlap)
  // must never re-add a cluster this checkpoint has already seen -- without
  // this, a fully-abandoned window whose frontier advance is itself
  // documented as "treated as settled" could still get re-proposed by a
  // scan that (depending on adapter/paging specifics) reaches the same
  // signatures again.
  const existingSignatures = new Set(checkpoint.clusterSignatures);
  const newClusters = snapshot.clusters.filter((cluster) => !existingSignatures.has(cluster.signature));
  if (newClusters.length === 0) return 0;

  const nextOrdinal = checkpoint.chunks.length > 0 ? Math.max(...checkpoint.chunks.map((chunk) => chunk.ordinal)) + 1 : 0;
  const newChunks = chunkClustersFromOrdinal(newClusters, nextOrdinal);
  const newAssetByToken = Object.fromEntries(newClusters.flatMap((cluster) => cluster.assets).map((asset) => [asset.assetToken, asset]));

  const extended = pruneGalleryImportCheckpoint({
    ...checkpoint,
    assetByToken: { ...checkpoint.assetByToken, ...newAssetByToken },
    clusterSignatures: [...checkpoint.clusterSignatures, ...newClusters.map((cluster) => cluster.signature)],
    chunks: [...checkpoint.chunks, ...newChunks],
    scanReachedLibraryEnd: snapshot.reachedLibraryEnd,
    scanCorpusMode: snapshot.corpusMode,
  }, remote.data);

  await saveGalleryImportCheckpoint(extended);
  return newChunks.length;
}

/**
 * Foreground-only scan + preview/upload dispatcher. The only durable local
 * state is a user-scoped AsyncStorage checkpoint; raw OS asset ids never
 * leave it. AsyncStorage is not encrypted by this app.
 *
 * Continuous model (2026-08-23): scans and admits ONE window
 * (GALLERY_IMPORT_WINDOW_CLUSTERS clusters) rather than a whole run's worth,
 * then hands off to `processGalleryImportChunks` for the actual register/
 * upload/dispatch work. Extending to further windows once this one settles
 * is `resumeGalleryImportRunner`'s/the driver's job, not this function's --
 * this keeps a fresh start's shape identical to before (same return value).
 */
export async function startGalleryImportRunner(input: {
  userId: string;
  familyId: string;
  useCellular: boolean;
  adapter?: GalleryMediaLibraryAdapter;
  onProgress?: (progress: GalleryImportRunnerProgress) => void;
  /** Fires once as soon as a run id exists (right after the checkpoint for it
   * is durably saved) -- before preparing/uploading/dispatching any chunk.
   * Lets a caller navigate to a run-scoped progress screen immediately
   * instead of keeping the user parked on the starting screen for the whole
   * (potentially multi-minute) preparation pass; this function keeps running
   * to completion regardless of what the caller does with that callback. */
  onRunStarted?: (runId: string) => void;
}): Promise<{ runId: string; scannedAssetCount: number; clusterCount: number; moreHistoryToScan: boolean }> {
  const adapter = input.adapter ?? getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
  // Progressive deepening: continue from wherever a prior run left off
  // instead of always re-covering the same newest window. A missing/corrupt
  // frontier degrades to undefined, i.e. today's fresh top-of-library scan.
  const priorFrontier = await loadGalleryImportFrontier(input.userId, input.familyId);
  const snapshot = await scanGallerySnapshot(adapter, {
    // scanGallerySnapshot independently guards a corpus-mode mismatch (e.g.
    // the Android camera album disappeared since priorFrontier was built) by
    // ignoring these bounds and scanning fresh under its own resolved mode.
    frontier: priorFrontier
      ? { coveredThroughNewestMs: priorFrontier.coveredThroughNewestMs, oldestCoveredMs: priorFrontier.oldestCoveredMs, corpusMode: priorFrontier.corpusMode }
      : null,
    targetClusterCount: GALLERY_IMPORT_WINDOW_CLUSTERS,
    onPage: ({ scannedAssetCount }) => input.onProgress?.({
      stage: 'scanning', completed: scannedAssetCount, total: scannedAssetCount, scannedAssetCount,
    }),
    yieldToEventLoop: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  if (snapshot.clusters.length === 0) {
    throw new GalleryImportEmptyLibraryError();
  }
  // Do this before server admission so a Wi-Fi pause never leaves an active
  // run that a later cellular retry would accidentally duplicate.
  const network = await NetInfo.fetch();
  if (!input.useCellular && !isWifiAvailable(network)) {
    throw new GalleryImportWaitingForWifiError();
  }
  const created = await createGalleryImportRun({
    familyId: input.familyId,
    algorithmVersion: GALLERY_IMPORT_ALGORITHM_VERSION,
    consentVersion: GALLERY_IMPORT_CONSENT_VERSION,
    permissionMode: snapshot.permission,
  });
  if (!created.data || created.error) {
    throw new GalleryImportServiceRequestError(created.error?.message ?? 'Could not start the import.', created.error?.code);
  }
  const createdRun = created.data;

  // The scan's own window cap protects the handset already; the server's
  // snapshot limits remain a defensive ceiling (admission settings may be
  // lower than the client window in some deployments) applied before any
  // preview is made or bytes are uploaded.
  const clusters = snapshot.clusters
    .slice(0, createdRun.run.limits.maxClusters)
    .map((cluster) => ({ ...cluster, assets: cluster.assets.slice(0, createdRun.run.limits.maxAssetsPerCluster) }));
  const cappedSnapshot = { ...snapshot, clusters };
  const checkpoint = toCheckpoint({
    userId: input.userId,
    familyId: input.familyId,
    runId: createdRun.run.id,
    runCapability: createdRun.runCapability,
    snapshot: cappedSnapshot,
  });
  await saveGalleryImportCheckpoint(checkpoint);
  input.onRunStarted?.(createdRun.run.id);

  // Metadata scanning, network admission, and durable checkpointing do not
  // consume the native original-resolution/preview budget.
  const passDeadlineAtMs = Date.now() + GALLERY_IMPORT_PREPARATION_BUDGET_MS;
  const result = await processGalleryImportChunks({
    userId: input.userId, familyId: input.familyId, runId: createdRun.run.id, adapter, onProgress: input.onProgress, passDeadlineAtMs,
  });
  if (result.reason === 'fair_use') {
    throw new GalleryImportFairUsePausedError(result.pausedUntil ?? new Date().toISOString());
  }

  // Only reachable once processGalleryImportChunks above has settled or
  // paused every chunk it could reach this pass -- a crash before this point
  // leaves the frontier exactly where it was, per progressive deepening's
  // crash-safety requirement.
  const settledCheckpoint = await loadGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id);
  if (settledCheckpoint) await maybeAdvanceGalleryImportFrontier(input.userId, input.familyId, settledCheckpoint);
  const finalFrontier = await loadGalleryImportFrontier(input.userId, input.familyId);

  return {
    runId: createdRun.run.id,
    scannedAssetCount: snapshot.scannedAssetCount,
    clusterCount: clusters.length,
    // Data only -- no UI affordance here (a separate round owns that). True
    // whenever the persisted frontier has not yet proven it reached the
    // library's oldest end; also true (conservatively) before any frontier
    // exists at all. A precise remaining-photo count is not cheaply
    // available without a second full-corpus enumeration, so it is omitted.
    moreHistoryToScan: !finalFrontier?.completedLibrary,
  };
}

export function galleryImportRunnerErrorMessage(error: unknown): string {
  return errorMessage(error, 'Could not continue the gallery import.');
}

/**
 * Reconciles a device-bound checkpoint after force-quit, processes every
 * unsettled chunk, then (continuous model) keeps extending to further
 * windows -- via `maybeExtendGalleryImportPlan` -- and processing them for
 * as long as this pass's budget allows and the backlog/frontier/autoContinue
 * conditions keep saying "extend". Repeating a signed PUT or dispatch is
 * safe: the server verifies the same object receipt and the Workflow id is
 * deterministic per chunk. No new run is created here.
 */
export async function resumeGalleryImportRunner(input: {
  userId: string;
  familyId: string;
  runId: string;
  adapter?: GalleryMediaLibraryAdapter;
  onProgress?: (progress: GalleryImportRunnerProgress) => void;
  /** Mirrors startGalleryImportRunner's useCellular: when the resume still has
   * previews to upload and this is not set (and the checkpoint itself has not
   * persisted an earlier `allowCellular` choice -- see gallery-import-driver.ts),
   * a non-Wi-Fi network throws GalleryImportWaitingForWifiError up front
   * instead of spending cellular data. */
  allowCellular?: boolean;
}): Promise<GalleryImportProcessChunksResult | void> {
  const loadedCheckpoint = await loadGalleryImportCheckpoint(input.userId, input.familyId, input.runId);
  if (!loadedCheckpoint) throw new Error('This import is only available on the device where it was started.');
  let checkpoint: GalleryImportCheckpoint = loadedCheckpoint;
  const remote = await getGalleryImportRun({ runId: input.runId, runCapability: checkpoint.runCapability });
  if (remote.error || !remote.data) throw new Error(remote.error?.message ?? 'Could not reconcile this import.');
  if (['cancelled', 'expired', 'completed'].includes(remote.data.status)) {
    await Promise.all([clearGalleryImportCheckpoint(input.userId, input.familyId, input.runId), clearGalleryImportPreviewCache(input.runId)]);
    return;
  }
  // A run reaching 'reviewing' does NOT mean the chunk manifest is closed --
  // the server keeps admitting new chunks for as long as the run is not
  // terminal. Only the local status label is reconciled here; every chunk
  // below still goes through the exact same register/upload/dispatch
  // continuation as a 'processing' run.
  if (remote.data.status === 'reviewing' && checkpoint.status !== 'reviewing') {
    const next = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) =>
      current.status === 'reviewing' ? current : { ...current, status: 'reviewing' });
    checkpoint = next ?? checkpoint;
  }
  // Only gate on Wi-Fi when there is real upload work left -- a checkpoint
  // whose chunks are all already settled (dispatched/abandoned) must not
  // wait on Wi-Fi it will never use.
  const allowCellular = input.allowCellular === true || checkpoint.allowCellular === true;
  const hasPendingUploadWork = checkpoint.chunks.some((chunk) => chunk.status !== 'dispatched' && chunk.status !== 'abandoned');
  if (hasPendingUploadWork && !allowCellular) {
    const network = await NetInfo.fetch();
    if (!isWifiAvailable(network)) throw new GalleryImportWaitingForWifiError();
  }
  const adapter = input.adapter ?? getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
  // Remote reconciliation is outside the bounded local native preparation
  // pass; the absolute deadline starts immediately before chunk processing.
  const passDeadlineAtMs = Date.now() + GALLERY_IMPORT_PREPARATION_BUDGET_MS;

  while (true) {
    const result = await processGalleryImportChunks({
      userId: input.userId, familyId: input.familyId, runId: input.runId, adapter, onProgress: input.onProgress, passDeadlineAtMs,
    });
    if (result.reason === 'fair_use') {
      throw new GalleryImportFairUsePausedError(result.pausedUntil ?? new Date().toISOString());
    }
    if (result.reason === 'cancelled') return result;

    // Only reachable once every chunk this pass could reach has settled or
    // paused -- an earlier return skips this, leaving the frontier exactly
    // where it was (progressive deepening's crash-safety requirement).
    const settled = await loadGalleryImportCheckpoint(input.userId, input.familyId, input.runId);
    if (!settled) return result;
    await maybeAdvanceGalleryImportFrontier(input.userId, input.familyId, settled);

    if (result.reason === 'pass_deadline' || Date.now() >= passDeadlineAtMs) return result;

    const addedChunks = await maybeExtendGalleryImportPlan({ userId: input.userId, familyId: input.familyId, runId: input.runId, adapter });
    if (addedChunks === 0) return result;

    // Extension just appended a new window's worth of 'planned' chunks. The
    // Wi-Fi gate above only ran once, before the loop started, and does
    // nothing when every existing chunk was already settled (no pending
    // upload work at that time) -- without re-checking here, a freshly
    // extended window would upload over cellular even with allowCellular
    // false.
    if (!allowCellular) {
      const network = await NetInfo.fetch();
      if (!isWifiAvailable(network)) throw new GalleryImportWaitingForWifiError();
    }
    // Loop again to process the newly-planned window's chunks within the
    // same pass, for as long as the deadline and extension conditions allow.
  }
}
