import { beginGalleryImportPipeline } from '@/utils/gallery-import-pipeline';
import { getGalleryImportPendingStart, clearGalleryImportPendingStart } from '@/utils/gallery-import-pending-start';
import { getLatestGalleryImportLiveProgress, isGalleryImportRunnerActive, clearGalleryImportLiveProgress, markGalleryImportRunnerInactive } from '@/utils/gallery-import-live-progress';
import { GalleryImportWaitingForWifiError, startGalleryImportRunner } from '@/services/gallery-import-runner';
import { kickGalleryImportDriver } from '@/services/gallery-import-driver';

jest.mock('@/services/gallery-import-runner', () => {
  class GalleryImportWaitingForWifiErrorMock extends Error {}
  return {
    GalleryImportWaitingForWifiError: GalleryImportWaitingForWifiErrorMock,
    startGalleryImportRunner: jest.fn(),
  };
});
// The driver module transitively pulls in the real (native) expo-media-library
// via gallery-import-scanner.ts -- this suite only needs to confirm
// beginGalleryImportPipeline calls it, not exercise its internals.
jest.mock('@/services/gallery-import-driver', () => ({
  kickGalleryImportDriver: jest.fn(),
}));

const adapter = {} as any;

describe('beginGalleryImportPipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearGalleryImportPendingStart();
  });
  afterEach(() => {
    clearGalleryImportLiveProgress('run-1');
    markGalleryImportRunnerInactive('run-1');
  });

  it('marks starting synchronously, before the runner promise ever resolves', () => {
    (startGalleryImportRunner as jest.Mock).mockReturnValue(new Promise(() => {}));
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    expect(getGalleryImportPendingStart()).toEqual({ status: 'starting' });
  });

  it('routes pre-run-id scan progress into the pending-start count, then run-id progress into the live bus', async () => {
    let onProgress: ((p: any) => void) | undefined;
    let onRunStarted: ((id: string) => void) | undefined;
    (startGalleryImportRunner as jest.Mock).mockImplementation((input: any) => {
      onProgress = input.onProgress;
      onRunStarted = input.onRunStarted;
      return new Promise(() => {});
    });
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });

    onProgress?.({ stage: 'scanning', completed: 5, total: 5, scannedAssetCount: 5 });
    expect(getGalleryImportPendingStart()?.scannedAssetCount).toBe(5);

    onRunStarted?.('run-1');
    expect(getGalleryImportPendingStart()).toEqual({ status: 'started', runId: 'run-1' });
    expect(isGalleryImportRunnerActive('run-1')).toBe(true);

    onProgress?.({ stage: 'sending', completed: 1, total: 4 });
    expect(getLatestGalleryImportLiveProgress('run-1')).toEqual({ stage: 'sending', completed: 1, total: 4 });
  });

  it('reports waitingWifi distinctly from a generic failure', async () => {
    (startGalleryImportRunner as jest.Mock).mockRejectedValue(new GalleryImportWaitingForWifiError());
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportPendingStart()?.status).toBe('waitingWifi');
  });

  it('reports a generic failure for any other error', async () => {
    (startGalleryImportRunner as jest.Mock).mockRejectedValue(new Error('boom'));
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGalleryImportPendingStart()?.status).toBe('failed');
  });

  it('marks the run inactive once the pipeline settles with a run id', async () => {
    (startGalleryImportRunner as jest.Mock).mockImplementation(async (input: any) => {
      input.onRunStarted?.('run-1');
      return { runId: 'run-1', scannedAssetCount: 1, clusterCount: 1 };
    });
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isGalleryImportRunnerActive('run-1')).toBe(false);
  });

  it('marks the run inactive when it fails AFTER onRunStarted fired (regression: the runner used to stay active forever)', async () => {
    // Audited bug: the old `.catch` handler overwrote the pending-start slot
    // without a `runId`, so `.finally`'s `if (pending?.runId)` check never
    // found one to mark inactive -- the progress screen froze and auto-resume
    // never kicked in. `startedRunId` must be captured independently of
    // whatever the pending-start slot holds by the time `.catch` runs.
    (startGalleryImportRunner as jest.Mock).mockImplementation(async (input: any) => {
      input.onRunStarted?.('run-1');
      throw new Error('a chunk failure surfaced after the run already started');
    });
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isGalleryImportRunnerActive('run-1')).toBe(false);
    expect(getGalleryImportPendingStart()).toEqual(expect.objectContaining({ status: 'failed', runId: 'run-1' }));
  });

  it('marks a fair-use pause inactive too, retaining the runId on the pending-start slot', async () => {
    (startGalleryImportRunner as jest.Mock).mockImplementation(async (input: any) => {
      input.onRunStarted?.('run-1');
      throw new GalleryImportWaitingForWifiError();
    });
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isGalleryImportRunnerActive('run-1')).toBe(false);
    expect(getGalleryImportPendingStart()).toEqual(expect.objectContaining({ status: 'waitingWifi', runId: 'run-1' }));
  });

  it('kicks the driver once the pipeline settles, so window extension continues without waiting for the next tick', async () => {
    (startGalleryImportRunner as jest.Mock).mockImplementation(async (input: any) => {
      input.onRunStarted?.('run-1');
      return { runId: 'run-1', scannedAssetCount: 1, clusterCount: 1 };
    });
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kickGalleryImportDriver).toHaveBeenCalledWith('start-finished');
  });

  it('kicks the driver even when the start pipeline fails', async () => {
    (startGalleryImportRunner as jest.Mock).mockRejectedValue(new Error('boom'));
    beginGalleryImportPipeline({ userId: 'u', familyId: 'f', useCellular: false, adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kickGalleryImportDriver).toHaveBeenCalledWith('start-finished');
  });
});
