import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import {
  GALLERY_IMPORT_CHECKPOINT_MAX_BYTES,
  GALLERY_IMPORT_CHECKPOINT_VERSION,
  GALLERY_IMPORT_CLUSTER_GAP_MS,
} from '@/constants/gallery-import';
import type { GalleryImportRun } from '@/services/gallery-import';
import type { GalleryCorpusMode, LocalGalleryAsset } from '@/utils/gallery-import-scanner';

const STORAGE_PREFIX = 'gallery-import-checkpoint';
const locks = new Map<string, Promise<void>>();

export interface GalleryImportCheckpointAsset extends LocalGalleryAsset {
  /** Local-only state; never include it in service request bodies. */
  previewUri?: string;
}

export interface GalleryImportApprovalOutboxItem {
  candidateId: string;
  leaseId: string;
  memoryId: string;
  assetTokens: string[];
  status: 'pending' | 'uploading' | 'finalizing' | 'failed';
  errorCode?: string;
}

export interface GalleryImportCheckpointChunk {
  ordinal: number;
  clusters: Array<{ clusterSignature: string; assetTokens: string[] }>;
  chunkId?: string;
  /** 'failed': a register/dispatch call for this chunk was refused or threw
   * and the runner gave up on this pass. Deliberately distinct from
   * 'planned' -- see gallery-import-deck.ts's galleryImportStillComingCount,
   * which reads every non-'dispatched' chunk as still forthcoming. Leaving a
   * refused chunk 'planned' made the "+N coming" counter promise progress
   * that would never arrive (device-observed: a 16-chunk run that lost
   * chunks 5+ to a server race still showed "+51 coming" indefinitely). A
   * resume attempt retries a 'failed' chunk exactly like a 'planned' one,
   * up to `GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS` (see `attempts` below), after
   * which it becomes 'abandoned'.
   * 'abandoned' (continuous model, 2026-08-23): this chunk has exhausted its
   * retry budget. Terminal locally -- never retried again, excluded from
   * every "+N coming" indicator, and counted separately by the UI as
   * "couldn't be sent". A window/frontier-advance gate treats an abandoned
   * chunk as settled (see maybeAdvanceGalleryImportFrontier's doc comment):
   * this intentionally accepts a coverage hole rather than blocking forever. */
  status: 'planned' | 'registered' | 'uploaded' | 'dispatched' | 'failed' | 'abandoned';
  /** Consecutive register/upload/dispatch failures for this chunk across
   * this run's lifetime. Absent/0 for a chunk that has never failed.
   * Resets are never needed -- once a chunk dispatches it never fails again. */
  attempts?: number;
  previewUploads: Array<{
    assetToken: string;
    previewWidth: number;
    previewHeight: number;
    byteLength: number;
    sha256: string;
  }>;
}

