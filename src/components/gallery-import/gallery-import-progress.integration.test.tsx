import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { GalleryImportProgress } from '@/components/gallery-import/gallery-import-progress';
import { getStickyFooterBottomPadding } from '@/components/keyboard-sticky-shell';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useIsOnline } from '@/lib/connectivity';
import * as galleryService from '@/services/gallery-import';
import { kickGalleryImportDriver, setGalleryImportAutoContinue } from '@/services/gallery-import-driver';
import {
  GalleryImportEmptyLibraryError,
  GalleryImportServiceRequestError,
} from '@/services/gallery-import-runner';
import { clearGalleryImportLiveProgress } from '@/utils/gallery-import-live-progress';
import { clearGalleryImportPendingStart, setGalleryImportPendingStart } from '@/utils/gallery-import-pending-start';
import { beginGalleryImportPipeline } from '@/utils/gallery-import-pipeline';

let mockCheckpoint: any = null;

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), setParams: jest.fn() } }));
// See gallery-import-trust.test.tsx for why this simulates real inset math
// instead of a dumb pass-through -- it lets a dropped/doubled safe-area
// application fail a real assertion.
const TEST_INSETS = { top: 47, bottom: 28, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => {
  const { View: MockView } = require('react-native');
  return {
    useSafeAreaInsets: () => TEST_INSETS,
    SafeAreaView: ({ edges = ['top', 'bottom', 'left', 'right'], style, children, ...rest }: any) => {
      const padding = {
        paddingTop: edges.includes('top') ? TEST_INSETS.top : 0,
        paddingBottom: edges.includes('bottom') ? TEST_INSETS.bottom : 0,
        paddingLeft: edges.includes('left') ? TEST_INSETS.left : 0,
        paddingRight: edges.includes('right') ? TEST_INSETS.right : 0,
      };
      return <MockView style={[style, padding]} {...rest}>{children}</MockView>;
    },
  };
});
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/use-billing', () => ({ useBilling: jest.fn() }));
jest.mock('@/lib/connectivity', () => ({ useIsOnline: jest.fn() }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/utils/gallery-import-e2e-adapter', () => ({ getGalleryImportE2eAdapter: () => undefined }));
jest.mock('@/utils/gallery-import-scanner', () => ({ createExpoGalleryMediaLibraryAdapter: () => ({}) }));
jest.mock('@/utils/gallery-import-pipeline', () => ({ beginGalleryImportPipeline: jest.fn() }));
// Frontier defaults to "nothing on record" (null) for every test unless a
// test opts in -- deriveGalleryImportComingIndicator then reads moreHistory
// as false, matching the pre-S9 default behavior most scenarios rely on.
jest.mock('@/utils/gallery-import-frontier', () => ({ loadGalleryImportFrontier: jest.fn(async () => null) }));
// The continuous model's driver (docs/plans/gallery-import-continuous.md
// I4a step 6): this screen no longer resumes the runner itself, it only
// observes driver state and kicks it. resumeGalleryImportRunner is
// deliberately NOT exported by this mock -- if the screen ever imports it
// again, the resulting undefined-is-not-a-function error is the signal that
// the self-resume regressed.
jest.mock('@/services/gallery-import-driver', () => {
  let mockDriverState = { phase: 'idle', runId: null, pausedUntil: null, lastError: null, isActive: false };
  const mockDriverListeners = new Set();
  return {
    getGalleryImportDriverState: () => mockDriverState,
    subscribeGalleryImportDriver: (listener: any) => {
      mockDriverListeners.add(listener);
      listener(mockDriverState);
      return () => mockDriverListeners.delete(listener);
    },
    kickGalleryImportDriver: jest.fn(),
    setGalleryImportAutoContinue: jest.fn(async () => undefined),
    __setDriverState: (patch: any) => {
      mockDriverState = { ...mockDriverState, ...patch };
      mockDriverListeners.forEach((listener: any) => listener(mockDriverState));
    },
    __resetDriverState: () => {
      mockDriverState = { phase: 'idle', runId: null, pausedUntil: null, lastError: null, isActive: false };
    },
  };
});
jest.mock('@/services/gallery-import-runner', () => {
  class GalleryImportEmptyLibraryErrorMock extends Error {}
  class GalleryImportServiceRequestErrorMock extends Error {
    code?: string;
    constructor(message: string, code?: string) { super(message); this.code = code; }
  }
  return {
    GalleryImportEmptyLibraryError: GalleryImportEmptyLibraryErrorMock,
    GalleryImportServiceRequestError: GalleryImportServiceRequestErrorMock,
  };
});
jest.mock('@/services/gallery-import', () => ({ cancelGalleryImportRun: jest.fn(), getGalleryImportRun: jest.fn() }));
jest.mock('@/utils/gallery-import-checkpoint', () => ({
  loadGalleryImportCheckpoint: jest.fn(async () => mockCheckpoint), clearGalleryImportCheckpoint: jest.fn(), clearGalleryImportPreviewCache: jest.fn(),
  updateGalleryImportCheckpoint: jest.fn(async (_u: string, _f: string, _r: string, update: any) => { mockCheckpoint = update(mockCheckpoint); return mockCheckpoint; }),
}));

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    version: 2, userId: 'user-1', familyId: 'family-1', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1',
    status: 'reviewing', permissionMode: 'full', assetByToken: {}, uploadedAssetTokens: [], clusterSignatures: [],
    chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }], deckCursor: 3, deckTotal: 3, approvalOutbox: [], updatedAt: 'now',
    ...overrides,
  };
}

