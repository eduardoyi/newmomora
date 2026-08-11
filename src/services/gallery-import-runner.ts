import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';

import { uploadToPresignedUrl } from '@/services/media';
import {
  cancelGalleryImportRun,
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
  saveGalleryImportCheckpoint,
  updateGalleryImportCheckpoint,
  type GalleryImportCheckpoint,
} from '@/utils/gallery-import-checkpoint';
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
  type GalleryMediaLibraryAdapter,
  type GalleryScanSnapshot,
} from '@/utils/gallery-import-scanner';
import { GALLERY_IMPORT_ALGORITHM_VERSION } from '@/constants/gallery-import';

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
 * calls ride supabase.functions.invoke, which has NO timeout -- a hung
 * presign froze the loop for minutes with zero error (device-observed:
 * "63 of 318" stalled six minutes, server silent after upload 56). A raced
 * deadline cannot abort the orphaned fetch, but it lets the loop fail the
 * attempt, retry once, and then park the run recoverably. */
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
        if (!signed.data || signed.error) throw new Error(signed.error?.message ?? input.failureMessage);
        const put = await uploadToPresignedUrl(
          signed.data.uploadUrl,
          input.preview.uri,
          'image/jpeg',
          signed.data.requiredHeaders,
          { timeoutMs: GALLERY_PREVIEW_UPLOAD_TIMEOUT_MS },
        );
        if (put.error) throw new Error(put.error.message);
      })());
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(input.failureMessage);
    }
  }
  throw lastError ?? new Error(input.failureMessage);
}

