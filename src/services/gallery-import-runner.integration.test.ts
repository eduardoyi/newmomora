import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';

import {
  GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS,
  GALLERY_IMPORT_PREPARATION_BUDGET_MS,
  GalleryImportEmptyLibraryError,
  GalleryImportWaitingForWifiError,
  resumeGalleryImportRunner,
  startGalleryImportRunner,
} from '@/services/gallery-import-runner';
import * as galleryService from '@/services/gallery-import';
import { createGalleryImportPreview } from '@/utils/gallery-import-preview';
// Deliberately NOT mocked -- this suite exercises the real progressive-
// deepening frontier store against the globally-mocked AsyncStorage
// (jest.setup.ts), the same way it exercises the real scanner-adapter
// contract for everything else in this file.
import { galleryImportStillComingCount } from '@/utils/gallery-import-deck';
import { loadGalleryImportFrontier, saveGalleryImportFrontier } from '@/utils/gallery-import-frontier';
import { scanGallerySnapshot } from '@/utils/gallery-import-scanner';

jest.mock('@react-native-community/netinfo', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/services/media', () => ({ uploadToPresignedUrl: jest.fn().mockResolvedValue({ error: null }) }));
jest.mock('@/utils/gallery-import-e2e-adapter', () => ({ getGalleryImportE2eAdapter: jest.fn() }));
jest.mock('@/utils/gallery-import-preview', () => ({ createGalleryImportPreview: jest.fn() }));
jest.mock('@/utils/gallery-import-scanner', () => ({ createExpoGalleryMediaLibraryAdapter: jest.fn(), scanGallerySnapshot: jest.fn() }));
jest.mock('@/services/gallery-import', () => ({
  cancelGalleryImportRun: jest.fn(), createGalleryImportRun: jest.fn(), getGalleryImportRun: jest.fn(), registerGalleryImportChunk: jest.fn(), getGalleryImportUploadUrl: jest.fn(), dispatchGalleryImportChunk: jest.fn(),
}));

let mockCheckpoint: any = null;
jest.mock('@/utils/gallery-import-checkpoint', () => ({
  saveGalleryImportCheckpoint: jest.fn(async (next) => { mockCheckpoint = next; }),
  loadGalleryImportCheckpoint: jest.fn(async () => mockCheckpoint),
  clearGalleryImportCheckpoint: jest.fn(), clearGalleryImportPreviewCache: jest.fn(),
  updateGalleryImportCheckpoint: jest.fn(async (_u, _f, _r, update) => { mockCheckpoint = update(mockCheckpoint); return mockCheckpoint; }),
}));

const adapter = { isAssetAvailableLocally: jest.fn(async () => true), resolveAssetUri: jest.fn(async (id: string) => `file://${id}.jpg`) } as any;
const mockedScan = scanGallerySnapshot as jest.MockedFunction<typeof scanGallerySnapshot>;
const mockedPreview = createGalleryImportPreview as jest.MockedFunction<typeof createGalleryImportPreview>;
const mockedNetwork = NetInfo.fetch as jest.MockedFunction<typeof NetInfo.fetch>;

function snapshot() { return { permission: 'full' as const, scannedAssetCount: 3, clusters: [{ signature: 'cluster-a', algorithmVersion: 'gallery-v1' as const, assets: [{ assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, { assetToken: 'bad', osAssetId: 'bad', captureAtMs: 2, width: 10, height: 9, isFavorite: false }] }, { signature: 'cluster-b', algorithmVersion: 'gallery-v1' as const, assets: [{ assetToken: 'c', osAssetId: 'c', captureAtMs: 3, width: 10, height: 9, isFavorite: false }] }] }; }

describe('gallery import runner integration', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockCheckpoint = null; jest.clearAllMocks(); mockedScan.mockResolvedValue(snapshot() as any); mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'wifi', details: { isConnectionExpensive: false } } as any);
    adapter.isAssetAvailableLocally.mockResolvedValue(true);
    adapter.resolveAssetUri.mockImplementation(async (id: string) => `file://${id}.jpg`);
    mockedPreview.mockImplementation(async ({ assetToken }: any) => { if (assetToken === 'bad') throw new Error('unavailable'); return { uri: `file://${assetToken}-preview.jpg`, width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) }; });
    (galleryService.createGalleryImportRun as jest.Mock).mockResolvedValue({ data: { run: { id: 'run-1', limits: { maxClusters: 1, maxAssetsPerCluster: 2, maxChunks: 1 } }, runCapability: 'cap' }, error: null });
    (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-1', acceptedAssetTokens: ['a'], suppressedClusterSignatures: [] }, error: null });
    (galleryService.getGalleryImportUploadUrl as jest.Mock).mockResolvedValue({ data: { uploadUrl: 'https://upload', requiredHeaders: { 'x-amz-meta-sha256': 'a'.repeat(64) } }, error: null });
    (galleryService.dispatchGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { accepted: true }, error: null });
    (galleryService.cancelGalleryImportRun as jest.Mock).mockResolvedValue({ data: { cancelled: true }, error: null });
  });

  it('honors server caps, isolates a bad asset, and uploads only accepted tokens with signed headers', async () => {
    await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ clusters: [expect.objectContaining({ assets: [expect.objectContaining({ assetToken: 'a' })] })] }));
    expect(mockedPreview).toHaveBeenCalledTimes(2);
    expect(galleryService.getGalleryImportUploadUrl).toHaveBeenCalledWith(expect.objectContaining({ assetToken: 'a' }));
    expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalledWith(expect.objectContaining({ assetToken: 'bad' }));
    expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ previewUploads: [expect.objectContaining({ assetToken: 'a' })] }));
    expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalledWith(expect.objectContaining({ previewUploads: expect.arrayContaining([expect.objectContaining({ assetToken: 'bad' })]) }));
  });

  it('fires onRunStarted as soon as a run id exists, before any preview work', async () => {
    const onRunStarted = jest.fn();
    const seenBeforeRunStarted: unknown[] = [];
    mockedPreview.mockImplementation(async ({ assetToken }: any) => {
      seenBeforeRunStarted.push(onRunStarted.mock.calls.length);
      if (assetToken === 'bad') throw new Error('unavailable');
      return { uri: `file://${assetToken}-preview.jpg`, width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) };
    });
    await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter, onRunStarted });
    expect(onRunStarted).toHaveBeenCalledWith('run-1');
    expect(onRunStarted).toHaveBeenCalledTimes(1);
    expect(seenBeforeRunStarted.every((count) => count === 1)).toBe(true);
  });

  it('checkpoints an all-suppressed registration without dispatching stale or empty uploads', async () => {
    mockedPreview.mockResolvedValue({ uri: 'file://preview.jpg', width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) });
    (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-1', acceptedAssetTokens: [], suppressedClusterSignatures: ['cluster-a'] }, error: null });
    await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalled();
    expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
    expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'dispatched', previewUploads: [] }));
  });

  it('cancels and clears a newly-created run when every local transform fails', async () => {
    mockedPreview.mockRejectedValue(new Error('unavailable'));
    await expect(startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter })).rejects.toThrow('could not prepare any');
    expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
    expect(galleryService.cancelGalleryImportRun).toHaveBeenCalledWith({ runId: 'run-1', capability: 'cap' });
  });

  it('marks a refused chunk failed (not phantom-planned) when the server stops accepting mid-run', async () => {
    // Regression test for the device-verified race (20260811090000
    // migration): the server used to refuse a chunk the instant an earlier
    // chunk in the same run finished processing. A refused chunk must surface
    // as a real, thrown error AND leave a distinguishable checkpoint status --
    // never the 'planned' state that galleryImportStillComingCount reads as
    // still forthcoming (the device-observed "+51 coming" that never
    // resolved).
    (galleryService.createGalleryImportRun as jest.Mock).mockResolvedValue({ data: { run: { id: 'run-1', limits: { maxClusters: 2, maxAssetsPerCluster: 2, maxChunks: 2 } }, runCapability: 'cap' }, error: null });
    (galleryService.registerGalleryImportChunk as jest.Mock)
      .mockResolvedValueOnce({ data: { chunkId: 'chunk-0', acceptedAssetTokens: ['a'], suppressedClusterSignatures: [] }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'Import run is not accepting chunks' } });

    await expect(startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter }))
      .rejects.toThrow('Import run is not accepting chunks');

    expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledTimes(2);
    expect(mockCheckpoint.chunks).toEqual([
      expect.objectContaining({ ordinal: 0, status: 'dispatched' }),
      expect.objectContaining({ ordinal: 1, status: 'failed' }),
    ]);
    expect(galleryImportStillComingCount(mockCheckpoint.chunks)).toBe(0);
  });

  it('omits an asset whose native URI resolution exceeds the per-photo deadline', async () => {
    jest.useFakeTimers();
    adapter.resolveAssetUri.mockImplementation((id: string) => id === 'bad'
      ? new Promise<string>(() => undefined)
      : Promise.resolve(`file://${id}.jpg`));
    try {
      const run = startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
      await expect(run).resolves.toEqual(expect.objectContaining({ runId: 'run-1' }));
      expect(mockedPreview).toHaveBeenCalledTimes(1);
      expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({
        clusters: [expect.objectContaining({ assets: [expect.objectContaining({ assetToken: 'a' })] })],
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('omits a cloud-only asset without resolving its URI or generating a preview', async () => {
    adapter.isAssetAvailableLocally.mockImplementation(async (id: string) => id !== 'bad');

    await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

    expect(adapter.isAssetAvailableLocally).toHaveBeenCalledWith('bad');
    expect(adapter.resolveAssetUri).not.toHaveBeenCalledWith('bad');
    expect(mockedPreview).toHaveBeenCalledTimes(1);
    expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({
      clusters: [expect.objectContaining({ assets: [expect.objectContaining({ assetToken: 'a' })] })],
    }));
  });

  it('bounds a misbehaving local-availability check before URI resolution', async () => {
    jest.useFakeTimers();
    adapter.isAssetAvailableLocally.mockImplementation((id: string) => id === 'bad'
      ? new Promise<boolean>(() => undefined)
      : Promise.resolve(true));
    try {
      const run = startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
      await run;
      expect(adapter.resolveAssetUri).not.toHaveBeenCalledWith('bad');
      expect(mockedPreview).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('deletes a preview that native preparation produces after its deadline', async () => {
    jest.useFakeTimers();
    let resolveLatePreview!: (preview: { uri: string; width: number; height: number; byteLength: number; sha256: string }) => void;
    mockedPreview.mockImplementation(({ assetToken }: any) => assetToken === 'bad'
      ? new Promise((resolve) => { resolveLatePreview = resolve; })
      : Promise.resolve({ uri: `file://${assetToken}-preview.jpg`, width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) }));
    try {
      const run = startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
      await run;
      resolveLatePreview({ uri: 'file://late-preview.jpg', width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) });
      await Promise.resolve();
      await Promise.resolve();
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://late-preview.jpg', { idempotent: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a fresh pass across many hung assets and never starts the exhausted tail', async () => {
    jest.useFakeTimers();
    const assets = Array.from({ length: 12 }, (_, index) => ({ assetToken: `hung-${index}`, osAssetId: `hung-${index}`, captureAtMs: index + 1, width: 10, height: 9, isFavorite: false }));
    mockedScan.mockResolvedValue({ permission: 'full', scannedAssetCount: assets.length, clusters: assets.map((asset, index) => ({ signature: `cluster-${index}`, algorithmVersion: 'gallery-v1', assets: [asset] })) } as any);
    (galleryService.createGalleryImportRun as jest.Mock).mockResolvedValue({ data: { run: { id: 'run-1', limits: { maxClusters: 12, maxAssetsPerCluster: 1, maxChunks: 12 } }, runCapability: 'cap' }, error: null });
    adapter.resolveAssetUri.mockImplementation(() => new Promise<string>(() => undefined));
    try {
      const startedAt = Date.now();
      const run = startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      const rejection = expect(run).rejects.toThrow('could not prepare any');
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_PREPARATION_BUDGET_MS - 1);
      expect(adapter.resolveAssetUri).toHaveBeenCalledTimes(10);
      await jest.advanceTimersByTimeAsync(1);
      await rejection;
      expect(Date.now() - startedAt).toBe(GALLERY_IMPORT_PREPARATION_BUDGET_MS);
      expect(adapter.resolveAssetUri).toHaveBeenCalledTimes(10);
      expect(mockedPreview).not.toHaveBeenCalled();
      expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
      expect(galleryService.cancelGalleryImportRun).toHaveBeenCalledWith({ runId: 'run-1', capability: 'cap' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('throws a distinguishable error when the device has no dated photos to group', async () => {
    mockedScan.mockResolvedValue({ permission: 'full', scannedAssetCount: 0, clusters: [] } as any);
    await expect(startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter })).rejects.toBeInstanceOf(GalleryImportEmptyLibraryError);
    expect(galleryService.createGalleryImportRun).not.toHaveBeenCalled();
  });

  it('does not create a run on cellular unless the person explicitly allows it', async () => {
    mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: { isConnectionExpensive: false } } as any);
    await expect(startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter })).rejects.toBeInstanceOf(GalleryImportWaitingForWifiError);
    expect(galleryService.createGalleryImportRun).not.toHaveBeenCalled();
  });

  it('resumes recorded receipts without creating a second run or duplicate preview PUT', async () => {
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: ['a'], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'uploaded', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [{ assetToken: 'a', previewWidth: 512, previewHeight: 460, byteLength: 11, sha256: 'a'.repeat(64) }] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
    expect(galleryService.createGalleryImportRun).not.toHaveBeenCalled();
    expect(mockedPreview).not.toHaveBeenCalled();
    expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledTimes(1);
  });

  it('does not resume pending uploads on cellular unless explicitly allowed', async () => {
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'paused', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);
    await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).rejects.toBeInstanceOf(GalleryImportWaitingForWifiError);
    expect(mockedPreview).not.toHaveBeenCalled();
    expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalled();
  });

  it('resumes pending uploads on cellular once explicitly allowed', async () => {
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'paused', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);
    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter, allowCellular: true });
    expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledTimes(1);
  });

  it('never gates an all-dispatched resume on network state', async () => {
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: {}, uploadedAssetTokens: [], clusterSignatures: [], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'dispatched', clusters: [], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    mockedNetwork.mockResolvedValue({ isConnected: false, isInternetReachable: false, type: 'none', details: {} } as any);
    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
    expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
  });

  it('keeps registering/uploading/dispatching an unfinished chunk once the run reaches reviewing, instead of abandoning it', async () => {
    // Regression test for the device-verified streaming race (20260811090000
    // migration): a fast worker can flip the run to 'reviewing' after chunk 0
    // completes while chunks 1 and 2 of this same manifest are still
    // mid-flight. Reaching 'reviewing' must reconcile the local status label
    // only -- it must not fabricate a 'dispatched' outcome for chunks that
    // were never actually registered/uploaded/dispatched.
    const outbox = [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['a'], status: 'finalizing' }];
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, b: { assetToken: 'b', osAssetId: 'b', captureAtMs: 2, width: 10, height: 9, isFavorite: false }, c: { assetToken: 'c', osAssetId: 'c', captureAtMs: 3, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: ['a'], clusterSignatures: ['cluster-a', 'cluster-b', 'cluster-c'], chunks: [{ ordinal: 0, chunkId: 'chunk-0', status: 'dispatched', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [{ assetToken: 'a', previewWidth: 512, previewHeight: 460, byteLength: 11, sha256: 'a'.repeat(64) }] }, { ordinal: 1, status: 'planned', clusters: [{ clusterSignature: 'cluster-b', assetTokens: ['b'] }], previewUploads: [] }, { ordinal: 2, chunkId: 'chunk-2', status: 'registered', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }], previewUploads: [] }], deckTotal: 60, deckCursor: 2, approvalOutbox: outbox, updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 60 }, error: null });
    (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-1', acceptedAssetTokens: ['b'], suppressedClusterSignatures: [] }, error: null });
    const checkpointModule = jest.requireMock('@/utils/gallery-import-checkpoint') as { updateGalleryImportCheckpoint: jest.Mock; clearGalleryImportCheckpoint: jest.Mock; clearGalleryImportPreviewCache: jest.Mock };

    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

    expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 1 }));
    expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ chunkId: 'chunk-1' }));
    expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ chunkId: 'chunk-2' }));
    expect(mockCheckpoint).toEqual(expect.objectContaining({ status: 'reviewing', deckTotal: 60, deckCursor: 2, approvalOutbox: outbox }));
    expect(mockCheckpoint.chunks).toEqual([
      expect.objectContaining({ ordinal: 0, status: 'dispatched', chunkId: 'chunk-0', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }] }),
      expect.objectContaining({ ordinal: 1, status: 'dispatched', chunkId: 'chunk-1', clusters: [{ clusterSignature: 'cluster-b', assetTokens: ['b'] }] }),
      expect.objectContaining({ ordinal: 2, status: 'dispatched', chunkId: 'chunk-2', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }] }),
    ]);
    expect(galleryImportStillComingCount(mockCheckpoint.chunks)).toBe(0);

    // A second resume once every chunk is 'dispatched' is a true no-op --
    // idempotency is preserved, it just no longer comes from abandoning work.
    const registerCalls = (galleryService.registerGalleryImportChunk as jest.Mock).mock.calls.length;
    const dispatchCalls = (galleryService.dispatchGalleryImportChunk as jest.Mock).mock.calls.length;
    const updateCalls = checkpointModule.updateGalleryImportCheckpoint.mock.calls.length;
    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
    expect((galleryService.registerGalleryImportChunk as jest.Mock).mock.calls.length).toBe(registerCalls);
    expect((galleryService.dispatchGalleryImportChunk as jest.Mock).mock.calls.length).toBe(dispatchCalls);
    expect(checkpointModule.updateGalleryImportCheckpoint.mock.calls.length).toBe(updateCalls);
    expect(checkpointModule.clearGalleryImportCheckpoint).not.toHaveBeenCalled();
    expect(checkpointModule.clearGalleryImportPreviewCache).not.toHaveBeenCalled();
  });

  it('marks a refused resume registration failed (not phantom-planned) and recovers once the server accepts it again', async () => {
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'reviewing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing' }, error: null });
    (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValueOnce({ data: null, error: { message: 'Import run is not accepting chunks' } });

    await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter }))
      .rejects.toThrow('Import run is not accepting chunks');
    expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ ordinal: 0, status: 'failed' }));
    expect(galleryImportStillComingCount(mockCheckpoint.chunks)).toBe(0);

    // A parked/'failed' chunk is retried exactly like a 'planned' one on the
    // next resume -- this is the recoverable path the progress screen's
    // errorRecoverable retry relies on.
    (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValueOnce({ data: { chunkId: 'chunk-1', acceptedAssetTokens: ['a'], suppressedClusterSignatures: [] }, error: null });
    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
    expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ ordinal: 0, status: 'dispatched', chunkId: 'chunk-1' }));
  });

  it('prepares a planned mixed chunk before admission and dispatches only the available asset', async () => {
    jest.useFakeTimers();
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, bad: { assetToken: 'bad', osAssetId: 'bad', captureAtMs: 2, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a', 'bad'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    adapter.resolveAssetUri.mockImplementation((id: string) => id === 'bad' ? new Promise<string>(() => undefined) : Promise.resolve(`file://${id}.jpg`));
    try {
      const resume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
      await resume;
      expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({
        ordinal: 0,
        clusters: [expect.objectContaining({ assets: [expect.objectContaining({ assetToken: 'a' })] })],
      }));
      expect(galleryService.getGalleryImportUploadUrl).toHaveBeenCalledWith(expect.objectContaining({ assetToken: 'a' }));
      expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalledWith(expect.objectContaining({ assetToken: 'bad' }));
      expect(mockedPreview).toHaveBeenCalledTimes(1);
      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ previewUploads: [expect.objectContaining({ assetToken: 'a' })] }));
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'dispatched', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }] }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('purges a preprepared preview that registration suppresses and never uploads it', async () => {
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, c: { assetToken: 'c', osAssetId: 'c', captureAtMs: 2, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a', 'c'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });

    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

    expect(mockedPreview).toHaveBeenCalledTimes(2);
    expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalledWith(expect.objectContaining({ assetToken: 'c' }));
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://c-preview.jpg', { idempotent: true });
    expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({
      status: 'dispatched',
      clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }],
    }));
  });

  it('marks an all-unavailable planned chunk terminal and continues the remaining run', async () => {
    jest.useFakeTimers();
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { bad: { assetToken: 'bad', osAssetId: 'bad', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, c: { assetToken: 'c', osAssetId: 'c', captureAtMs: 2, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-bad', 'cluster-c'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-bad', assetTokens: ['bad'] }], previewUploads: [] }, { ordinal: 1, status: 'planned', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    adapter.resolveAssetUri.mockImplementation((id: string) => id === 'bad' ? new Promise<string>(() => undefined) : Promise.resolve(`file://${id}.jpg`));
    (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-2', acceptedAssetTokens: ['c'], suppressedClusterSignatures: [] }, error: null });
    try {
      const resume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
      await resume;
      expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledTimes(1);
      expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 1 }));
      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ chunkId: 'chunk-2', previewUploads: [expect.objectContaining({ assetToken: 'c' })] }));
      expect(mockCheckpoint.chunks).toEqual([
        expect.objectContaining({ ordinal: 0, status: 'dispatched', clusters: [] }),
        expect.objectContaining({ ordinal: 1, status: 'dispatched', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }] }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes a cloud-only unregistered resume tail immediately while local assets proceed', async () => {
    const cloudTokens = Array.from({ length: 12 }, (_, index) => `cloud-${index}`);
    const allTokens = [...cloudTokens, 'local'];
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: Object.fromEntries(allTokens.map((assetToken, index) => [assetToken, { assetToken, osAssetId: assetToken, captureAtMs: index + 1, width: 10, height: 9, isFavorite: false }])), uploadedAssetTokens: [], clusterSignatures: ['cluster-cloud', 'cluster-local'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-cloud', assetTokens: cloudTokens }], previewUploads: [] }, { ordinal: 1, status: 'planned', clusters: [{ clusterSignature: 'cluster-local', assetTokens: ['local'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    adapter.isAssetAvailableLocally.mockImplementation(async (id: string) => id === 'local');
    (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-local', acceptedAssetTokens: ['local'], suppressedClusterSignatures: [] }, error: null });

    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

    for (const cloudToken of cloudTokens) {
      expect(adapter.resolveAssetUri).not.toHaveBeenCalledWith(cloudToken);
    }
    expect(adapter.resolveAssetUri).toHaveBeenCalledWith('local');
    expect(mockedPreview).toHaveBeenCalledTimes(1);
    expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledTimes(1);
    expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 1 }));
    expect(mockCheckpoint.chunks).toEqual([
      expect.objectContaining({ ordinal: 0, status: 'dispatched', clusters: [] }),
      expect.objectContaining({ ordinal: 1, status: 'dispatched', clusters: [{ clusterSignature: 'cluster-local', assetTokens: ['local'] }] }),
    ]);
  });

  it('bounds many hung planned assets and closes the exhausted unregistered tail without starting it', async () => {
    jest.useFakeTimers();
    const hungTokens = Array.from({ length: 11 }, (_, index) => `hung-${index}`);
    const allTokens = [...hungTokens, 'tail-good'];
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: Object.fromEntries(allTokens.map((assetToken, index) => [assetToken, { assetToken, osAssetId: assetToken, captureAtMs: index + 1, width: 10, height: 9, isFavorite: false }])), uploadedAssetTokens: [], clusterSignatures: ['cluster-hung', 'cluster-tail'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-hung', assetTokens: hungTokens }], previewUploads: [] }, { ordinal: 1, status: 'planned', clusters: [{ clusterSignature: 'cluster-tail', assetTokens: ['tail-good'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    adapter.resolveAssetUri.mockImplementation((id: string) => id === 'tail-good' ? Promise.resolve('file://tail-good.jpg') : new Promise<string>(() => undefined));
    try {
      const startedAt = Date.now();
      const resume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_PREPARATION_BUDGET_MS - 1);
      expect(adapter.resolveAssetUri).toHaveBeenCalledTimes(10);
      await jest.advanceTimersByTimeAsync(1);
      await resume;
      expect(Date.now() - startedAt).toBe(GALLERY_IMPORT_PREPARATION_BUDGET_MS);
      expect(adapter.resolveAssetUri).toHaveBeenCalledTimes(10);
      expect(adapter.resolveAssetUri).not.toHaveBeenCalledWith('tail-good');
      expect(mockedPreview).not.toHaveBeenCalled();
      expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
      expect(mockCheckpoint.chunks).toEqual([
        expect.objectContaining({ ordinal: 0, status: 'dispatched', clusters: [] }),
        expect.objectContaining({ ordinal: 1, status: 'dispatched', clusters: [] }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails an immutable registered tail immediately after the invocation budget is consumed', async () => {
    jest.useFakeTimers();
    const hungTokens = Array.from({ length: 10 }, (_, index) => `hung-${index}`);
    const allTokens = [...hungTokens, 'registered'];
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: Object.fromEntries(allTokens.map((assetToken, index) => [assetToken, { assetToken, osAssetId: assetToken, captureAtMs: index + 1, width: 10, height: 9, isFavorite: false }])), uploadedAssetTokens: [], clusterSignatures: ['cluster-hung', 'cluster-registered'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-hung', assetTokens: hungTokens }], previewUploads: [] }, { ordinal: 1, chunkId: 'chunk-registered', status: 'registered', clusters: [{ clusterSignature: 'cluster-registered', assetTokens: ['registered'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    adapter.resolveAssetUri.mockImplementation(() => new Promise<string>(() => undefined));
    try {
      const resume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      const rejection = expect(resume).rejects.toThrow('preparation pass reached its time limit');
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_PREPARATION_BUDGET_MS);
      await rejection;
      expect(adapter.resolveAssetUri).toHaveBeenCalledTimes(10);
      expect(adapter.resolveAssetUri).not.toHaveBeenCalledWith('registered');
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'dispatched', clusters: [] }));
      expect(mockCheckpoint.chunks[1]).toEqual(expect.objectContaining({ status: 'registered', chunkId: 'chunk-registered' }));
      expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails a resumed admitted asset with a generic retryable error instead of hanging forever', async () => {
    jest.useFakeTimers();
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    mockedPreview.mockImplementation(() => new Promise(() => undefined));
    try {
      const resume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      const rejection = expect(resume).rejects.toThrow('A photo took too long to prepare');
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
      await rejection;
      expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
      expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'registered', chunkId: 'chunk-1' }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a cloud-only registered asset retryable without resolving or changing its receipt', async () => {
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    adapter.isAssetAvailableLocally.mockResolvedValue(false);

    await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).rejects.toThrow('not available locally');

    expect(adapter.resolveAssetUri).not.toHaveBeenCalled();
    expect(mockedPreview).not.toHaveBeenCalled();
    expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
    expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'registered', chunkId: 'chunk-1' }));
  });

  it('isolates a retry so late attempt-one cleanup cannot delete attempt-two output', async () => {
    jest.useFakeTimers();
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    let resolveFirst!: (preview: { uri: string; width: number; height: number; byteLength: number; sha256: string }) => void;
    let firstCacheKey = '';
    let secondCacheKey = '';
    mockedPreview.mockImplementation(({ localCacheKey }: any) => {
      if (!firstCacheKey) {
        firstCacheKey = localCacheKey;
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      secondCacheKey = localCacheKey;
      return Promise.resolve({ uri: `file://${localCacheKey}.jpg`, width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) });
    });
    try {
      const firstResume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      const firstRejection = expect(firstResume).rejects.toThrow('A photo took too long to prepare');
      await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
      await firstRejection;

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(firstCacheKey).not.toBe(secondCacheKey);
      expect(galleryService.getGalleryImportUploadUrl).toHaveBeenLastCalledWith(expect.objectContaining({ assetToken: 'a' }));

      resolveFirst({ uri: `file://${firstCacheKey}.jpg`, width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) });
      await Promise.resolve();
      await Promise.resolve();
      const deletedUris = (FileSystem.deleteAsync as jest.Mock).mock.calls.map(([uri]) => uri);
      expect(deletedUris.filter((uri) => uri === `file://${firstCacheKey}.jpg`)).toHaveLength(1);
      expect(deletedUris.filter((uri) => uri === `file://${secondCacheKey}.jpg`)).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('progressive-deepening frontier', () => {
    // The mock `adapter` in this suite implements no `resolveCorpus`, so
    // every scan here resolves 'full_library_fallback' (scanGallerySnapshot's
    // documented default) -- corpus-mode reset itself is exercised in its
    // own block below by seeding a frontier under a DIFFERENT stored mode.
    it('advances the persisted frontier only once every chunk has registered, from only the actually-accepted coverage', async () => {
      const result = await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      // The default fixture's server caps (maxClusters: 1) admit only
      // cluster-a, and only its 'a' token survives prep ('bad' fails) and
      // registration -- captureAtMs 1 for both bounds.
      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 1, coveredThroughNewestMs: 1, completedLibrary: false, corpusMode: 'full_library_fallback' });
      expect(result.moreHistoryToScan).toBe(true);
    });

    it('leaves an existing frontier unchanged when the run throws before every chunk registers', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback' });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'registration failed' } });

      await expect(startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter })).rejects.toThrow();

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback' });
    });

    it('passes the persisted frontier into the next scan so it can deepen instead of restarting from the top', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback' });

      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(mockedScan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        frontier: { coveredThroughNewestMs: 900, oldestCoveredMs: 500, corpusMode: 'full_library_fallback' },
      }));
    });

    it('scans unbounded (no frontier) on the very first run for this user/family', async () => {
      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(mockedScan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ frontier: null }));
    });

    it('sets completedLibrary, and moreHistoryToScan false, once a pass proves it reached the library end', async () => {
      mockedScan.mockResolvedValue({ ...snapshot(), reachedLibraryEnd: true, corpusMode: 'full_library_fallback' } as any);

      const result = await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(result.moreHistoryToScan).toBe(false);
      expect(await loadGalleryImportFrontier('u', 'f')).toEqual(expect.objectContaining({ completedLibrary: true }));
    });

    it('resume also advances the frontier once its remaining chunks finish registering', async () => {
      mockCheckpoint = {
        version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing',
        assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1_000, width: 10, height: 9, isFavorite: false } },
        uploadedAssetTokens: [], clusterSignatures: ['cluster-a'],
        chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }],
        deckCursor: 0, approvalOutbox: [], scanReachedLibraryEnd: true, scanCorpusMode: 'full_library_fallback', updatedAt: 'now',
      };
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-1', acceptedAssetTokens: ['a'], suppressedClusterSignatures: [] }, error: null });

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 1_000, completedLibrary: true, corpusMode: 'full_library_fallback' });
    });

    it('resume leaves the frontier unchanged when it throws before its remaining chunks finish registering', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback' });
      mockCheckpoint = {
        version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing',
        assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1_000, width: 10, height: 9, isFavorite: false } },
        uploadedAssetTokens: [], clusterSignatures: ['cluster-a'],
        chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }],
        deckCursor: 0, approvalOutbox: [], scanReachedLibraryEnd: true, scanCorpusMode: 'full_library_fallback', updatedAt: 'now',
      };
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'registration failed' } });

      await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).rejects.toThrow();

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback' });
    });

    it('overlap tolerance: registering a coverage range already inside an existing frontier never shrinks it', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 0, coveredThroughNewestMs: 100, completedLibrary: false, corpusMode: 'full_library_fallback' });
      // This run's only accepted asset (captureAtMs 1) falls well inside the
      // already-covered [0, 100] range -- simulating a re-registered overlap.
      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 0, coveredThroughNewestMs: 100, completedLibrary: false, corpusMode: 'full_library_fallback' });
    });

    it('resets the frontier (does not mix bounds) when this run resolves a different corpus mode than the stored frontier', async () => {
      // Simulates the Android camera album appearing between runs: the
      // stored frontier was built under 'full_library_fallback', but this
      // run's scan resolves 'camera_album' (scanGallerySnapshot is mocked in
      // this suite, so the resolved-mode wiring is exercised end-to-end via
      // its return value; the mismatch-detection logic that ignores the
      // mismatched bounds during windowing is unit-tested directly in
      // gallery-import-scanner.test.ts, since that logic lives inside the
      // real scanGallerySnapshot this suite mocks out).
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: -500_000, coveredThroughNewestMs: 500_000, completedLibrary: true, corpusMode: 'full_library_fallback' });
      mockedScan.mockResolvedValue({ ...snapshot(), corpusMode: 'camera_album' } as any);

      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      // The persisted frontier is rebuilt fresh under the new mode -- not
      // merged with (or bounded/completedLibrary-inflated by) the stale
      // full_library_fallback range.
      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 1, coveredThroughNewestMs: 1, completedLibrary: false, corpusMode: 'camera_album' });
    });
  });

  it('rebuilds one stale preview receipt set when server HEAD verification rejects it', async () => {
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: ['a'], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'uploaded', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [{ assetToken: 'a', previewWidth: 512, previewHeight: 460, byteLength: 11, sha256: 'a'.repeat(64) }] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing' }, error: null });
    (galleryService.dispatchGalleryImportChunk as jest.Mock)
      .mockResolvedValueOnce({ data: null, error: { message: 'Preview upload is incomplete.', code: 'preview_not_ready' } })
      .mockResolvedValueOnce({ data: { accepted: true }, error: null });

    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

    expect(mockedPreview).toHaveBeenCalledTimes(1);
    expect(galleryService.getGalleryImportUploadUrl).toHaveBeenCalledTimes(1);
    expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledTimes(2);
    expect(mockCheckpoint.uploadedAssetTokens).toEqual(['a']);
    expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'dispatched' }));
    expect(mockCheckpoint.chunks[0].previewUploads).toHaveLength(1);
  });
});
