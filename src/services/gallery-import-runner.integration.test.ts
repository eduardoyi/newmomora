import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';

import {
  GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS,
  GALLERY_IMPORT_PREPARATION_BUDGET_MS,
  GalleryImportEmptyLibraryError,
  GalleryImportFairUsePausedError,
  GalleryImportWaitingForWifiError,
  maybeExtendGalleryImportPlan,
  processGalleryImportChunks,
  resumeGalleryImportRunner,
  startGalleryImportRunner,
} from '@/services/gallery-import-runner';
import * as galleryService from '@/services/gallery-import';
import { GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS } from '@/constants/gallery-import';
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
jest.mock('@/utils/gallery-import-checkpoint', () => {
  // `pruneGalleryImportCheckpoint` is a pure function with no I/O -- keep the
  // real implementation and only mock the storage-touching exports, so
  // `maybeExtendGalleryImportPlan` (which calls it) doesn't need its own mock.
  const actual = jest.requireActual('@/utils/gallery-import-checkpoint');
  return {
    ...actual,
    saveGalleryImportCheckpoint: jest.fn(async (next: any) => { mockCheckpoint = next; }),
    loadGalleryImportCheckpoint: jest.fn(async () => mockCheckpoint),
    clearGalleryImportCheckpoint: jest.fn(), clearGalleryImportPreviewCache: jest.fn(),
    updateGalleryImportCheckpoint: jest.fn(async (_u: any, _f: any, _r: any, update: any) => {
      if (!mockCheckpoint) return null;
      mockCheckpoint = update(mockCheckpoint);
      return mockCheckpoint;
    }),
  };
});

const adapter = { isAssetAvailableLocally: jest.fn(async () => true), resolveAssetUri: jest.fn(async (id: string) => `file://${id}.jpg`) } as any;
const mockedScan = scanGallerySnapshot as jest.MockedFunction<typeof scanGallerySnapshot>;
const mockedPreview = createGalleryImportPreview as jest.MockedFunction<typeof createGalleryImportPreview>;
const mockedNetwork = NetInfo.fetch as jest.MockedFunction<typeof NetInfo.fetch>;

