import { beginGalleryImportPipeline } from '@/utils/gallery-import-pipeline';
import { getGalleryImportPendingStart, clearGalleryImportPendingStart } from '@/utils/gallery-import-pending-start';
import { getLatestGalleryImportLiveProgress, isGalleryImportRunnerActive, clearGalleryImportLiveProgress, markGalleryImportRunnerInactive } from '@/utils/gallery-import-live-progress';
import { GalleryImportWaitingForWifiError, startGalleryImportRunner } from '@/services/gallery-import-runner';

jest.mock('@/services/gallery-import-runner', () => {
  class GalleryImportWaitingForWifiErrorMock extends Error {}
  return {
    GalleryImportWaitingForWifiError: GalleryImportWaitingForWifiErrorMock,
    startGalleryImportRunner: jest.fn(),
  };
});

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

    onProgress?.({ stage: 'preparing', completed: 1, total: 4 });
    expect(getLatestGalleryImportLiveProgress('run-1')).toEqual({ stage: 'preparing', completed: 1, total: 4 });
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
});