export interface GalleryImportCheckpoint {
  version: typeof GALLERY_IMPORT_CHECKPOINT_VERSION;
  userId: string;
  familyId: string;
  runId: string;
  runCapability: string;
  algorithmVersion: string;
  status: 'scanning' | 'processing' | 'reviewing' | 'paused';
  /** Snapshotted at run creation (see gallery-import-runner.ts's toCheckpoint).
   * Optional -- absent on checkpoints saved before this field existed. */
  permissionMode?: 'full' | 'limited';
  assetByToken: Record<string, GalleryImportCheckpointAsset>;
  uploadedAssetTokens: string[];
  clusterSignatures: string[];
  chunks: GalleryImportCheckpointChunk[];
  /** Stable unique-card denominator for review progress. */
  deckTotal?: number;
  deckCursor: number;
  approvalOutbox: GalleryImportApprovalOutboxItem[];
  /**
   * Progressive deepening (gallery-import-frontier.ts): whether this run's
   * scan reached the true bottom of the photo library without being cut off
   * by the enumeration budget (GalleryScanSnapshot.reachedLibraryEnd,
   * captured once at scan time). Read back once every chunk below has left
   * 'planned' status, to decide whether the persisted frontier's
   * completedLibrary flag should flip true. Purely additive and optional --
   * this is why GALLERY_IMPORT_CHECKPOINT_VERSION did NOT need to bump for
   * it: `isCheckpoint` below only requires the pre-existing fields, so an
   * older in-flight checkpoint that lacks this key still loads and resumes
   * normally, it just does not contribute to frontier bookkeeping (safe --
   * the frontier simply stays wherever it already was for that run).
   */
  scanReachedLibraryEnd?: boolean;
  /**
   * Progressive deepening: the asset universe (GalleryCorpusMode) this run's
   * scan actually drew from, captured once at scan time. Read back
   * alongside `scanReachedLibraryEnd` once every chunk below has settled,
   * so the frontier merge can detect a corpus-mode change (the Android
   * camera album appearing/disappearing) and reset instead of mixing
   * coverage across corpora -- see gallery-import-frontier.ts. Same
   * additive/optional reasoning as `scanReachedLibraryEnd`: no checkpoint
   * version bump needed.
   */
  scanCorpusMode?: GalleryCorpusMode;
  /** Continuous model (S8): set when `register_gallery_import_chunk`/
   * `registerGalleryImportChunk` refuses a chunk with `{ code: 'fair_use' }`
   * (S2) -- an ISO timestamp for when the family's rolling daily cluster
   * limit frees up. The driver (gallery-import-driver.ts) reads this to show
   * `paused_fair_use` instead of treating the pause as an error, and clears
   * it once a later pass succeeds. Optional/additive -- absent means no
   * fair-use pause is active. */
  pausedUntil?: string;
  /** Continuous model (S8): persists the progress screen's cellular-confirm
   * choice onto the checkpoint itself (previously only threaded through a
   * per-call `resumeGalleryImportRunner({ allowCellular })` argument that a
   * background driver kick would not know about). The driver ORs this with
   * any explicit per-kick `allowCellular` opt from `kickGalleryImportDriver`. */
  allowCellular?: boolean;
  updatedAt: string;
}

function storageKey(userId: string, familyId: string, runId: string): string {
  return `${STORAGE_PREFIX}:v${GALLERY_IMPORT_CHECKPOINT_VERSION}:${userId}:${familyId}:${runId}`;
}

export function getGalleryImportCheckpointKey(userId: string, familyId: string, runId: string): string {
  return storageKey(userId, familyId, runId);
}

function isCheckpoint(value: unknown): value is GalleryImportCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<GalleryImportCheckpoint>;
  return checkpoint.version === GALLERY_IMPORT_CHECKPOINT_VERSION
    && typeof checkpoint.userId === 'string'
    && typeof checkpoint.familyId === 'string'
    && typeof checkpoint.runId === 'string'
    && typeof checkpoint.runCapability === 'string'
    && typeof checkpoint.algorithmVersion === 'string'
    && typeof checkpoint.assetByToken === 'object'
    && Array.isArray(checkpoint.uploadedAssetTokens)
    && Array.isArray(checkpoint.clusterSignatures)
    && Array.isArray(checkpoint.chunks)
    && typeof checkpoint.deckCursor === 'number'
    && Array.isArray(checkpoint.approvalOutbox);
}

function validateScope(checkpoint: GalleryImportCheckpoint, userId: string, familyId: string, runId: string): boolean {
  return checkpoint.userId === userId && checkpoint.familyId === familyId && checkpoint.runId === runId;
}

async function withStorageLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export async function loadGalleryImportCheckpoint(
  userId: string,
  familyId: string,
  runId: string,
): Promise<GalleryImportCheckpoint | null> {
  const key = storageKey(userId, familyId, runId);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isCheckpoint(parsed) || !validateScope(parsed, userId, familyId, runId)) {
      await AsyncStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    // A malformed local checkpoint must never block capture or leak into the
    // next account; replace it only after a fresh run starts.
    try { await AsyncStorage.removeItem(key); } catch { /* best effort */ }
    return null;
  }
}