function snapshot() { return { permission: 'full' as const, scannedAssetCount: 3, clusters: [{ signature: 'cluster-a', algorithmVersion: 'gallery-v1' as const, assets: [{ assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, { assetToken: 'bad', osAssetId: 'bad', captureAtMs: 2, width: 10, height: 9, isFavorite: false }] }, { signature: 'cluster-b', algorithmVersion: 'gallery-v1' as const, assets: [{ assetToken: 'c', osAssetId: 'c', captureAtMs: 3, width: 10, height: 9, isFavorite: false }] }], rejectedAssetCount: 0, wasTruncated: false, reachedLibraryEnd: false, corpusMode: 'full_library_fallback' as const }; }

const EMPTY_SNAPSHOT = { permission: 'full' as const, scannedAssetCount: 0, clusters: [], rejectedAssetCount: 0, wasTruncated: false, reachedLibraryEnd: true, corpusMode: 'full_library_fallback' as const };

function checkpointFixture(overrides: Record<string, unknown> = {}): any {
  return {
    version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1',
    status: 'processing', assetByToken: {}, uploadedAssetTokens: [], clusterSignatures: [], chunks: [],
    deckCursor: 0, approvalOutbox: [], updatedAt: 'now', ...overrides,
  };
}

describe('gallery import runner integration', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockCheckpoint = null;
    jest.clearAllMocks();
    // Default: empty for every call. Every test that exercises a fresh
    // `startGalleryImportRunner` scan arranges its own
    // `mockedScan.mockResolvedValueOnce(snapshot())` explicitly -- this
    // keeps an unintended extension attempt inside a `resumeGalleryImportRunner`
    // test (which also calls scanGallerySnapshot once all chunks settle) a
    // guaranteed no-op unless a test is specifically about extension.
    mockedScan.mockResolvedValue(EMPTY_SNAPSHOT as any);
    mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'wifi', details: { isConnectionExpensive: false } } as any);
    adapter.isAssetAvailableLocally.mockResolvedValue(true);
    adapter.resolveAssetUri.mockImplementation(async (id: string) => `file://${id}.jpg`);
    mockedPreview.mockImplementation(async ({ assetToken }: any) => { if (assetToken === 'bad') throw new Error('unavailable'); return { uri: `file://${assetToken}-preview.jpg`, width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) }; });
    (galleryService.createGalleryImportRun as jest.Mock).mockResolvedValue({ data: { run: { id: 'run-1', limits: { maxClusters: 1, maxAssetsPerCluster: 2, maxChunks: 1 } }, runCapability: 'cap' }, error: null });
    (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-1', acceptedAssetTokens: ['a'], suppressedClusterSignatures: [] }, error: null });
    (galleryService.getGalleryImportUploadUrl as jest.Mock).mockResolvedValue({ data: { uploadUrl: 'https://upload', requiredHeaders: { 'x-amz-meta-sha256': 'a'.repeat(64) } }, error: null });
    (galleryService.dispatchGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { accepted: true }, error: null });
    (galleryService.cancelGalleryImportRun as jest.Mock).mockResolvedValue({ data: { cancelled: true }, error: null });
    // Default reconciliation response for resume-focused tests: non-terminal,
    // and a backlog far above GALLERY_IMPORT_TARGET_BACKLOG so an unintended
    // `maybeExtendGalleryImportPlan` attempt declines on the backlog gate as
    // a second line of defense (the empty-scan default above is the first).
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing', pendingClusters: 999, readyCandidates: 0 }, error: null });
  });

  describe('startGalleryImportRunner', () => {
    it('honors server caps, isolates a bad asset, and uploads only accepted tokens with signed headers', async () => {
      mockedScan.mockResolvedValueOnce(snapshot() as any);
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
      mockedScan.mockResolvedValueOnce(snapshot() as any);
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

    it('marks a chunk dispatched (legitimately resolved server-side, not abandoned) when its registration is fully suppressed', async () => {
      // Fix: a chunk the server fully suppressed at registration (every
      // cluster already covered by a receipt) is resolved, not a device-
      // local failure -- it must not spend an attempt or read as abandoned.
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      mockedPreview.mockResolvedValue({ uri: 'file://preview.jpg', width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-1', acceptedAssetTokens: [], suppressedClusterSignatures: ['cluster-a'] }, error: null });
      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalled();
      expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'dispatched', previewUploads: [] }));
      expect(galleryImportStillComingCount(mockCheckpoint.chunks)).toBe(0);
    });

    it('abandons a chunk immediately (without ever registering) when every asset fails to prepare -- and does not throw', async () => {
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      mockedPreview.mockRejectedValue(new Error('unavailable'));
      const result = await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      expect(result.runId).toBe('run-1');
      expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
      expect(galleryService.cancelGalleryImportRun).not.toHaveBeenCalled();
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'abandoned' }));
    });

    it('marks a refused chunk failed (retryable), not abandoned on the very first attempt', async () => {
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      // Regression guard for the audited "+51 coming" phantom-progress bug:
      // a refused chunk must surface as a distinguishable, retryable
      // 'failed' status (never 'planned'), without throwing the whole call.
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'Import run is not accepting chunks', code: 'not_available' } });
      const result = await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      expect(result.runId).toBe('run-1');
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'failed', attempts: 1 }));
      expect(galleryImportStillComingCount(mockCheckpoint.chunks)).toBe(0);
    });

    it('throws GalleryImportFairUsePausedError and persists pausedUntil when the very first chunk hits the daily limit', async () => {
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { code: 'fair_use', message: 'Gallery import daily limit reached', retryAfterSeconds: 3600 } });
      await expect(startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter })).rejects.toBeInstanceOf(GalleryImportFairUsePausedError);
      expect(typeof mockCheckpoint.pausedUntil).toBe('string');
      // Left 'planned' -- unaffected by attempts, retried whole once the window frees.
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'planned' }));
    });

    it('omits an asset whose native URI resolution exceeds the per-photo deadline', async () => {
      jest.useFakeTimers();
      mockedScan.mockResolvedValueOnce(snapshot() as any);
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
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      adapter.isAssetAvailableLocally.mockImplementation(async (id: string) => id !== 'bad');
      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      expect(adapter.isAssetAvailableLocally).toHaveBeenCalledWith('bad');
      expect(adapter.resolveAssetUri).not.toHaveBeenCalledWith('bad');
      expect(mockedPreview).toHaveBeenCalledTimes(1);
    });

    it('deletes a preview that native preparation produces after its deadline', async () => {
      jest.useFakeTimers();
      mockedScan.mockResolvedValueOnce(snapshot() as any);
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

    it('pauses (never drops) a fresh pass across many hung assets: the exhausted tail stays planned, not abandoned', async () => {
      jest.useFakeTimers();
      const assets = Array.from({ length: 12 }, (_, index) => ({ assetToken: `hung-${index}`, osAssetId: `hung-${index}`, captureAtMs: index + 1, width: 10, height: 9, isFavorite: false }));
      mockedScan.mockReset();
      mockedScan.mockResolvedValueOnce({ permission: 'full', scannedAssetCount: assets.length, clusters: assets.map((asset, index) => ({ signature: `cluster-${index}`, algorithmVersion: 'gallery-v1', assets: [asset] })), rejectedAssetCount: 0, wasTruncated: false, reachedLibraryEnd: false, corpusMode: 'full_library_fallback' } as any);
      (galleryService.createGalleryImportRun as jest.Mock).mockResolvedValue({ data: { run: { id: 'run-1', limits: { maxClusters: 12, maxAssetsPerCluster: 1, maxChunks: 12 } }, runCapability: 'cap' }, error: null });
      adapter.resolveAssetUri.mockImplementation(() => new Promise<string>(() => undefined));
      try {
        const startedAt = Date.now();
        const run = startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
        await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_PREPARATION_BUDGET_MS);
        const result = await run;
        expect(result.runId).toBe('run-1');
        expect(Date.now() - startedAt).toBe(GALLERY_IMPORT_PREPARATION_BUDGET_MS);
        expect(adapter.resolveAssetUri).toHaveBeenCalledTimes(10);
        expect(mockedPreview).not.toHaveBeenCalled();
        expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
        expect(galleryService.cancelGalleryImportRun).not.toHaveBeenCalled();
        // Chunks 0 and 1 (4 assets each) each got a full, individually-timed-
        // out attempt at every one of their assets within budget -- with
        // nothing preparable, they abandon pre-admission (never silently
        // fabricated as 'dispatched'). Chunk 2 was interrupted mid-attempt by
        // the pass deadline itself (not a per-asset timeout) and is left
        // 'planned' -- budget pauses that one, it does not drop it.
        expect(mockCheckpoint.chunks[0].status).toBe('abandoned');
        expect(mockCheckpoint.chunks[1].status).toBe('abandoned');
        expect(mockCheckpoint.chunks[2].status).toBe('planned');
      } finally {
        jest.useRealTimers();
      }
    });

    it('throws a distinguishable error when the device has no dated photos to group', async () => {
      mockedScan.mockReset();
      mockedScan.mockResolvedValueOnce({ permission: 'full', scannedAssetCount: 0, clusters: [], rejectedAssetCount: 0, wasTruncated: false, reachedLibraryEnd: true, corpusMode: 'full_library_fallback' } as any);
      await expect(startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter })).rejects.toBeInstanceOf(GalleryImportEmptyLibraryError);
      expect(galleryService.createGalleryImportRun).not.toHaveBeenCalled();
    });

    it('does not create a run on cellular unless the person explicitly allows it', async () => {
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: { isConnectionExpensive: false } } as any);
      await expect(startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter })).rejects.toBeInstanceOf(GalleryImportWaitingForWifiError);
      expect(galleryService.createGalleryImportRun).not.toHaveBeenCalled();
    });
  });

  describe('resumeGalleryImportRunner', () => {
    it('resumes recorded receipts without creating a second run or duplicate preview PUT', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: ['a'], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'uploaded', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [{ assetToken: 'a', previewWidth: 512, previewHeight: 460, byteLength: 11, sha256: 'a'.repeat(64) }] }] });
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(galleryService.createGalleryImportRun).not.toHaveBeenCalled();
      expect(mockedPreview).not.toHaveBeenCalled();
      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledTimes(1);
    });

    it('does not resume pending uploads on cellular unless explicitly allowed', async () => {
      mockCheckpoint = checkpointFixture({ status: 'paused', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);
      await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).rejects.toBeInstanceOf(GalleryImportWaitingForWifiError);
      expect(mockedPreview).not.toHaveBeenCalled();
      expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalled();
    });

    it('resumes pending uploads on cellular once explicitly allowed via the call argument', async () => {
      mockCheckpoint = checkpointFixture({ status: 'paused', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter, allowCellular: true });
      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledTimes(1);
    });

    it('resumes pending uploads on cellular once persisted on the checkpoint itself (S8 allowCellular)', async () => {
      mockCheckpoint = checkpointFixture({ status: 'paused', allowCellular: true, assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledTimes(1);
    });

    it('never gates an all-settled (dispatched/abandoned) resume on network state', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'dispatched', clusters: [], previewUploads: [] }, { ordinal: 1, status: 'abandoned', attempts: 3, clusters: [], previewUploads: [] }] });
      mockedNetwork.mockResolvedValue({ isConnected: false, isInternetReachable: false, type: 'none', details: {} } as any);
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
    });

    it('re-checks the Wi-Fi gate after an extension adds a new window (never uploads it over cellular unless allowed)', async () => {
      // Fix: hasPendingUploadWork is only evaluated once, before the loop --
      // when every existing chunk is already settled (no gate needed yet),
      // maybeExtendGalleryImportPlan can still append a brand new window
      // that DOES need Wi-Fi. Without a re-check, that window would be
      // processed straight over cellular.
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0, pendingClusters: 0, chunks: [], liveCandidateAssetTokens: [] }, error: null });
      mockedScan.mockReset();
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);

      await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).rejects.toBeInstanceOf(GalleryImportWaitingForWifiError);

      expect(mockCheckpoint.chunks).toHaveLength(2);
      expect(mockCheckpoint.chunks[1].status).toBe('planned');
      expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
    });

    it('allows a freshly-extended window to proceed over cellular once explicitly allowed', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0, pendingClusters: 0, chunks: [], liveCandidateAssetTokens: [] }, error: null });
      mockedScan.mockReset();
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      mockedScan.mockResolvedValue(EMPTY_SNAPSHOT as any);
      mockedNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter, allowCellular: true });

      expect(mockCheckpoint.chunks).toHaveLength(2);
      expect(mockCheckpoint.chunks[1].status).toBe('dispatched');
    });

    it('keeps registering/uploading/dispatching an unfinished chunk once the run reaches reviewing, instead of abandoning it', async () => {
      // Regression test for the device-verified streaming race: a fast worker
      // can flip the run to 'reviewing' after chunk 0 completes while chunks
      // 1 and 2 of this same manifest are still mid-flight. Reaching
      // 'reviewing' must reconcile the local status label only.
      const outbox = [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['a'], status: 'finalizing' }];
      mockCheckpoint = checkpointFixture({
        assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, b: { assetToken: 'b', osAssetId: 'b', captureAtMs: 2, width: 10, height: 9, isFavorite: false }, c: { assetToken: 'c', osAssetId: 'c', captureAtMs: 3, width: 10, height: 9, isFavorite: false } },
        uploadedAssetTokens: ['a'], clusterSignatures: ['cluster-a', 'cluster-b', 'cluster-c'],
        chunks: [{ ordinal: 0, chunkId: 'chunk-0', status: 'dispatched', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [{ assetToken: 'a', previewWidth: 512, previewHeight: 460, byteLength: 11, sha256: 'a'.repeat(64) }] }, { ordinal: 1, status: 'planned', clusters: [{ clusterSignature: 'cluster-b', assetTokens: ['b'] }], previewUploads: [] }, { ordinal: 2, chunkId: 'chunk-2', status: 'registered', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }], previewUploads: [] }],
        deckTotal: 60, deckCursor: 2, approvalOutbox: outbox,
      });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 60, pendingClusters: 999 }, error: null });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-1', acceptedAssetTokens: ['b'], suppressedClusterSignatures: [] }, error: null });
      const checkpointModule = jest.requireMock('@/utils/gallery-import-checkpoint') as { updateGalleryImportCheckpoint: jest.Mock; clearGalleryImportCheckpoint: jest.Mock; clearGalleryImportPreviewCache: jest.Mock };

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 1 }));
      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ chunkId: 'chunk-1' }));
      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ chunkId: 'chunk-2' }));
      expect(mockCheckpoint).toEqual(expect.objectContaining({ status: 'reviewing', deckTotal: 60, deckCursor: 2, approvalOutbox: outbox }));
      expect(mockCheckpoint.chunks).toEqual([
        expect.objectContaining({ ordinal: 0, status: 'dispatched', chunkId: 'chunk-0' }),
        expect.objectContaining({ ordinal: 1, status: 'dispatched', chunkId: 'chunk-1' }),
        expect.objectContaining({ ordinal: 2, status: 'dispatched', chunkId: 'chunk-2' }),
      ]);

      // A second resume once every chunk is 'dispatched' attempts extension
      // (all settled), which this test's default empty-scan fixture declines
      // -- a true no-op past that single extension check.
      const registerCalls = (galleryService.registerGalleryImportChunk as jest.Mock).mock.calls.length;
      const dispatchCalls = (galleryService.dispatchGalleryImportChunk as jest.Mock).mock.calls.length;
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect((galleryService.registerGalleryImportChunk as jest.Mock).mock.calls.length).toBe(registerCalls);
      expect((galleryService.dispatchGalleryImportChunk as jest.Mock).mock.calls.length).toBe(dispatchCalls);
      expect(checkpointModule.clearGalleryImportCheckpoint).not.toHaveBeenCalled();
      expect(checkpointModule.clearGalleryImportPreviewCache).not.toHaveBeenCalled();
    });

    it('marks a refused resume registration failed (not phantom-planned) and recovers once the server accepts it again', async () => {
      mockCheckpoint = checkpointFixture({ status: 'reviewing', assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', pendingClusters: 999, readyCandidates: 0 }, error: null });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValueOnce({ data: null, error: { message: 'Import run is not accepting chunks', code: 'not_available' } });

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ ordinal: 0, status: 'failed', attempts: 1 }));
      expect(galleryImportStillComingCount(mockCheckpoint.chunks)).toBe(0);

      // A parked/'failed' chunk is retried exactly like a 'planned' one on the
      // next resume -- this is the recoverable path a retry action relies on.
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValueOnce({ data: { chunkId: 'chunk-1', acceptedAssetTokens: ['a'], suppressedClusterSignatures: [] }, error: null });
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ ordinal: 0, status: 'dispatched', chunkId: 'chunk-1' }));
    });

    it('abandons a chunk after GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS consecutive server-refused registration failures', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      // A real HTTP-derived code (not 'timeout'/absent) -- a genuine server
      // refusal, per errorCountsAsAttempt, spends the chunk's attempt budget.
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'still refusing', code: 'not_available' } });

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'failed', attempts: 1 }));
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'failed', attempts: 2 }));
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'abandoned', attempts: GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS }));

      // Once abandoned, further resumes never retry it again.
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledTimes(3);
    });

    it('never spends a chunk\'s attempt budget on a transient (timeout/no-code) registration failure', async () => {
      // Fix: three kicks during a bad-connection stretch must not
      // permanently abandon an otherwise-healthy chunk.
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'The gallery import service took too long to respond.', code: 'timeout' } });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
        expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'failed', attempts: 0 }));
      }

      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'no HTTP response at all' } });
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'failed', attempts: 0 }));
    });

    it('marks a chunk failed (not the whole call rejected) when an upload is refused with a real service error', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      (galleryService.getGalleryImportUploadUrl as jest.Mock).mockResolvedValue({ data: null, error: { message: 'presign failed', code: 'forbidden' } });

      await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).resolves.toEqual({ reason: 'completed' });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'failed', attempts: 1 }));
      expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
    });

    it('does not spend an attempt when an upload fails with a transient (no-code) error, e.g. a raw network failure', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      (galleryService.getGalleryImportUploadUrl as jest.Mock).mockResolvedValue({ data: null, error: { message: 'network dropped' } });

      await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).resolves.toEqual({ reason: 'completed' });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'failed', attempts: 0 }));
    });

    it('marks a chunk failed (not the whole call rejected) when dispatch is refused with a real service error', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: ['a'], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'uploaded', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [{ assetToken: 'a', previewWidth: 512, previewHeight: 460, byteLength: 11, sha256: 'a'.repeat(64) }] }] });
      (galleryService.dispatchGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'dispatch refused', code: 'not_available' } });

      await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).resolves.toEqual({ reason: 'completed' });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'failed', attempts: 1 }));
    });

    it('reports an asset it can no longer prepare after admission as unavailable (S3) instead of failing the whole chunk', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, gone: { assetToken: 'gone', osAssetId: 'gone', captureAtMs: 2, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a', 'gone'] }], previewUploads: [] }] });
      mockedPreview.mockImplementation(async ({ assetToken }: any) => {
        if (assetToken === 'gone') throw new Error('no longer available');
        return { uri: `file://${assetToken}-preview.jpg`, width: 512, height: 460, byteLength: 11, sha256: 'a'.repeat(64) };
      });

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({
        chunkId: 'chunk-1',
        previewUploads: [expect.objectContaining({ assetToken: 'a' })],
        unavailableAssetTokens: ['gone'],
      }));
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'dispatched' }));
    });

    it('prepares a planned mixed chunk before admission and dispatches only the available asset', async () => {
      jest.useFakeTimers();
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, bad: { assetToken: 'bad', osAssetId: 'bad', captureAtMs: 2, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a', 'bad'] }], previewUploads: [] }] });
      adapter.resolveAssetUri.mockImplementation((id: string) => id === 'bad' ? new Promise<string>(() => undefined) : Promise.resolve(`file://${id}.jpg`));
      try {
        const resume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
        await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
        await resume;
        expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({
          ordinal: 0,
          clusters: [expect.objectContaining({ assets: [expect.objectContaining({ assetToken: 'a' })] })],
        }));
        expect(mockedPreview).toHaveBeenCalledTimes(1);
        expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'dispatched', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }] }));
      } finally {
        jest.useRealTimers();
      }
    });

    it('purges a preprepared preview that registration suppresses and never uploads it', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, c: { assetToken: 'c', osAssetId: 'c', captureAtMs: 2, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a', 'c'] }], previewUploads: [] }] });

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(mockedPreview).toHaveBeenCalledTimes(2);
      expect(galleryService.getGalleryImportUploadUrl).not.toHaveBeenCalledWith(expect.objectContaining({ assetToken: 'c' }));
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://c-preview.jpg', { idempotent: true });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'dispatched', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }] }));
    });

    it('abandons an all-unavailable planned chunk and continues the remaining run', async () => {
      jest.useFakeTimers();
      mockCheckpoint = checkpointFixture({ assetByToken: { bad: { assetToken: 'bad', osAssetId: 'bad', captureAtMs: 1, width: 10, height: 9, isFavorite: false }, c: { assetToken: 'c', osAssetId: 'c', captureAtMs: 2, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-bad', 'cluster-c'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-bad', assetTokens: ['bad'] }], previewUploads: [] }, { ordinal: 1, status: 'planned', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }], previewUploads: [] }] });
      adapter.resolveAssetUri.mockImplementation((id: string) => id === 'bad' ? new Promise<string>(() => undefined) : Promise.resolve(`file://${id}.jpg`));
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-2', acceptedAssetTokens: ['c'], suppressedClusterSignatures: [] }, error: null });
      try {
        const resume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
        await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_ASSET_PREPARATION_TIMEOUT_MS);
        await resume;
        expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledTimes(1);
        expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 1 }));
        expect(mockCheckpoint.chunks).toEqual([
          // Clusters are retained (never emptied) on abandon -- needed for
          // maybeAdvanceGalleryImportFrontier's coverage calculation, or the
          // frontier can never advance past a fully-abandoned window.
          expect.objectContaining({ ordinal: 0, status: 'abandoned', attempts: GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS, clusters: [{ clusterSignature: 'cluster-bad', assetTokens: ['bad'] }] }),
          expect.objectContaining({ ordinal: 1, status: 'dispatched', clusters: [{ clusterSignature: 'cluster-c', assetTokens: ['c'] }] }),
        ]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('pauses (returns pass_deadline, never throws) once the preparation budget is exhausted mid-pass, leaving unreached chunks planned', async () => {
      jest.useFakeTimers();
      const hungTokens = Array.from({ length: 11 }, (_, index) => `hung-${index}`);
      const allTokens = [...hungTokens, 'tail-good'];
      mockCheckpoint = checkpointFixture({
        assetByToken: Object.fromEntries(allTokens.map((assetToken, index) => [assetToken, { assetToken, osAssetId: assetToken, captureAtMs: index + 1, width: 10, height: 9, isFavorite: false }])),
        clusterSignatures: ['cluster-hung', 'cluster-tail'],
        chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-hung', assetTokens: hungTokens }], previewUploads: [] }, { ordinal: 1, status: 'planned', clusters: [{ clusterSignature: 'cluster-tail', assetTokens: ['tail-good'] }], previewUploads: [] }],
      });
      adapter.resolveAssetUri.mockImplementation((id: string) => id === 'tail-good' ? Promise.resolve('file://tail-good.jpg') : new Promise<string>(() => undefined));
      try {
        const startedAt = Date.now();
        const resume = resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
        await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_PREPARATION_BUDGET_MS);
        await expect(resume).resolves.toEqual({ reason: 'pass_deadline' });
        expect(Date.now() - startedAt).toBe(GALLERY_IMPORT_PREPARATION_BUDGET_MS);
        expect(adapter.resolveAssetUri).toHaveBeenCalledTimes(10);
        expect(adapter.resolveAssetUri).not.toHaveBeenCalledWith('tail-good');
        expect(mockedPreview).not.toHaveBeenCalled();
        expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
        expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'planned' }));
        expect(mockCheckpoint.chunks[1]).toEqual(expect.objectContaining({ status: 'planned' }));
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps a cloud-only registered asset retryable without resolving or changing its receipt', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'registered', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      mockedPreview.mockImplementation(async () => { throw new Error('unavailable'); });

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      // S3: still registered/admitted -- reported unavailable at dispatch,
      // never a chunk-level failure just because one photo can't prepare.
      expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
      expect(galleryService.dispatchGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ chunkId: 'chunk-1', unavailableAssetTokens: ['a'] }));
    });

    it('rebuilds one stale preview receipt set when server HEAD verification rejects it', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, uploadedAssetTokens: ['a'], clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, chunkId: 'chunk-1', status: 'uploaded', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [{ assetToken: 'a', previewWidth: 512, previewHeight: 460, byteLength: 11, sha256: 'a'.repeat(64) }] }] });
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

    it('aborts gracefully (never throws) when the checkpoint disappears mid-pass', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockImplementation(async () => {
        mockCheckpoint = null; // simulate a concurrent cancel clearing the checkpoint
        return { data: { chunkId: 'chunk-1', acceptedAssetTokens: ['a'], suppressedClusterSignatures: [] }, error: null };
      });
      await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).resolves.toEqual({ reason: 'cancelled' });
      expect(galleryService.dispatchGalleryImportChunk).not.toHaveBeenCalled();
    });

    it('throws GalleryImportFairUsePausedError, persists pausedUntil, and leaves the chunk planned (not failed)', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { code: 'fair_use', message: 'Gallery import daily limit reached', retryAfterSeconds: 1800 } });

      const error = await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter }).catch((caught) => caught);
      expect(error).toBeInstanceOf(GalleryImportFairUsePausedError);
      expect(typeof (error as InstanceType<typeof GalleryImportFairUsePausedError>).pausedUntil).toBe('string');
      expect(typeof mockCheckpoint.pausedUntil).toBe('string');
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'planned' }));
    });

    it('clears a stale pausedUntil once a later registration succeeds', async () => {
      mockCheckpoint = checkpointFixture({ pausedUntil: new Date(Date.now() - 1000).toISOString(), assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, clusterSignatures: ['cluster-a'], chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(mockCheckpoint.pausedUntil).toBeUndefined();
    });
  });

  describe('processGalleryImportChunks (unit-level via resumeGalleryImportRunner semantics)', () => {
    it('returns { reason: "completed" } directly when every chunk is already settled', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      const result = await processGalleryImportChunks({ userId: 'u', familyId: 'f', runId: 'run-1', adapter, passDeadlineAtMs: Date.now() + 60_000 });
      expect(result).toEqual({ reason: 'completed' });
      expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
    });

    it('returns { reason: "cancelled" } when no checkpoint exists', async () => {
      mockCheckpoint = null;
      const result = await processGalleryImportChunks({ userId: 'u', familyId: 'f', runId: 'run-1', adapter, passDeadlineAtMs: Date.now() + 60_000 });
      expect(result).toEqual({ reason: 'cancelled' });
    });

    it('returns { reason: "pass_deadline" } immediately for an unregistered chunk when the deadline has already passed', async () => {
      mockCheckpoint = checkpointFixture({ assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1, width: 10, height: 9, isFavorite: false } }, chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }] });
      const result = await processGalleryImportChunks({ userId: 'u', familyId: 'f', runId: 'run-1', adapter, passDeadlineAtMs: Date.now() - 1 });
      expect(result).toEqual({ reason: 'pass_deadline' });
      expect(galleryService.registerGalleryImportChunk).not.toHaveBeenCalled();
    });
  });

  describe('maybeExtendGalleryImportPlan', () => {
    beforeEach(() => {
      mockedScan.mockReset();
    });

    it('extends with a new window when every chunk is settled and the backlog is below target', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [{ clusterSignature: 'sig-old', assetTokens: [] }], previewUploads: [] }] });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 10, pendingClusters: 5, chunks: [], liveCandidateAssetTokens: [] }, error: null });
      mockedScan.mockResolvedValueOnce(snapshot() as any);

      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(added).toBe(1); // 2 clusters fit into 1 chunk (GALLERY_IMPORT_CLUSTERS_PER_CHUNK=4)
      expect(mockCheckpoint.chunks).toHaveLength(2);
      // Continuing ordinal -- never collides with the settled window's chunk.
      expect(mockCheckpoint.chunks[1].ordinal).toBe(1);
      expect(mockCheckpoint.chunks[1].status).toBe('planned');
    });

    it('a fully-abandoned window advances the frontier and the next extension scans strictly older (no infinite re-scan loop)', async () => {
      // Once maybeAdvanceGalleryImportFrontier has counted an abandoned
      // window's coverage (see the runner-level test above), any later
      // maybeExtendGalleryImportPlan call must scan from that ADVANCED
      // boundary -- never re-propose the same window it just abandoned.
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'abandoned', attempts: 3, clusters: [{ clusterSignature: 'cluster-old', assetTokens: [] }], previewUploads: [] }] });
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 100, coveredThroughNewestMs: 200, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0, pendingClusters: 0, chunks: [], liveCandidateAssetTokens: [] }, error: null });
      mockedScan.mockResolvedValueOnce(snapshot() as any);

      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(mockedScan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        frontier: { coveredThroughNewestMs: 200, oldestCoveredMs: 100, corpusMode: 'full_library_fallback' },
      }));
      expect(added).toBeGreaterThan(0);
    });

    it('drops a scanned cluster whose signature is already known (safety net) and returns 0 when nothing new remains', async () => {
      mockCheckpoint = checkpointFixture({
        clusterSignatures: ['cluster-a', 'cluster-b'],
        chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }],
      });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0, pendingClusters: 0, chunks: [], liveCandidateAssetTokens: [] }, error: null });
      // The scan re-proposes the exact same two clusters this checkpoint has
      // already seen (an overlap/duplicate scan) -- nothing new remains.
      mockedScan.mockResolvedValueOnce(snapshot() as any);

      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(added).toBe(0);
      expect(mockCheckpoint.chunks).toHaveLength(1);
    });

    it('sets checkpoint.pausedUntil and returns 0 when the server reports an active fair-use pause (S1 fairUse)', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      const pausedUntil = new Date(Date.now() + 3_600_000).toISOString();
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0, pendingClusters: 0, chunks: [], liveCandidateAssetTokens: [], fairUse: { pausedUntil } }, error: null });

      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(added).toBe(0);
      expect(mockedScan).not.toHaveBeenCalled();
      expect(mockCheckpoint.pausedUntil).toBe(pausedUntil);
    });

    it('does not extend when the backlog is at or above the target', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 100, pendingClusters: 30, chunks: [], liveCandidateAssetTokens: [] }, error: null });
      mockedScan.mockResolvedValueOnce(snapshot() as any);

      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(added).toBe(0);
      expect(mockedScan).not.toHaveBeenCalled();
      expect(mockCheckpoint.chunks).toHaveLength(1);
    });

    it('does not extend while any chunk is still unsettled', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'registered', chunkId: 'chunk-1', clusters: [], previewUploads: [] }] });
      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(added).toBe(0);
      expect(galleryService.getGalleryImportRun).not.toHaveBeenCalled();
    });

    it('does not extend once the frontier reports completedLibrary', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 0, coveredThroughNewestMs: 100, completedLibrary: true, corpusMode: 'full_library_fallback', autoContinue: true });
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(added).toBe(0);
      expect(galleryService.getGalleryImportRun).not.toHaveBeenCalled();
    });

    it('does not extend once autoContinue is turned off ("Stop looking for more")', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 0, coveredThroughNewestMs: 100, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: false });
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(added).toBe(0);
      expect(galleryService.getGalleryImportRun).not.toHaveBeenCalled();
    });

    it('does not extend while a fair-use pause is active', async () => {
      mockCheckpoint = checkpointFixture({ pausedUntil: new Date(Date.now() + 60_000).toISOString(), chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(added).toBe(0);
      expect(galleryService.getGalleryImportRun).not.toHaveBeenCalled();
    });

    it('extends once a fair-use pause has passed', async () => {
      mockCheckpoint = checkpointFixture({ pausedUntil: new Date(Date.now() - 60_000).toISOString(), chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0, pendingClusters: 0, chunks: [], liveCandidateAssetTokens: [] }, error: null });
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(added).toBeGreaterThan(0);
    });

    it('does not extend when the run itself is terminal', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'completed', readyCandidates: 0, pendingClusters: 0 }, error: null });
      const added = await maybeExtendGalleryImportPlan({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });
      expect(added).toBe(0);
      expect(mockedScan).not.toHaveBeenCalled();
    });

    it('resume drives the extend-and-continue loop end to end', async () => {
      mockCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0, pendingClusters: 0, chunks: [], liveCandidateAssetTokens: [] }, error: null });
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      mockedScan.mockResolvedValue(EMPTY_SNAPSHOT as any);

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(galleryService.registerGalleryImportChunk).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 1 }));
      expect(mockCheckpoint.chunks).toHaveLength(2);
      expect(mockCheckpoint.chunks[1].status).toBe('dispatched');
    });
  });

  describe('progressive-deepening frontier', () => {
    // The mock `adapter` in this suite implements no `resolveCorpus`, so
    // every scan here resolves 'full_library_fallback' (scanGallerySnapshot's
    // documented default) -- corpus-mode reset itself is exercised in its
    // own block below by seeding a frontier under a DIFFERENT stored mode.
    it('advances the persisted frontier only once every chunk has registered, from only the actually-accepted coverage', async () => {
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      const result = await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      // The default fixture's server caps (maxClusters: 1) admit only
      // cluster-a, and only its 'a' token survives prep ('bad' fails) and
      // registration -- captureAtMs 1 for both bounds.
      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 1, coveredThroughNewestMs: 1, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
      expect(result.moreHistoryToScan).toBe(true);
    });

    it('leaves an existing frontier unchanged when registration fails (chunk becomes failed/retryable, not settled)', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'registration failed' } });

      const result = await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      expect(result.runId).toBe('run-1');

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
    });

    it('advances the frontier from an abandoned chunk\'s retained cluster tokens (accepted mid-window coverage hole, per the plan\'s Risks section)', async () => {
      // Fix: an abandoned chunk's `clusters` are never emptied, and
      // maybeAdvanceGalleryImportFrontier counts 'abandoned' the same as
      // 'dispatched' -- otherwise a fully-abandoned window would never
      // advance the frontier, and the next maybeExtendGalleryImportPlan call
      // would re-scan (and re-abandon) the exact same window forever.
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      mockedPreview.mockRejectedValue(new Error('unavailable'));
      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });
      expect(mockCheckpoint.chunks[0]).toEqual(expect.objectContaining({ status: 'abandoned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a', 'bad'] }] }));
      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 1, coveredThroughNewestMs: 2, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
    });

    it('passes the persisted frontier into the next scan so it can deepen instead of restarting from the top', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
      mockedScan.mockResolvedValueOnce(snapshot() as any);

      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(mockedScan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        frontier: { coveredThroughNewestMs: 900, oldestCoveredMs: 500, corpusMode: 'full_library_fallback' },
      }));
    });

    it('scans unbounded (no frontier) on the very first run for this user/family', async () => {
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(mockedScan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ frontier: null }));
    });

    it('sets completedLibrary, and moreHistoryToScan false, once a pass proves it reached the library end', async () => {
      mockedScan.mockReset();
      mockedScan.mockResolvedValueOnce({ ...snapshot(), reachedLibraryEnd: true, corpusMode: 'full_library_fallback' } as any);

      const result = await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(result.moreHistoryToScan).toBe(false);
      expect(await loadGalleryImportFrontier('u', 'f')).toEqual(expect.objectContaining({ completedLibrary: true }));
    });

    it('resume also advances the frontier once its remaining chunks finish registering', async () => {
      mockCheckpoint = checkpointFixture({
        assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1_000, width: 10, height: 9, isFavorite: false } },
        clusterSignatures: ['cluster-a'],
        chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }],
        scanReachedLibraryEnd: true, scanCorpusMode: 'full_library_fallback',
      });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: { chunkId: 'chunk-1', acceptedAssetTokens: ['a'], suppressedClusterSignatures: [] }, error: null });

      await resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter });

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 1_000, completedLibrary: true, corpusMode: 'full_library_fallback', autoContinue: true });
    });

    it('resume leaves the frontier unchanged when its remaining chunk fails to register', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
      mockCheckpoint = checkpointFixture({
        assetByToken: { a: { assetToken: 'a', osAssetId: 'a', captureAtMs: 1_000, width: 10, height: 9, isFavorite: false } },
        clusterSignatures: ['cluster-a'],
        chunks: [{ ordinal: 0, status: 'planned', clusters: [{ clusterSignature: 'cluster-a', assetTokens: ['a'] }], previewUploads: [] }],
        scanReachedLibraryEnd: true, scanCorpusMode: 'full_library_fallback',
      });
      (galleryService.registerGalleryImportChunk as jest.Mock).mockResolvedValue({ data: null, error: { message: 'registration failed' } });

      await expect(resumeGalleryImportRunner({ userId: 'u', familyId: 'f', runId: 'run-1', adapter })).resolves.toEqual({ reason: 'completed' });

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 500, coveredThroughNewestMs: 900, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
    });

    it('overlap tolerance: registering a coverage range already inside an existing frontier never shrinks it', async () => {
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: 0, coveredThroughNewestMs: 100, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
      mockedScan.mockResolvedValueOnce(snapshot() as any);
      // This run's only accepted asset (captureAtMs 1) falls well inside the
      // already-covered [0, 100] range -- simulating a re-registered overlap.
      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 0, coveredThroughNewestMs: 100, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
    });

    it('resets the frontier (does not mix bounds) when this run resolves a different corpus mode than the stored frontier', async () => {
      // Simulates the Android camera album appearing between runs: the
      // stored frontier was built under 'full_library_fallback', but this
      // run's scan resolves 'camera_album'.
      await saveGalleryImportFrontier('u', 'f', { oldestCoveredMs: -500_000, coveredThroughNewestMs: 500_000, completedLibrary: true, corpusMode: 'full_library_fallback', autoContinue: true });
      mockedScan.mockReset();
      mockedScan.mockResolvedValueOnce({ ...snapshot(), corpusMode: 'camera_album' } as any);

      await startGalleryImportRunner({ userId: 'u', familyId: 'f', useCellular: false, adapter });

      expect(await loadGalleryImportFrontier('u', 'f')).toEqual({ oldestCoveredMs: 1, coveredThroughNewestMs: 1, completedLibrary: false, corpusMode: 'camera_album', autoContinue: true });
    });
  });
});
