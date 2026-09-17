import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

import {
  GalleryImportFairUsePausedError,
  GalleryImportWaitingForWifiError,
  resumeGalleryImportRunner,
} from '@/services/gallery-import-runner';
import {
  getGalleryImportDriverState,
  kickGalleryImportDriver,
  resetGalleryImportDriverForTests,
  setGalleryImportAutoContinue,
  setGalleryImportDriverContext,
  startGalleryImportDriverListeners,
  subscribeGalleryImportDriver,
} from '@/services/gallery-import-driver';
import { loadLatestGalleryImportCheckpoint } from '@/utils/gallery-import-checkpoint';
import { loadGalleryImportFrontier, saveGalleryImportFrontier } from '@/utils/gallery-import-frontier';
import {
  getLatestGalleryImportLiveProgress,
  isGalleryImportRunnerActive,
  markGalleryImportRunnerActive,
  markGalleryImportRunnerInactive,
} from '@/utils/gallery-import-live-progress';

jest.mock('@react-native-community/netinfo', () => ({ fetch: jest.fn(), addEventListener: jest.fn() }));
jest.mock('@/utils/gallery-import-e2e-adapter', () => ({ getGalleryImportE2eAdapter: jest.fn(() => undefined) }));
jest.mock('@/utils/gallery-import-scanner', () => ({ createExpoGalleryMediaLibraryAdapter: jest.fn(() => ({})) }));
jest.mock('@/services/gallery-import-runner', () => {
  const actual = jest.requireActual('@/services/gallery-import-runner');
  return {
    ...actual,
    resumeGalleryImportRunner: jest.fn(),
  };
});
jest.mock('@/utils/gallery-import-checkpoint', () => ({
  loadLatestGalleryImportCheckpoint: jest.fn(),
}));
jest.mock('@/utils/gallery-import-frontier', () => ({
  loadGalleryImportFrontier: jest.fn(),
  saveGalleryImportFrontier: jest.fn(),
}));

const mockedResume = resumeGalleryImportRunner as jest.MockedFunction<typeof resumeGalleryImportRunner>;
const mockedLoadCheckpoint = loadLatestGalleryImportCheckpoint as jest.MockedFunction<typeof loadLatestGalleryImportCheckpoint>;
const mockedLoadFrontier = loadGalleryImportFrontier as jest.MockedFunction<typeof loadGalleryImportFrontier>;
const mockedSaveFrontier = saveGalleryImportFrontier as jest.MockedFunction<typeof saveGalleryImportFrontier>;
const mockedNetworkFetch = NetInfo.fetch as jest.MockedFunction<typeof NetInfo.fetch>;

function checkpointFixture(overrides: Record<string, unknown> = {}) {
  return {
    version: 2, userId: 'u', familyId: 'f', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1',
    status: 'processing', assetByToken: {}, uploadedAssetTokens: [], clusterSignatures: [],
    chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }],
    deckCursor: 0, approvalOutbox: [], updatedAt: 'now', ...overrides,
  } as any;
}