export async function saveGalleryImportCheckpoint(checkpoint: GalleryImportCheckpoint): Promise<void> {
  const key = storageKey(checkpoint.userId, checkpoint.familyId, checkpoint.runId);
  await withStorageLock(key, async () => {
    const next: GalleryImportCheckpoint = { ...checkpoint, updatedAt: new Date().toISOString() };
    const serialized = JSON.stringify(next);
    if (serialized.length > GALLERY_IMPORT_CHECKPOINT_MAX_BYTES) {
      throw new Error('This gallery import has too much local resume data. Start a new import instead.');
    }
    await AsyncStorage.setItem(key, serialized);
  });
}

export async function updateGalleryImportCheckpoint(
  userId: string,
  familyId: string,
  runId: string,
  update: (checkpoint: GalleryImportCheckpoint) => GalleryImportCheckpoint,
): Promise<GalleryImportCheckpoint | null> {
  const key = storageKey(userId, familyId, runId);
  return withStorageLock(key, async () => {
    const current = await loadGalleryImportCheckpoint(userId, familyId, runId);
    if (!current) return null;
    const next = update(current);
    const serialized = JSON.stringify({ ...next, updatedAt: new Date().toISOString() });
    if (serialized.length > GALLERY_IMPORT_CHECKPOINT_MAX_BYTES) {
      throw new Error('This gallery import has too much local resume data. Start a new import instead.');
    }
    await AsyncStorage.setItem(key, serialized);
    return JSON.parse(serialized) as GalleryImportCheckpoint;
  });
}

export async function clearGalleryImportCheckpoint(
  userId: string,
  familyId: string,
  runId: string,
): Promise<void> {
  try {
    await AsyncStorage.removeItem(storageKey(userId, familyId, runId));
  } catch {
    // A server terminal status remains authoritative; local cleanup retries at
    // cold start and must not turn cancellation into an error loop.
  }
}

export async function clearGalleryImportCheckpointsForScope(
  userId: string,
  familyId?: string,
): Promise<void> {
  try {
    const prefix = familyId
      ? `${STORAGE_PREFIX}:v${GALLERY_IMPORT_CHECKPOINT_VERSION}:${userId}:${familyId}:`
      : `${STORAGE_PREFIX}:v${GALLERY_IMPORT_CHECKPOINT_VERSION}:${userId}:`;
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
    if (keys.length > 0) await AsyncStorage.multiRemove(keys);
  } catch {
    // Best effort. No other user's key shares this exact scoped prefix.
  }
}

/** Finds only this signed-in user's newest local run; there is no family-wide remote lookup. */
export async function loadLatestGalleryImportCheckpoint(
  userId: string,
  familyId: string,
): Promise<GalleryImportCheckpoint | null> {
  try {
    const prefix = `${STORAGE_PREFIX}:v${GALLERY_IMPORT_CHECKPOINT_VERSION}:${userId}:${familyId}:`;
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
    const checkpoints = await Promise.all(keys.map(async (key) => {
      const runId = key.slice(prefix.length);
      return loadGalleryImportCheckpoint(userId, familyId, runId);
    }));
    return checkpoints.filter((checkpoint): checkpoint is GalleryImportCheckpoint => Boolean(checkpoint))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  } catch {
    return null;
  }
}

const TERMINAL_SERVER_CHUNK_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'expired']);

