import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';

import {
  GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS,
  GALLERY_IMPORT_PREPARATION_BUDGET_MS,
  GalleryImportWaitingForWifiError,
  resumeGalleryImportRunner,
  startGalleryImportRunner,
} from '@/services/gallery-import-runner';
import * as galleryService from '@/services/gallery-import';
import { createGalleryImportPreview } from '@/utils/gallery-import-preview';
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
  beforeEach(() => {
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

  it('reconciles a reviewing server run locally without touching media or admission again', async () => {
    const outbox = [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['a'], status: 'finalizing' }];
    mockCheckpoint = { version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'processing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, b: { assetToken: 'b', osAssetId: 'b', captureAtMs: 2, width: 10, height: 9, isFavorite: false }, c: { assetToken: 'c', osAssetId: 'c', captureAtMs: 3, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: ['a'], clusterSignatures: ['cluster-a', 'cluster-b', 'cluster-c'], chunks: [{ ordinal: 0, chunkId: 'chunk-0', status: 'dispatched', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [{ assetToken: 'a', previewWidth: 512, previewHeight: 460, byteLength: 11, sha256: 'a'.repeat(64) }] }, { ordinal: 1, status: 'planned', clusters: [{ clusterSignature: 'cluster-b', assetTokens: ['b'] }], previewUploads: [] }, { ordinal: 2, chunkId: 'chunk-2', status: 'registered', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }], previewUploads: [] }], deckTotal: 60, deckCursor: 2, approvalOutbox: outbox, updatedAt: 'now' };
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 60 }, error: null });
    const checkpointModule = jest.requireMock('@/utils/gallery-import-checkpoint') as { updateGalleryImportCheckpoint: jest.Mock; clearGalleryImportCheckpoint: jest.Mock; clearGalleryImportPreviewCache: jest.Mock };
    const mediaModule = jest.requireMock('@/services/media') as { uploadToPresignedUrl: jest.Mock };
    const scannerModule = jest.requireMock('@/utils/gallery-import-scanner') as { createExpoGalleryMediaLibraryAdapter: jest.Mock };

    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
    const reconciled = JSON.parse(JSON.stringify(mockCheckpoint));
    await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

    expect(checkpointModule.updateGalleryImportCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockCheckpoint).toEqual(reconciled);
    expect(mockCheckpoint).toEqual(expect.objectContaining({ status: 'reviewing', deckTotal: 60, deckCursor: 2, approvalOutbox: outbox }));
    expect(mockCheckpoint.chunks).toEqual([
      expect.objectContaining({ ordinal: 0, status: 'dispatched', chunkId: 'chunk-0', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }] }),
      expect.objectContaining({ ordinal: 1, status: 'dispatched', clusters: [], previewUploads: [] }),
      expect.objectContaining({ ordinal: 2, status: 'dispatched', chunkId: 'chunk-2', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }] }),
    ]);
    expect(adapter.isAssetAvailableLocally).not.toHaveBeenCalled();
    expect(adapter.resolveAssetUri).not.toHaveBeenCalled();
    expect(mockedPreview).not.toHaveBeenCalled();
    expect(scannerModule.createExpoGalleryMediaLibraryAdapter).not.toHaveBeenCalled();
    expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
    expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalled();
    expect(mediaModule.uploadToPresignedUrl).not.toHaveBeenCalled();
    expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(checkpointModule.clearGalleryImportCheckpoint).not.toHaveBeenCalled();
    expect(checkpointModule.clearGalleryImportPreviewCache).not.toHaveBeenCalled();
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