describe('gallery import driver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetGalleryImportDriverForTests();
    mockedNetworkFetch.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'wifi', details: { isConnectionExpensive: false } } as any);
    mockedLoadFrontier.mockResolvedValue(null);
    mockedResume.mockResolvedValue(undefined);
    setGalleryImportDriverContext('u', 'f');
  });

  it('replays the current state immediately to a new subscriber', () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeGalleryImportDriver((state) => seen.push(state));
    expect(seen).toEqual([{ phase: 'idle', runId: null, pausedUntil: null, lastError: null, isActive: false }]);
    unsubscribe();
  });

  it('is a no-op when no user/family context has been set', async () => {
    setGalleryImportDriverContext(null, null);
    kickGalleryImportDriver('test');
    await Promise.resolve();
    expect(mockedLoadCheckpoint).not.toHaveBeenCalled();
  });

  it('goes idle when there is no local checkpoint', async () => {
    mockedLoadCheckpoint.mockResolvedValue(null);
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ phase: 'idle', runId: null }));
    expect(mockedResume).not.toHaveBeenCalled();
  });

  it('reports paused_fair_use from the checkpoint alone, without ever calling resume', async () => {
    const pausedUntil = new Date(Date.now() + 60_000).toISOString();
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture({ pausedUntil }));
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ phase: 'paused_fair_use', pausedUntil, isActive: false }));
    expect(mockedResume).not.toHaveBeenCalled();
  });

  it('reports waiting_wifi and skips resume when the checkpoint is wifi-paused and no Wi-Fi is available', async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture({ status: 'paused' }));
    mockedNetworkFetch.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ phase: 'waiting_wifi', isActive: false }));
    expect(mockedResume).not.toHaveBeenCalled();
  });

  it('re-checks NetInfo on every kick, so Wi-Fi regain resumes automatically', async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture({ status: 'paused' }));
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedResume).toHaveBeenCalledTimes(1);
    expect(mockedResume).toHaveBeenCalledWith(expect.objectContaining({ allowCellular: false }));
  });

  it('passes allowCellular through from the checkpoint (S8) even without a per-kick opt', async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture({ status: 'paused', allowCellular: true }));
    mockedNetworkFetch.mockResolvedValue({ isConnected: true, isInternetReachable: true, type: 'cellular', details: {} } as any);
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedResume).toHaveBeenCalledWith(expect.objectContaining({ allowCellular: true }));
  });

  it('publishes onProgress through the shared live-progress bus, and reflects it in its own state via that same subscription', async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
    mockedResume.mockImplementation(async (input: any) => {
      input.onProgress?.({ stage: 'sending', completed: 3, total: 10 });
    });
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLatestGalleryImportLiveProgress('run-1')).toEqual({ stage: 'sending', completed: 3, total: 10 });
  });

  it('reports done once every chunk is settled and there is no more history', async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
    mockedLoadFrontier.mockResolvedValue({ oldestCoveredMs: 0, coveredThroughNewestMs: 1, completedLibrary: true, corpusMode: 'full_library_fallback', autoContinue: true });
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ phase: 'done', isActive: false }));
  });

  it('reports idle (and keeps ticking) when the frontier says more history remains', async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
    mockedLoadFrontier.mockResolvedValue({ oldestCoveredMs: 0, coveredThroughNewestMs: 1, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ phase: 'idle' }));
  });

  it('maps a thrown GalleryImportWaitingForWifiError to waiting_wifi', async () => {
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
    mockedResume.mockRejectedValue(new GalleryImportWaitingForWifiError());
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ phase: 'waiting_wifi', isActive: false }));
  });

  it('maps a thrown GalleryImportFairUsePausedError to paused_fair_use with its pausedUntil', async () => {
    const pausedUntil = new Date(Date.now() + 3_600_000).toISOString();
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
    mockedResume.mockRejectedValue(new GalleryImportFairUsePausedError(pausedUntil));
    kickGalleryImportDriver('test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ phase: 'paused_fair_use', pausedUntil }));
  });

  it('maps any other error to a content-free error phase and schedules an automatic retry', async () => {
    jest.useFakeTimers();
    try {
      mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
      mockedResume.mockRejectedValueOnce(new Error('a network hiccup'));
      mockedResume.mockResolvedValueOnce(undefined);
      kickGalleryImportDriver('test');
      await jest.advanceTimersByTimeAsync(0);
      expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ phase: 'error', isActive: false }));
      expect(getGalleryImportDriverState().lastError).toBeTruthy();
      expect(mockedResume).toHaveBeenCalledTimes(1);

      // Automatic retry fires after the 30s backoff, without any external kick.
      await jest.advanceTimersByTimeAsync(30_000);
      expect(mockedResume).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('coalesces a kick received while one is already in flight into exactly one follow-up attempt', async () => {
    let resolveFirst!: () => void;
    mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
    mockedResume.mockImplementation(() => new Promise((resolve) => { resolveFirst = () => resolve(undefined); }));

    kickGalleryImportDriver('first');
    kickGalleryImportDriver('second');
    kickGalleryImportDriver('third');
    await Promise.resolve();
    expect(mockedResume).toHaveBeenCalledTimes(1);

    resolveFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedResume).toHaveBeenCalledTimes(2);
  });

  it('setGalleryImportAutoContinue is a no-op when no frontier exists yet', async () => {
    mockedLoadFrontier.mockResolvedValue(null);
    await setGalleryImportAutoContinue('u', 'f', false);
    expect(mockedSaveFrontier).not.toHaveBeenCalled();
  });

  it('setGalleryImportAutoContinue persists false onto an existing frontier', async () => {
    const existing = { oldestCoveredMs: 0, coveredThroughNewestMs: 1, completedLibrary: false, corpusMode: 'full_library_fallback' as const, autoContinue: true };
    mockedLoadFrontier.mockResolvedValue(existing);
    await setGalleryImportAutoContinue('u', 'f', false);
    expect(mockedSaveFrontier).toHaveBeenCalledWith('u', 'f', { ...existing, autoContinue: false });
  });

  describe('double-processing race guard (driver vs. the start pipeline)', () => {
    afterEach(() => {
      markGalleryImportRunnerInactive('run-1');
    });

    it('does not call resumeGalleryImportRunner when another caller has already marked the run active', async () => {
      mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
      markGalleryImportRunnerActive('run-1');

      kickGalleryImportDriver('test');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockedResume).not.toHaveBeenCalled();
      expect(getGalleryImportDriverState()).toEqual(expect.objectContaining({ isActive: true, runId: 'run-1' }));
    });

    it('marks the run active for the whole resume call (single source of truth with the start pipeline), then inactive again once it settles', async () => {
      mockedLoadCheckpoint.mockResolvedValue(checkpointFixture());
      let wasActiveDuringResume = false;
      mockedResume.mockImplementation(async () => {
        wasActiveDuringResume = isGalleryImportRunnerActive('run-1');
      });

      kickGalleryImportDriver('test');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(wasActiveDuringResume).toBe(true);
      expect(isGalleryImportRunnerActive('run-1')).toBe(false);
    });
  });

  describe('pass_deadline re-kick (does not wait for the next tick)', () => {
    it('re-kicks immediately when a pass yields pass_deadline with chunks still unsettled', async () => {
      let mockLatestCheckpoint: any = checkpointFixture({ chunks: [{ ordinal: 0, status: 'planned', clusters: [], previewUploads: [] }] });
      mockedLoadCheckpoint.mockImplementation(async () => mockLatestCheckpoint);
      mockedResume
        .mockImplementationOnce(async () => ({ reason: 'pass_deadline' }) as any)
        .mockImplementationOnce(async () => {
          mockLatestCheckpoint = checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] });
        });

      kickGalleryImportDriver('test');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockedResume).toHaveBeenCalledTimes(2);
    });

    it('does not re-kick immediately when pass_deadline coincides with every chunk already settled', async () => {
      mockedLoadCheckpoint.mockResolvedValue(checkpointFixture({ chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }] }));
      mockedResume.mockResolvedValue({ reason: 'pass_deadline' } as any);

      kickGalleryImportDriver('test');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockedResume).toHaveBeenCalledTimes(1);
    });
  });

  describe('startGalleryImportDriverListeners', () => {
    it('kicks on an AppState active transition', async () => {
      let handleChange: ((status: string) => void) | undefined;
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
        handleChange = listener as (status: string) => void;
        return { remove: jest.fn() } as any;
      });
      mockedLoadCheckpoint.mockResolvedValue(null);
      startGalleryImportDriverListeners();
      handleChange?.('active');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockedLoadCheckpoint).toHaveBeenCalledWith('u', 'f');
    });

    it('kicks on a NetInfo change event', async () => {
      let handleNetInfoChange: (() => void) | undefined;
      (NetInfo.addEventListener as jest.Mock).mockImplementation((listener: () => void) => {
        handleNetInfoChange = listener;
        return jest.fn();
      });
      mockedLoadCheckpoint.mockResolvedValue(null);
      startGalleryImportDriverListeners();
      handleNetInfoChange?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockedLoadCheckpoint).toHaveBeenCalledWith('u', 'f');
    });

    it('is idempotent -- a second call does not double-register listeners', () => {
      const appStateSpy = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() } as any);
      const netInfoSpy = NetInfo.addEventListener as jest.Mock;
      startGalleryImportDriverListeners();
      startGalleryImportDriverListeners();
      expect(appStateSpy).toHaveBeenCalledTimes(1);
      expect(netInfoSpy).toHaveBeenCalledTimes(1);
    });
  });
});