/**
 * Bounds a long-lived continuous run's checkpoint (docs/plans/gallery-import-continuous.md
 * Internal model's "checkpoint growth is bounded"). Called from
 * `maybeExtendGalleryImportPlan` (gallery-import-runner.ts) with the freshly
 * polled server `run` right before saving a newly-extended checkpoint.
 * Deliberately conservative -- it only ever removes an `assetByToken` entry
 * once ALL of the following hold, so a wrong guess degrades to "checkpoint
 * grows a bit more than strictly necessary", never to a broken resume:
 *
 * - Its local chunk is not itself unsettled (still 'planned'/'registered'/
 *   'uploaded'/'failed' -- active work always keeps its asset metadata).
 * - It is not referenced by any in-flight `approvalOutbox` item.
 * - It is not within `GALLERY_IMPORT_CLUSTER_GAP_MS` of any currently live
 *   (`staged`/`skipped`) candidate's own selected capture time -- the day-pool
 *   photo chooser (`buildGalleryImportDayPool`) reconstructs a candidate's
 *   full day-cluster from `assetByToken` using that same gap, so a token
 *   just outside a live candidate's own selection must still survive.
 * - Its own chunk (matched by ordinal) is reported terminal by the server.
 *
 * `clusterSignatures` is pruned separately and more simply: it has no
 * production reader today (write-only bookkeeping -- see the field's own
 * comment), so bounding its growth only needs to drop signatures whose chunk
 * has safely reached the server (`dispatched`).
 */
export function pruneGalleryImportCheckpoint(
  checkpoint: GalleryImportCheckpoint,
  run: Pick<GalleryImportRun, 'chunks' | 'liveCandidateAssetTokens'> | null | undefined,
): GalleryImportCheckpoint {
  if (!run) return checkpoint;
  const serverStatusByOrdinal = new Map((run.chunks ?? []).map((chunk) => [chunk.ordinal, chunk.status]));
  const isChunkServerTerminal = (ordinal: number): boolean => {
    const status = serverStatusByOrdinal.get(ordinal);
    return status !== undefined && TERMINAL_SERVER_CHUNK_STATUSES.has(status);
  };

  const activeTokens = new Set<string>();
  for (const chunk of checkpoint.chunks) {
    if (isChunkServerTerminal(chunk.ordinal)) continue;
    for (const cluster of chunk.clusters) for (const token of cluster.assetTokens) activeTokens.add(token);
  }

  const outboxTokens = new Set(checkpoint.approvalOutbox.flatMap((item) => item.assetTokens));

  const liveCandidateTokens = run.liveCandidateAssetTokens ?? [];
  const liveCandidateTokenSet = new Set(liveCandidateTokens);
  const liveCaptureTimes = liveCandidateTokens
    .map((token) => checkpoint.assetByToken[token]?.captureAtMs)
    .filter((value): value is number => typeof value === 'number');

  function isNearLiveCandidate(captureAtMs: number): boolean {
    return liveCaptureTimes.some((anchor) => Math.abs(anchor - captureAtMs) <= GALLERY_IMPORT_CLUSTER_GAP_MS);
  }

  const assetByToken = Object.fromEntries(
    Object.entries(checkpoint.assetByToken).filter(([token, asset]) =>
      activeTokens.has(token)
      || outboxTokens.has(token)
      || liveCandidateTokenSet.has(token)
      || isNearLiveCandidate(asset.captureAtMs)),
  );

  const dispatchedSignatures = new Set(
    checkpoint.chunks
      .filter((chunk) => chunk.status === 'dispatched')
      .flatMap((chunk) => chunk.clusters.map((cluster) => cluster.clusterSignature)),
  );
  const clusterSignatures = checkpoint.clusterSignatures.filter((signature) => !dispatchedSignatures.has(signature));

  return { ...checkpoint, assetByToken, clusterSignatures };
}

export function getGalleryImportPreviewCacheDirectory(runId: string): string | null {
  if (!FileSystem.cacheDirectory || !/^[a-zA-Z0-9-]{1,128}$/.test(runId)) return null;
  return `${FileSystem.cacheDirectory}gallery-import/${runId}/`;
}

export async function clearGalleryImportPreviewCache(runId: string): Promise<void> {
  const directory = getGalleryImportPreviewCacheDirectory(runId);
  if (!directory) return;
  try {
    await FileSystem.deleteAsync(directory, { idempotent: true });
  } catch {
    // Local cache cleanup is retried on the next cold-start reconciliation.
  }
}