function toCheckpoint(input: {
  userId: string;
  familyId: string;
  runId: string;
  runCapability: string;
  snapshot: GalleryScanSnapshot;
}): GalleryImportCheckpoint {
  return {
    version: 2,
    userId: input.userId,
    familyId: input.familyId,
    runId: input.runId,
    runCapability: input.runCapability,
    algorithmVersion: input.snapshot.clusters[0]?.algorithmVersion ?? 'gallery-v1',
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
    chunks: [],
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
 * coverage (only assets that survived local prep AND server admission --
 * i.e. accepted tokens inside `chunk.clusters`, never the raw scan) into the
 * persisted frontier, but only once every chunk has left 'planned' status.
 * Safe to call repeatedly (idempotent merge) and safe to call after a chunk
 * that never truly registered anything (an all-prep-failed chunk fast-pathed
 * straight to 'dispatched' with empty clusters) -- that chunk simply
 * contributes no tokens, so the frontier does not advance past whatever it
 * covered. A crash before every chunk settles means this never runs for
 * that pass, so the frontier is left exactly where it was. A 'failed' chunk
 * (see GalleryImportCheckpointChunk['status']) gates the same way as
 * 'planned': its `clusters` may still be the full unregistered manifest
 * (registration itself failed) rather than the server-admitted subset, so
 * treating it as settled coverage could advance the frontier past tokens the
 * server never actually accepted.
 */
async function maybeAdvanceGalleryImportFrontier(
  userId: string,
  familyId: string,
  checkpoint: GalleryImportCheckpoint,
): Promise<void> {
  if (checkpoint.chunks.length === 0 || checkpoint.chunks.some((chunk) => chunk.status === 'planned' || chunk.status === 'failed')) return;
  let oldestCoveredMs: number | null = null;
  let newestCoveredMs: number | null = null;
  for (const chunk of checkpoint.chunks) {
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

/**
 * Marks one checkpoint chunk 'failed' after its register/dispatch call was
 * refused or threw, instead of leaving it 'planned'/'registered'/'uploaded'
 * forever. See GalleryImportCheckpointChunk['status'] and
 * galleryImportStillComingCount (gallery-import-deck.ts) for why a
 * distinguishable terminal-ish status matters here: a resume attempt still
 * retries a 'failed' chunk exactly like a 'planned' one (see
 * resumeGalleryImportRunner's loop below), so this never blocks recovery --
 * it only stops the chunk from silently promising progress that already
 * failed. Best-effort: a checkpoint write failure here must not mask the
 * original registration/dispatch error being thrown right after this call.
 */
async function markGalleryImportCheckpointChunkFailed(
  userId: string,
  familyId: string,
  runId: string,
  ordinal: number,
): Promise<void> {
  await updateGalleryImportCheckpoint(userId, familyId, runId, (current) => ({
    ...current,
    chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, status: 'failed' } : chunk),
  })).catch(() => undefined);
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

/**
 * Foreground-only scan + preview/upload dispatcher. The only durable local
 * state is a user-scoped AsyncStorage checkpoint; raw OS asset ids never
 * leave it. AsyncStorage is not encrypted by this app.
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

  // The scan's own caps protect the handset. The server's snapshot is the
  // admission authority and may be lower, so apply it before any preview is
  // made or bytes are uploaded.
  const clusters = snapshot.clusters
    .slice(0, createdRun.run.limits.maxClusters)
    .map((cluster) => ({ ...cluster, assets: cluster.assets.slice(0, createdRun.run.limits.maxAssetsPerCluster) }));
  const cappedSnapshot = { ...snapshot, clusters };
  const maxChunks = Math.max(1, createdRun.run.limits.maxChunks);
  const clusterChunkSize = Math.max(1, Math.ceil(clusters.length / maxChunks));
  const checkpoint = toCheckpoint({
    userId: input.userId,
    familyId: input.familyId,
    runId: createdRun.run.id,
    runCapability: createdRun.runCapability,
    snapshot: cappedSnapshot,
  });
  checkpoint.chunks = Array.from({ length: Math.ceil(clusters.length / clusterChunkSize) }, (_, ordinal) => ({
    ordinal,
    clusters: clusters.slice(ordinal * clusterChunkSize, (ordinal + 1) * clusterChunkSize).map((cluster) => ({
      clusterSignature: cluster.signature,
      assetTokens: cluster.assets.map((asset) => asset.assetToken),
    })),
    status: 'planned' as const,
    previewUploads: [],
  }));
  await saveGalleryImportCheckpoint(checkpoint);
  input.onRunStarted?.(createdRun.run.id);

  // Metadata scanning, network admission, and durable checkpointing do not
  // consume the native original-resolution/preview budget.
  const preparationDeadlineAtMs = Date.now() + GALLERY_IMPORT_PREPARATION_BUDGET_MS;
  const totalAssets = clusters.reduce((count, cluster) => count + cluster.assets.length, 0);
  let preparedCount = 0;
  let uploadedCount = 0;

  for (let offset = 0, ordinal = 0; offset < clusters.length; offset += clusterChunkSize, ordinal += 1) {
    const chunkClusters = clusters.slice(offset, offset + clusterChunkSize);
    const previewsByToken = new Map<string, Awaited<ReturnType<typeof createGalleryImportPreview>>>();
    // Transform serially before registering the manifest. A corrupt or
    // iCloud-unavailable asset is omitted from this chunk; it cannot strand
    // the other photos behind a server declaration it will never upload.
    for (const cluster of chunkClusters) for (const asset of cluster.assets) {
      try {
        const preview = await prepareGalleryImportAssetPreview({ adapter, osAssetId: asset.osAssetId, runId: createdRun.run.id, assetToken: asset.assetToken, preparationDeadlineAtMs });
        previewsByToken.set(asset.assetToken, preview);
        preparedCount += 1;
        input.onProgress?.({ stage: 'preparing', completed: preparedCount, total: totalAssets });
      } catch {
        // Deliberately content-free: the failed local asset never reaches a
        // manifest, analytics, or server log. Continue the rest of the chunk.
      }
    }
    const availableClusters = chunkClusters
      .map((cluster) => ({ ...cluster, assets: cluster.assets.filter((asset) => previewsByToken.has(asset.assetToken)) }))
      .filter((cluster) => cluster.assets.length > 0);
    if (availableClusters.length === 0) {
      await updateGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id, (current) => ({
        ...current,
        chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, status: 'dispatched', clusters: [] } : chunk),
      }));
      continue;
    }
    const manifestClusters: GalleryImportManifestCluster[] = availableClusters.map((cluster) => ({
      clusterSignature: cluster.signature,
      assets: cluster.assets.map((asset) => ({ assetToken: asset.assetToken, captureDate: localCaptureDate(asset.captureAtMs), width: asset.width ? Math.floor(asset.width) : null, height: asset.height ? Math.floor(asset.height) : null, isFavorite: asset.isFavorite })),
    }));
    const registered = await registerGalleryImportChunk({
      familyId: input.familyId,
      runId: createdRun.run.id,
      runCapability: createdRun.runCapability,
      ordinal,
      clusters: manifestClusters,
    });
    if (!registered.data || registered.error) {
      await markGalleryImportCheckpointChunkFailed(input.userId, input.familyId, createdRun.run.id, ordinal);
      throw new Error(registered.error?.message ?? 'Could not register the import chunk.');
    }
    const requestedTokens = availableClusters.flatMap((cluster) => cluster.assets.map((asset) => asset.assetToken));
    const accepted = admittedTokens(registered.data, requestedTokens);
    const admittedClusters = availableClusters
      .map((cluster) => ({ ...cluster, assets: cluster.assets.filter((asset) => accepted.has(asset.assetToken)) }))
      .filter((cluster) => cluster.assets.length > 0);
    await updateGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id, (current) =>
      pruneCheckpointChunk(current, ordinal, accepted, registered.data!.chunkId));
    await Promise.all([...previewsByToken.entries()].filter(([token]) => !accepted.has(token)).map(async ([, preview]) => {
      await FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined);
    }));
    if (admittedClusters.length === 0) {
      await updateGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id, (current) => ({
        ...current,
        chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, status: 'dispatched', previewUploads: [] } : chunk),
      }));
      input.onProgress?.({ stage: 'dispatching', completed: ordinal + 1, total: Math.ceil(clusters.length / clusterChunkSize) });
      continue;
    }
    for (const cluster of admittedClusters) {
      for (const asset of cluster.assets) {
        const preview = previewsByToken.get(asset.assetToken);
        if (!preview) continue;
        await uploadGalleryPreviewWithRetry({
          familyId: input.familyId,
          runId: createdRun.run.id,
          runCapability: createdRun.runCapability,
          assetToken: asset.assetToken,
          preview,
          failureMessage: 'Could not prepare the preview upload.',
        });
        await FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined);
        uploadedCount += 1;
        input.onProgress?.({ stage: 'uploading', completed: uploadedCount, total: totalAssets });
        await updateGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id, (current) => ({
          ...current,
          uploadedAssetTokens: current.uploadedAssetTokens.includes(asset.assetToken)
            ? current.uploadedAssetTokens
            : [...current.uploadedAssetTokens, asset.assetToken],
          assetByToken: {
            ...current.assetByToken,
            [asset.assetToken]: { ...current.assetByToken[asset.assetToken], previewUri: undefined },
          },
          chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? {
            ...chunk,
            previewUploads: chunk.previewUploads.some((entry) => entry.assetToken === asset.assetToken)
              ? chunk.previewUploads
              : [...chunk.previewUploads, {
                assetToken: asset.assetToken,
                previewWidth: preview.width,
                previewHeight: preview.height,
                byteLength: preview.byteLength,
                sha256: preview.sha256,
              }],
          } : chunk),
        }));
      }
    }
    const dispatched = await dispatchGalleryImportChunk({
      familyId: input.familyId,
      runId: createdRun.run.id,
      runCapability: createdRun.runCapability,
      chunkId: registered.data.chunkId,
      previewUploads: admittedClusters.flatMap((cluster) => cluster.assets.map((asset) => {
        const preview = previewsByToken.get(asset.assetToken);
        if (!preview) throw new Error('An admitted gallery preview is missing from local state.');
        return { assetToken: asset.assetToken, contentType: 'image/jpeg' as const, previewWidth: preview.width, previewHeight: preview.height, byteLength: preview.byteLength, sha256: preview.sha256 };
      })),
    });
    if (!dispatched.data || dispatched.error) {
      await markGalleryImportCheckpointChunkFailed(input.userId, input.familyId, createdRun.run.id, ordinal);
      throw new Error(dispatched.error?.message ?? 'Could not send the previews for curation.');
    }
    await updateGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id, (current) => ({
      ...current,
      chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, status: 'dispatched' } : chunk),
    }));
    input.onProgress?.({ stage: 'dispatching', completed: ordinal + 1, total: Math.ceil(clusters.length / clusterChunkSize) });
  }
  // Only reachable once every chunk above has finished its loop iteration
  // (registered/dispatched, or fast-pathed to 'dispatched' with nothing to
  // register) -- an earlier throw skips this, leaving the frontier exactly
  // where it was, per progressive deepening's crash-safety requirement.
  const settledCheckpoint = await loadGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id);
  if (settledCheckpoint) await maybeAdvanceGalleryImportFrontier(input.userId, input.familyId, settledCheckpoint);
  const finalFrontier = await loadGalleryImportFrontier(input.userId, input.familyId);
  if (preparedCount === 0) {
    await cancelGalleryImportRun({ runId: createdRun.run.id, capability: createdRun.runCapability }).catch(() => undefined);
    await Promise.all([
      clearGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id),
      clearGalleryImportPreviewCache(createdRun.run.id),
    ]);
    throw new Error('Momora could not prepare any of these photos. Check that the originals are available on this device, then try again.');
  }
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
 * Reconciles a device-bound checkpoint after force-quit. Repeating a signed
 * PUT or dispatch is safe: the server verifies the same object receipt and
 * the Workflow id is deterministic per chunk. No new run is created here.
 */
export async function resumeGalleryImportRunner(input: {
  userId: string;
  familyId: string;
  runId: string;
  adapter?: GalleryMediaLibraryAdapter;
  onProgress?: (progress: GalleryImportRunnerProgress) => void;
  /** Mirrors startGalleryImportRunner's useCellular: when the resume still has
   * previews to upload and this is not set, a non-Wi-Fi network throws
   * GalleryImportWaitingForWifiError up front instead of spending cellular
   * data -- see gallery-import-progress.tsx's cellular-confirm sheet, which
   * is the only caller that passes `true`. */
  allowCellular?: boolean;
}): Promise<void> {
  let checkpoint = await loadGalleryImportCheckpoint(input.userId, input.familyId, input.runId);
  if (!checkpoint) throw new Error('This import is only available on the device where it was started.');
  const remote = await getGalleryImportRun({ runId: input.runId, runCapability: checkpoint.runCapability });
  if (remote.error || !remote.data) throw new Error(remote.error?.message ?? 'Could not reconcile this import.');
  if (['cancelled', 'expired', 'completed'].includes(remote.data.status)) {
    await Promise.all([clearGalleryImportCheckpoint(input.userId, input.familyId, input.runId), clearGalleryImportPreviewCache(input.runId)]);
    return;
  }
  // A run reaching 'reviewing' does NOT mean the chunk manifest is closed --
  // the server keeps admitting new chunks for as long as the run is not
  // terminal (see the 20260811090000 migration's header for the device-
  // verified race this fixes: a fast worker completes chunk 1's AI pass and
  // flips the run to 'reviewing' while a real library's remaining planned
  // chunks are still being registered/uploaded/dispatched). This function
  // used to treat 'reviewing' as "nothing more will ever be accepted" and
  // force every not-yet-dispatched chunk here to a fabricated 'dispatched'
  // state -- silently discarding real, still-registrable/still-uploadable
  // work with no error and no distinguishable checkpoint state (the device-
  // observed "+51 coming" that never resolved). Only the local status label
  // is reconciled here now; every chunk below still goes through the exact
  // same register/upload/dispatch continuation as a 'processing' run.
  if (remote.data.status === 'reviewing' && checkpoint.status !== 'reviewing') {
    const next = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) =>
      current.status === 'reviewing' ? current : { ...current, status: 'reviewing' });
    checkpoint = next ?? checkpoint;
  }
  // Only gate when there is real upload work left -- a checkpoint whose
  // chunks are all already 'dispatched' (nothing left to send) must not wait
  // on Wi-Fi it will never use.
  const hasPendingUploadWork = checkpoint.chunks.some((chunk) => chunk.status !== 'dispatched');
  if (hasPendingUploadWork && !input.allowCellular) {
    const network = await NetInfo.fetch();
    if (!isWifiAvailable(network)) throw new GalleryImportWaitingForWifiError();
  }
  const adapter = input.adapter ?? getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
  // Remote reconciliation is outside the bounded local native preparation
  // pass; the absolute deadline starts immediately before chunk processing.
  const preparationDeadlineAtMs = Date.now() + GALLERY_IMPORT_PREPARATION_BUDGET_MS;
  const total = checkpoint.chunks.reduce((count, chunk) => count + chunk.clusters.reduce((assetCount, cluster) => assetCount + cluster.assetTokens.length, 0), 0);
  let completed = checkpoint.uploadedAssetTokens.length;
  for (const plan of checkpoint.chunks) {
    if (plan.status === 'dispatched') continue;
    const preparedPreviews = new Map<string, Awaited<ReturnType<typeof createGalleryImportPreview>>>();
    try {
      let chunkId = plan.chunkId;
      if (!chunkId) {
        // A force-quit may leave a purely local plan. Mirror fresh-run
        // sequencing: prove each asset can produce a preview before declaring
        // it to the server, so an unavailable cloud original cannot strand an
        // immutable registered manifest.
        for (const cluster of plan.clusters) for (const assetToken of cluster.assetTokens) {
          const asset = checkpoint.assetByToken[assetToken];
          if (!asset) throw new Error('A local import checkpoint is incomplete.');
          try {
            const preview = await prepareGalleryImportAssetPreview({ adapter, osAssetId: asset.osAssetId, runId: input.runId, assetToken, preparationDeadlineAtMs });
            preparedPreviews.set(assetToken, preview);
          } catch {
            // Content-free omission is safe only before server admission.
          }
        }
        const availableClusters = plan.clusters
          .map((cluster) => ({ ...cluster, assetTokens: cluster.assetTokens.filter((assetToken) => preparedPreviews.has(assetToken)) }))
          .filter((cluster) => cluster.assetTokens.length > 0);
        if (availableClusters.length === 0) {
          const next = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) => ({
            ...current,
            chunks: current.chunks.map((chunk) => chunk.ordinal === plan.ordinal
              ? { ...chunk, status: 'dispatched', clusters: [], previewUploads: [] }
              : chunk),
          }));
          checkpoint = next ?? checkpoint;
          continue;
        }
        const clusters: GalleryImportManifestCluster[] = availableClusters.map((cluster) => ({
          clusterSignature: cluster.clusterSignature,
          assets: cluster.assetTokens.map((assetToken) => {
            const asset = checkpoint!.assetByToken[assetToken];
            if (!asset) throw new Error('A local import checkpoint is incomplete.');
            return { assetToken, captureDate: localCaptureDate(asset.captureAtMs), width: asset.width, height: asset.height, isFavorite: asset.isFavorite };
          }),
        }));
        const registered = await registerGalleryImportChunk({ familyId: input.familyId, runId: input.runId, runCapability: checkpoint.runCapability, ordinal: plan.ordinal, clusters });
        if (!registered.data || registered.error) {
          await markGalleryImportCheckpointChunkFailed(input.userId, input.familyId, input.runId, plan.ordinal);
          throw new Error(registered.error?.message ?? 'Could not restore the import chunk.');
        }
        chunkId = registered.data.chunkId;
        const requestedTokens = availableClusters.flatMap((cluster) => cluster.assetTokens);
        const accepted = admittedTokens(registered.data, requestedTokens);
        const next = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) =>
          pruneCheckpointChunk(current, plan.ordinal, accepted, chunkId!));
        checkpoint = next ?? checkpoint;
        for (const [assetToken, preview] of preparedPreviews) {
          if (accepted.has(assetToken)) continue;
          await FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined);
          preparedPreviews.delete(assetToken);
        }
        if (accepted.size === 0) {
          const terminal = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) => ({
            ...current,
            chunks: current.chunks.map((chunk) => chunk.ordinal === plan.ordinal
              ? { ...chunk, status: 'dispatched', previewUploads: [] }
              : chunk),
          }));
          checkpoint = terminal ?? checkpoint;
          continue;
        }
      }
      let didRepairPreviewReceipts = false;
      while (true) {
        const livePlan = checkpoint.chunks.find((chunk) => chunk.ordinal === plan.ordinal);
        if (!livePlan || !chunkId) break;
        for (const cluster of livePlan.clusters) for (const assetToken of cluster.assetTokens) {
          if (livePlan.previewUploads.some((upload) => upload.assetToken === assetToken)) continue;
          const asset = checkpoint.assetByToken[assetToken];
          if (!asset) throw new Error('A local import checkpoint is incomplete.');
          let preview = preparedPreviews.get(assetToken);
          if (!preview) {
            // This branch is already server-admitted. A timeout must remain a
            // retryable failure rather than silently changing its manifest.
            preview = await prepareGalleryImportAssetPreview({ adapter, osAssetId: asset.osAssetId, runId: input.runId, assetToken, preparationDeadlineAtMs });
            preparedPreviews.set(assetToken, preview);
          }
          await uploadGalleryPreviewWithRetry({ familyId: input.familyId, runId: input.runId, runCapability: checkpoint.runCapability, assetToken, preview, failureMessage: 'Could not resume a preview upload.' });
          await FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined);
          preparedPreviews.delete(assetToken);
          completed += 1;
          input.onProgress?.({ stage: 'uploading', completed, total });
          const next = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) => ({
            ...current,
            uploadedAssetTokens: current.uploadedAssetTokens.includes(assetToken) ? current.uploadedAssetTokens : [...current.uploadedAssetTokens, assetToken],
            chunks: current.chunks.map((chunk) => chunk.ordinal === livePlan.ordinal ? { ...chunk, previewUploads: [...chunk.previewUploads, { assetToken, previewWidth: preview.width, previewHeight: preview.height, byteLength: preview.byteLength, sha256: preview.sha256 }] } : chunk),
          }));
          checkpoint = next ?? checkpoint;
        }
        const ready = checkpoint.chunks.find((chunk) => chunk.ordinal === plan.ordinal);
        if (!ready?.chunkId) break;
        const dispatched = await dispatchGalleryImportChunk({ runId: input.runId, familyId: input.familyId, runCapability: checkpoint.runCapability, chunkId: ready.chunkId, previewUploads: ready.previewUploads.map((upload) => ({ ...upload, contentType: 'image/jpeg' })) });
        if (dispatched.data && !dispatched.error) {
          const next = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) => ({ ...current, chunks: current.chunks.map((chunk) => chunk.ordinal === plan.ordinal ? { ...chunk, status: 'dispatched' } : chunk) }));
          checkpoint = next ?? checkpoint;
          break;
        }
        if (dispatched.error?.code === 'preview_not_ready' && !didRepairPreviewReceipts) {
          const staleTokens = new Set(ready.previewUploads.map((upload) => upload.assetToken));
          const next = await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) => ({
            ...current,
            uploadedAssetTokens: current.uploadedAssetTokens.filter((assetToken) => !staleTokens.has(assetToken)),
            chunks: current.chunks.map((chunk) => chunk.ordinal === plan.ordinal ? { ...chunk, previewUploads: [] } : chunk),
          }));
          checkpoint = next ?? checkpoint;
          completed = checkpoint.uploadedAssetTokens.length;
          didRepairPreviewReceipts = true;
          continue;
        }
        await markGalleryImportCheckpointChunkFailed(input.userId, input.familyId, input.runId, plan.ordinal);
        throw new Error(dispatched.error?.message ?? 'Could not resume curation.');
      }
    } finally {
      await Promise.all([...preparedPreviews.values()].map((preview) =>
        FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined)));
    }
  }
  // Only reachable once every remaining plan above finished its iteration.
  // An earlier throw skips this, leaving the frontier exactly where it was
  // (progressive deepening's crash-safety requirement).
  await maybeAdvanceGalleryImportFrontier(input.userId, input.familyId, checkpoint);
}