function collectRenderedText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((child) => collectRenderedText(child, out)); return out; }
  if (typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
    collectRenderedText((node as { children?: unknown }).children, out);
  }
  return out;
}

describe('gallery import progress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckpoint = checkpoint();
    clearGalleryImportPendingStart();
    jest.requireMock('@/services/gallery-import-driver').__resetDriverState();
    (useFamily as jest.Mock).mockReturnValue({ role: 'owner', familyId: 'family-1', isLoading: false });
    (useBilling as jest.Mock).mockReturnValue({ status: { has_write_access: true, has_ever_had_access: true } });
    (useIsOnline as jest.Mock).mockReturnValue(true);
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 1 }, error: null });
  });

  afterEach(() => {
    clearGalleryImportLiveProgress('run-1');
    clearGalleryImportPendingStart();
  });

  describe('no run id in the route (device-bound / pending-start)', () => {
    it('shows the restyled device-bound screen with the wrongDevice primary action when nothing is pending', async () => {
      const { router } = jest.requireMock('expo-router');
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByTestId('gallery-import-device-bound-back')).toBeTruthy());
      fireEvent.press(screen.getByTestId('gallery-import-device-bound-primary'));
      expect(router.replace).toHaveBeenCalledWith('/(app)/gallery-import');
    });

    it('renders the live scanning stage the instant a pipeline start is pending, with no Stop button and real safe-area/scroll', async () => {
      setGalleryImportPendingStart({ status: 'starting', scannedAssetCount: 240 });
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByText('240 photos read')).toBeTruthy());
      expect(screen.getByText('Looking through your photos')).toBeTruthy();
      expect(screen.queryByTestId('gallery-import-stop')).toBeNull();
      expect(screen.getByTestId('gallery-import-progress-scroll')).toBeTruthy();

      const tree = screen.toJSON();
      const outer = Array.isArray(tree) ? tree[0] : tree;
      const outerStyle = [outer.props.style].flat(Infinity).filter(Boolean);
      expect(outerStyle).toEqual(expect.arrayContaining([expect.objectContaining({ paddingTop: TEST_INSETS.top })]));
    });

    it('re-renders live as the pending scan count updates', async () => {
      setGalleryImportPendingStart({ status: 'starting', scannedAssetCount: 10 });
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByText('10 photos read')).toBeTruthy());
      act(() => { setGalleryImportPendingStart({ status: 'starting', scannedAssetCount: 250 }); });
      await waitFor(() => expect(screen.getByText('250 photos read')).toBeTruthy());
    });

    it('offers cellular data for a pre-run-id Wi-Fi wait, and retries the whole pipeline in place -- never bouncing back to entry', async () => {
      const { router } = jest.requireMock('expo-router');
      setGalleryImportPendingStart({ status: 'waitingWifi', permissionMode: 'full' });
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByText('Waiting for Wi-Fi')).toBeTruthy());
      fireEvent.press(screen.getByTestId('gallery-import-stage-action-Use cellular data instead'));
      await waitFor(() => expect(screen.getByTestId('gallery-import-cellular-sheet')).toBeTruthy());
      fireEvent.press(screen.getByTestId('gallery-import-confirm-cellular'));
      await waitFor(() => expect(beginGalleryImportPipeline).toHaveBeenCalledWith(expect.objectContaining({ useCellular: true, permissionMode: 'full' })));
      expect(router.replace).not.toHaveBeenCalledWith(expect.stringContaining('/(app)/gallery-import') as any);
      expect(router.push).not.toHaveBeenCalled();
    });

    it('shows the emptyLibrary outcome for a pending start that failed with no dated photos', async () => {
      setGalleryImportPendingStart({ status: 'failed', error: new GalleryImportEmptyLibraryError() });
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByTestId('gallery-import-progress-empty-emptyLibrary')).toBeTruthy());
    });

    it('shows the capped exception for a pending start that failed with a server not_available code', async () => {
      setGalleryImportPendingStart({ status: 'failed', error: new GalleryImportServiceRequestError('nope', 'not_available') });
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByTestId('gallery-import-progress-exception-capped')).toBeTruthy());
    });

    it('shows a recoverable exception for any other pending-start failure, and retries the pipeline from its primary action', async () => {
      setGalleryImportPendingStart({ status: 'failed', error: new Error('boom'), permissionMode: 'full' });
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByTestId('gallery-import-progress-exception-errorRecoverable')).toBeTruthy());
      fireEvent.press(screen.getByTestId('gallery-import-progress-exception-errorRecoverable-primary'));
      expect(beginGalleryImportPipeline).toHaveBeenCalledWith(expect.objectContaining({ useCellular: false, permissionMode: 'full' }));
    });

    it('adopts a freshly-known run id into the route once the pipeline reports one', async () => {
      const { router } = jest.requireMock('expo-router');
      setGalleryImportPendingStart({ status: 'starting' });
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByTestId('gallery-import-progress')).toBeTruthy());
      act(() => { setGalleryImportPendingStart({ status: 'started', runId: 'run-9' }); });
      await waitFor(() => expect(router.setParams).toHaveBeenCalledWith({ runId: 'run-9' }));
    });
  });

  it('kicks the driver on mount for an existing run, and never imports/calls resumeGalleryImportRunner itself', async () => {
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress')).toBeTruthy());
    expect(kickGalleryImportDriver).toHaveBeenCalledWith('progress-screen-mount');
  });

  it('transitions from processing to ready once the ~8s poll observes reviewing, without remounting', async () => {
    jest.useFakeTimers();
    try {
      mockCheckpoint = checkpoint({ status: 'processing' });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing', readyCandidates: 0 }, error: null });

      const screen = render(<GalleryImportProgress runId="run-1" />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('Writing the drafts')).toBeTruthy();
      expect(screen.queryByTestId('gallery-import-review')).toBeNull();

      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 60, pendingClusters: 0 }, error: null });
      await act(async () => { await jest.advanceTimersByTimeAsync(8_000); });

      expect(screen.getByText('60 ready to review')).toBeTruthy();
      expect(screen.getByTestId('gallery-import-review')).toBeTruthy();
      expect(screen.getByTestId('gallery-import-progress')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('folds expired into the staged expired view instead of a bare terminal notice', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'expired', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('These have cleared')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-look-again')).toBeTruthy();
  });

  it('shows the partial-failure stage with real ready counts and a way into the deck', async () => {
    const { router } = jest.requireMock('expo-router');
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'failed', readyCandidates: 4 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('4 suggestions ready')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-review')).toBeTruthy();
    fireEvent.press(screen.getByTestId('gallery-import-review'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/review', params: { runId: 'run-1' } }));
  });

  it('shows the distinct errorFinal exception when a failed run has nothing ready', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'failed', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress-exception-errorFinal')).toBeTruthy());
  });

  it('distinguishes lapsed and demoted from a generic failure', async () => {
    (useBilling as jest.Mock).mockReturnValue({ status: { has_write_access: false, has_ever_had_access: true } });
    const lapsed = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(lapsed.getByTestId('gallery-import-progress-exception-lapsed')).toBeTruthy());
    lapsed.unmount();

    (useBilling as jest.Mock).mockReturnValue({ status: { has_write_access: true, has_ever_had_access: true } });
    (useFamily as jest.Mock).mockReturnValue({ role: 'viewer', familyId: 'family-1', isLoading: false });
    const demoted = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(demoted.getByTestId('gallery-import-progress-exception-demoted')).toBeTruthy());
  });

  it('never evaluates demoted/lapsed against a since-switched active family', async () => {
    (useFamily as jest.Mock).mockReturnValue({ role: 'viewer', familyId: 'family-2', isLoading: false });
    (useBilling as jest.Mock).mockReturnValue({ status: { has_write_access: false, has_ever_had_access: true } });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-review')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-progress-exception-demoted')).toBeNull();
    expect(screen.queryByTestId('gallery-import-progress-exception-lapsed')).toBeNull();
  });

  it('shows the offline exception when the device has no connection', async () => {
    (useIsOnline as jest.Mock).mockReturnValue(false);
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress-exception-offline')).toBeTruthy());
  });

  it('shows the nothing-stood-out empty outcome for a zero-ready untouched deck instead of "All caught up"', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 0, deckTotal: 0 });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress-empty-nothing')).toBeTruthy());
  });

  it('distinguishes the limited-permission empty outcome', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 0, deckTotal: 0, permissionMode: 'limited' });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress-empty-limitedNothing')).toBeTruthy());
  });

  it('persists allowCellular on the checkpoint and kicks the driver, never calling the runner directly, for an already-running import', async () => {
    mockCheckpoint = checkpoint({ status: 'paused', chunks: [{ ordinal: 0, status: 'registered', clusters: [{ clusterSignature: 'a', assetTokens: ['x'] }], previewUploads: [] }] });
    const { router } = jest.requireMock('expo-router');
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Waiting for Wi-Fi')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-stage-action-Use cellular data instead'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-cellular-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-confirm-cellular'));
    await waitFor(() => expect(mockCheckpoint.allowCellular).toBe(true));
    expect(kickGalleryImportDriver).toHaveBeenCalledWith('cellular', { allowCellular: true });
    expect(router.replace).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: expect.stringContaining('/gallery-import') }));
    expect(router.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: expect.stringContaining('/gallery-import') }));
  });

  it('kicks a retry instead of resuming directly from the recoverable-error exception', async () => {
    // No server status has landed yet and the poll fails -- hasTransientError.
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: null, error: { message: 'boom' } });
    mockCheckpoint = checkpoint({ status: 'reviewing', deckCursor: 0, deckTotal: 0 });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress-exception-errorRecoverable')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-progress-exception-errorRecoverable-primary'));
    expect(kickGalleryImportDriver).toHaveBeenCalledWith('retry');
  });

  it('opens the stop-confirm sheet with the trimmed copy and stops via the real cancel service, not a native Alert', async () => {
    (galleryService.cancelGalleryImportRun as jest.Mock).mockResolvedValue({ data: { cancelled: true }, error: null });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-stop')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-stop'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-stop-sheet')).toBeTruthy());
    expect(screen.getByText('Drafts clear. Kept memories stay.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('gallery-import-confirm-stop'));
    await waitFor(() => expect(galleryService.cancelGalleryImportRun).toHaveBeenCalledWith({ runId: 'run-1', capability: 'cap' }));
  });

  it('calls setGalleryImportAutoContinue and shows an inline note when "Stop looking for more" is pressed', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-stop-looking-for-more')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-stop-looking-for-more'));
    expect(setGalleryImportAutoContinue).toHaveBeenCalledWith('user-1', 'family-1', false);
    await waitFor(() => expect(screen.getByTestId('gallery-import-stopped-looking-note')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-stop-looking-for-more')).toBeNull();
  });

  it('reads a persisted autoContinue=false as already stopped and offers "Keep looking", which re-enables and kicks the driver', async () => {
    const { loadGalleryImportFrontier } = jest.requireMock('@/utils/gallery-import-frontier') as { loadGalleryImportFrontier: jest.Mock };
    loadGalleryImportFrontier.mockResolvedValueOnce({ oldestCoveredMs: 1, coveredThroughNewestMs: 2, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: false });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-stopped-looking-note')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-stop-looking-for-more')).toBeNull();
    fireEvent.press(screen.getByTestId('gallery-import-keep-looking'));
    expect(setGalleryImportAutoContinue).toHaveBeenCalledWith('user-1', 'family-1', true);
    await waitFor(() => expect(kickGalleryImportDriver).toHaveBeenCalledWith('keep-looking'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-stop-looking-for-more')).toBeTruthy());
  });

  it('shows the fair-use pause stage with a Review footer when the checkpoint carries a future pausedUntil', async () => {
    mockCheckpoint = checkpoint({ pausedUntil: new Date(Date.now() + 60_000).toISOString() });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 5, pendingClusters: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Momora will keep looking tomorrow')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-review')).toBeTruthy();
    expect(screen.getByText('Review 5')).toBeTruthy();
  });

  it('shows one muted line with the abandoned-chunk count only when it is greater than zero', async () => {
    mockCheckpoint = checkpoint({
      chunks: [
        { ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] },
        { ordinal: 1, status: 'abandoned', clusters: [{ clusterSignature: 'a', assetTokens: ['x'] }], previewUploads: [] },
      ],
    });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 2, pendingClusters: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-abandoned-count')).toBeTruthy());
    expect(screen.getByText('1 batch couldn’t be sent')).toBeTruthy();
  });

  it('shows the real ready count in the title instead of a fixture number', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 7 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('7 ready to review')).toBeTruthy());
  });

  it('shows a Review footer whenever readyCount is positive, even mid-sweep', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({
      data: { status: 'reviewing', readyCandidates: 10, pendingClusters: 51 },
      error: null,
    });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('10 ready to review')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-review')).toBeTruthy();
  });

  it('scrolls, applies the real safe-area insets, and gives the footer the sticky-footer treatment', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 3 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress-scroll')).toBeTruthy());

    const tree = screen.toJSON();
    const outer = Array.isArray(tree) ? tree[0] : tree;
    const outerStyle = [outer.props.style].flat(Infinity).filter(Boolean);
    expect(outerStyle).toEqual(expect.arrayContaining([expect.objectContaining({ paddingTop: TEST_INSETS.top })]));

    const footer = screen.getByTestId('gallery-import-progress-footer');
    const footerStyle = [footer.props.style].flat(Infinity).filter(Boolean);
    expect(footerStyle).toEqual(expect.arrayContaining([
      expect.objectContaining({ paddingBottom: TEST_INSETS.bottom + getStickyFooterBottomPadding(TEST_INSETS.bottom) }),
    ]));
    expect(footerStyle.some((entry: any) => entry?.backgroundColor)).toBe(true);
    expect(footerStyle.some((entry: any) => entry?.borderTopWidth > 0 && entry?.borderTopColor)).toBe(true);
  });

  it('sweeps progress copy for banned words and em-dashes/double-hyphens', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 3 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress')).toBeTruthy());
    const visibleText = collectRenderedText(screen.toJSON()).join(' ').toLowerCase();
    for (const banned of ['import', 'upload', 'scan', 'checkpointed', 'your place is saved', '30 days', '—', '--']) {
      expect(visibleText).not.toContain(banned);
    }
  });

  it('shows the "Safe to close"/"Keep Momora open" pill exactly once, never both at the same time', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 3 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress')).toBeTruthy());
    expect(screen.getByText('Safe to close')).toBeTruthy();
    expect(screen.queryByText('Keep Momora open')).toBeNull();
  });
});
