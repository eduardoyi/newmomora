import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import {
  GALLERY_IMPORT_CHECKPOINT_MAX_BYTES,
  GALLERY_IMPORT_CHECKPOINT_VERSION,
} from '@/constants/gallery-import';
import type { LocalGalleryAsset } from '@/utils/gallery-import-scanner';

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
  status: 'planned' | 'registered' | 'uploaded' | 'dispatched';
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
  assetByToken: Record<string, GalleryImportCheckpointAsset>;
  uploadedAssetTokens: string[];
  clusterSignatures: string[];
  chunks: GalleryImportCheckpointChunk[];
  /** Stable unique-card denominator for review progress. */
  deckTotal?: number;
  deckCursor: number;
  approvalOutbox: GalleryImportApprovalOutboxItem[];
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
