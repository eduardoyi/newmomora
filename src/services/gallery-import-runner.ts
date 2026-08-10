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
    assetByToken: Object.fromEntries(input.snapshot.clusters.flatMap((cluster) => cluster.assets)
      .map((asset) => [asset.assetToken, asset])),
    uploadedAssetTokens: [],
    clusterSignatures: input.snapshot.clusters.map((cluster) => cluster.signature),
    chunks: [],
    deckTotal: 0,
    deckCursor: 0,
    approvalOutbox: [],
    updatedAt: new Date().toISOString(),
  };
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
}): Promise<{ runId: string; scannedAssetCount: number; clusterCount: number }> {
  const adapter = input.adapter ?? getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
  const snapshot = await scanGallerySnapshot(adapter, {
    onPage: ({ scannedAssetCount }) => input.onProgress?.({
      stage: 'scanning', completed: scannedAssetCount, total: scannedAssetCount, scannedAssetCount,
    }),
    yieldToEventLoop: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  if (snapshot.clusters.length === 0) {
    throw new Error('Momora could not find dated photos to group into moments. Your photo library was not changed.');
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
  if (!created.data || created.error) throw new Error(created.error?.message ?? 'Could not start the import.');
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
    if (!registered.data || registered.error) throw new Error(registered.error?.message ?? 'Could not register the import chunk.');
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
        const upload = await getGalleryImportUploadUrl({
          familyId: input.familyId,
          runId: createdRun.run.id,
          runCapability: createdRun.runCapability,
          assetToken: asset.assetToken,
          contentType: 'image/jpeg',
          previewWidth: preview.width,
          previewHeight: preview.height,
          byteLength: preview.byteLength,
          sha256: preview.sha256,
        });
        if (!upload.data || upload.error) throw new Error(upload.error?.message ?? 'Could not prepare the preview upload.');
        const uploadResult = await uploadToPresignedUrl(upload.data.uploadUrl, preview.uri, 'image/jpeg', upload.data.requiredHeaders);
        if (uploadResult.error) throw new Error(uploadResult.error.message);
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
    if (!dispatched.data || dispatched.error) throw new Error(dispatched.error?.message ?? 'Could not send the previews for curation.');
    await updateGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id, (current) => ({
      ...current,
      chunks: current.chunks.map((chunk) => chunk.ordinal === ordinal ? { ...chunk, status: 'dispatched' } : chunk),
    }));
    input.onProgress?.({ stage: 'dispatching', completed: ordinal + 1, total: Math.ceil(clusters.length / clusterChunkSize) });
  }
  if (preparedCount === 0) {
    await cancelGalleryImportRun({ runId: createdRun.run.id, capability: createdRun.runCapability }).catch(() => undefined);
    await Promise.all([
      clearGalleryImportCheckpoint(input.userId, input.familyId, createdRun.run.id),
      clearGalleryImportPreviewCache(createdRun.run.id),
    ]);
    throw new Error('Momora could not prepare any of these photos. Check that the originals are available on this device, then try again.');
  }
  return { runId: createdRun.run.id, scannedAssetCount: snapshot.scannedAssetCount, clusterCount: clusters.length };
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
}): Promise<void> {
  let checkpoint = await loadGalleryImportCheckpoint(input.userId, input.familyId, input.runId);
  if (!checkpoint) throw new Error('This import is only available on the device where it was started.');
  const remote = await getGalleryImportRun({ runId: input.runId, runCapability: checkpoint.runCapability });
  if (remote.error || !remote.data) throw new Error(remote.error?.message ?? 'Could not reconcile this import.');
  if (['cancelled', 'expired', 'completed'].includes(remote.data.status)) {
    await Promise.all([clearGalleryImportCheckpoint(input.userId, input.familyId, input.runId), clearGalleryImportPreviewCache(input.runId)]);
    return;
  }
  if (remote.data.status === 'reviewing') {
    const needsLocalReconciliation = checkpoint.status !== 'reviewing'
      || checkpoint.chunks.some((chunk) => chunk.status !== 'dispatched');
    if (needsLocalReconciliation) {
      await updateGalleryImportCheckpoint(input.userId, input.familyId, input.runId, (current) => ({
        ...current,
        status: 'reviewing',
        chunks: current.chunks.map((chunk) => {
          if (chunk.status === 'dispatched') return chunk;
          // A chunk without a server id was never admitted. Close its local
          // plan without retaining a misleading preview manifest. Registered
          // receipts stay intact for review/outbox recovery.
          return chunk.chunkId
            ? { ...chunk, status: 'dispatched' }
            : { ...chunk, status: 'dispatched', clusters: [], previewUploads: [] };
        }),
      }));
    }
    return;
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
        if (!registered.data || registered.error) throw new Error(registered.error?.message ?? 'Could not restore the import chunk.');
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
          const signed = await getGalleryImportUploadUrl({ familyId: input.familyId, runId: input.runId, runCapability: checkpoint.runCapability, assetToken, contentType: 'image/jpeg', previewWidth: preview.width, previewHeight: preview.height, byteLength: preview.byteLength, sha256: preview.sha256 });
          if (!signed.data || signed.error) throw new Error(signed.error?.message ?? 'Could not resume a preview upload.');
          const put = await uploadToPresignedUrl(signed.data.uploadUrl, preview.uri, 'image/jpeg', signed.data.requiredHeaders);
          if (put.error) throw new Error(put.error.message);
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
        throw new Error(dispatched.error?.message ?? 'Could not resume curation.');
      }
    } finally {
      await Promise.all([...preparedPreviews.values()].map((preview) =>
        FileSystem.deleteAsync(preview.uri, { idempotent: true }).catch(() => undefined)));
    }
  }
}
