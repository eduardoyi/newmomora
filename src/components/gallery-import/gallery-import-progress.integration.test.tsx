import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { GalleryImportProgress } from '@/components/gallery-import/gallery-import-progress';
import { getStickyFooterBottomPadding } from '@/components/keyboard-sticky-shell';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useIsOnline } from '@/lib/connectivity';
import * as galleryService from '@/services/gallery-import';
import {
  GalleryImportEmptyLibraryError,
  GalleryImportServiceRequestError,
  resumeGalleryImportRunner,
} from '@/services/gallery-import-runner';
import { clearGalleryImportLiveProgress, markGalleryImportRunnerInactive, publishGalleryImportLiveProgress } from '@/utils/gallery-import-live-progress';
import { clearGalleryImportPendingStart, setGalleryImportPendingStart } from '@/utils/gallery-import-pending-start';
import { beginGalleryImportPipeline } from '@/utils/gallery-import-pipeline';

let mockCheckpoint: any = null;

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), setParams: jest.fn() } }));
// See gallery-import-trust.test.tsx for why this simulates real inset math
// instead of a dumb pass-through -- it lets a dropped/doubled safe-area
// application fail a real assertion. Unlike the entry/trust/empty/exception
// test files, this one does NOT stub KeyboardStickyShell away, so the same
// real ScrollView/sticky-footer/safe-area machinery is exercised here too.
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
jest.mock('@/services/gallery-import-runner', () => {
  class GalleryImportWaitingForWifiErrorMock extends Error {}
  class GalleryImportEmptyLibraryErrorMock extends Error {}
  class GalleryImportServiceRequestErrorMock extends Error {
    code?: string;
    constructor(message: string, code?: string) { super(message); this.code = code; }
  }
  return {
    GalleryImportWaitingForWifiError: GalleryImportWaitingForWifiErrorMock,
    GalleryImportEmptyLibraryError: GalleryImportEmptyLibraryErrorMock,
    GalleryImportServiceRequestError: GalleryImportServiceRequestErrorMock,
    resumeGalleryImportRunner: jest.fn(async () => undefined),
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
    (useFamily as jest.Mock).mockReturnValue({ role: 'owner', familyId: 'family-1', isLoading: false });
    (useBilling as jest.Mock).mockReturnValue({ status: { has_write_access: true, has_ever_had_access: true } });
    (useIsOnline as jest.Mock).mockReturnValue(true);
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 1 }, error: null });
  });

  afterEach(() => {
    clearGalleryImportLiveProgress('run-1');
    markGalleryImportRunnerInactive('run-1');
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
      await waitFor(() => expect(screen.getByText('240 photos so far')).toBeTruthy());
      expect(screen.getByText('Step 1 of 3')).toBeTruthy();
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
      await waitFor(() => expect(screen.getByText('10 photos so far')).toBeTruthy());
      act(() => { setGalleryImportPendingStart({ status: 'starting', scannedAssetCount: 250 }); });
      await waitFor(() => expect(screen.getByText('250 photos so far')).toBeTruthy());
    });

    it('offers cellular data for a pre-run-id Wi-Fi wait, and retries the whole pipeline in place -- never bouncing back to entry', async () => {
      const { router } = jest.requireMock('expo-router');
      setGalleryImportPendingStart({ status: 'waitingWifi', permissionMode: 'full' });
      const screen = render(<GalleryImportProgress />);
      await waitFor(() => expect(screen.getByText('Waiting for', { exact: false })).toBeTruthy());
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
      (useFamily as jest.Mock).mockReturnValue({ role: 'owner', familyId: 'family-1', isLoading: false });
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

  // Regression for the critical device-tested bug: a real 306-photo run
  // reached server status 'reviewing' (10/10 chunks, 60 candidates staged,
  // verified by direct DB query) but this screen stayed on "Writing the
  // drafts" for 10+ minutes. Root cause: the runner's last published live-
  // progress event for a completed run is always `{ stage: 'dispatching' }`
  // (retained forever, never cleared -- see gallery-import-live-progress.ts),
  // and the old priority order in gallery-import-progress-stage.ts checked
  // that stale snapshot *before* the server status the ~8s poll below keeps
  // current. This exercises the real poll interval end to end, not just the
  // pure derive function, and asserts the transition happens on the *same*
  // rendered instance (no remount).
  it('transitions from processing to ready once the ~8s poll observes reviewing, without remounting, even with a stale live.dispatching snapshot', async () => {
    jest.useFakeTimers();
    try {
      publishGalleryImportLiveProgress('run-1', { stage: 'dispatching', completed: 10, total: 10 });
      mockCheckpoint = checkpoint({ status: 'processing' });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing', readyCandidates: 0 }, error: null });

      const screen = render(<GalleryImportProgress runId="run-1" />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('Step 3 of 3')).toBeTruthy();
      expect(screen.queryByTestId('gallery-import-review')).toBeNull();

      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 60, pendingClusters: 0 }, error: null });
      await act(async () => { await jest.advanceTimersByTimeAsync(8_000); });

      expect(screen.getByText('60 moments,', { exact: false })).toBeTruthy();
      expect(screen.getByTestId('gallery-import-review')).toBeTruthy();
      // Same rendered instance throughout -- this was a re-render off the
      // poll, not a navigation/remount.
      expect(screen.getByTestId('gallery-import-progress')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('folds expired into the staged expired view instead of a bare terminal notice', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'expired', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('These have', { exact: false })).toBeTruthy());
    expect(screen.getByTestId('gallery-import-stage-action-Look through my photos again')).toBeTruthy();
  });

  // Device-tested finding: users thought they had to sit and watch this
  // screen. The "go check your journal" line only belongs on stages that
  // keep working while Momora stays open (scanning/preparing/uploading/
  // processing) -- never the waiting-for-Wi-Fi or terminal stages, where it
  // would either be redundant or actively wrong (waitingWifi is paused;
  // nothing is "working" for the deck to check on).
  const LEAVE_HINT = 'Feel free to check your journal while it works.';
  it('offers the leave-hint on an in-progress stage but not on the waiting or terminal ones', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing', readyCandidates: 0 }, error: null });
    const processing = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(processing.getByText('Step 3 of 3')).toBeTruthy());
    expect(processing.getByText(LEAVE_HINT, { exact: false })).toBeTruthy();
    processing.unmount();

    mockCheckpoint = checkpoint({ status: 'paused', chunks: [{ ordinal: 0, status: 'registered', clusters: [{ clusterSignature: 'a', assetTokens: ['x'] }], previewUploads: [] }] });
    const waiting = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(waiting.getByText('Waiting for', { exact: false })).toBeTruthy());
    expect(waiting.queryByText(LEAVE_HINT, { exact: false })).toBeNull();
    waiting.unmount();

    mockCheckpoint = checkpoint();
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'expired', readyCandidates: 0 }, error: null });
    const expired = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(expired.getByText('These have', { exact: false })).toBeTruthy());
    expect(expired.queryByText(LEAVE_HINT, { exact: false })).toBeNull();
  });

  it('shows the partial-failure stage with real ready counts, not the old ambiguous message', async () => {
    const { router } = jest.requireMock('expo-router');
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'failed', readyCandidates: 4 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-stage-action-Try the rest again')).toBeTruthy());
    expect(screen.queryByText(/family access or import eligibility changed/)).toBeNull();
    // Round 4 audit finding: a partial failure with real ready candidates
    // used to offer only "Try the rest again" -- no way to reach the
    // suggestions already sitting in the deck from this screen.
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

  it('opens the cellular confirm sheet for an already-running import and resumes the runner in place, never bouncing through entry', async () => {
    const { router } = jest.requireMock('expo-router');
    mockCheckpoint = checkpoint({ status: 'paused', chunks: [{ ordinal: 0, status: 'registered', clusters: [{ clusterSignature: 'a', assetTokens: ['x'] }], previewUploads: [] }] });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Waiting for', { exact: false })).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-stage-action-Use cellular data instead'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-cellular-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-confirm-cellular'));
    await waitFor(() => expect(resumeGalleryImportRunner).toHaveBeenCalledWith(expect.objectContaining({ allowCellular: true, runId: 'run-1' })));
    expect(router.replace).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: expect.stringContaining('/gallery-import') }));
    expect(router.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: expect.stringContaining('/gallery-import') }));
  });

  it('opens the stop-confirm sheet with the four facts and stops via the real cancel service, not a native Alert', async () => {
    (galleryService.cancelGalleryImportRun as jest.Mock).mockResolvedValue({ data: { cancelled: true }, error: null });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'processing', readyCandidates: 0 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-stop')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-stop'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-stop-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-confirm-stop'));
    await waitFor(() => expect(galleryService.cancelGalleryImportRun).toHaveBeenCalledWith({ runId: 'run-1', capability: 'cap' }));
  });

  it('ignores a late status response after progress unmounts', async () => {
    let resolveFirstStatus: ((value: unknown) => void) | undefined;
    (galleryService.getGalleryImportRun as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { resolveFirstStatus = resolve; }));
    const first = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(galleryService.getGalleryImportRun).toHaveBeenCalledTimes(1));
    first.unmount();

    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'expired', readyCandidates: 0 }, error: null });
    const second = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(second.getByTestId('gallery-import-stage-action-Look through my photos again')).toBeTruthy());
    await act(async () => { resolveFirstStatus?.({ data: { status: 'reviewing', readyCandidates: 4 }, error: null }); });
    expect(second.getByTestId('gallery-import-stage-action-Look through my photos again')).toBeTruthy();
  });

  it('shows the real ready count in the title instead of a fixture number', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 7 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('7 moments,', { exact: false })).toBeTruthy());
  });

  // Round 4: the ready stage's partial-vs-done split now reads server truth
  // (run.pendingClusters), never the local checkpoint plan -- a resume/stall
  // leaves that local plan stale (device-observed phantom "+51 coming").
  it('shows the honest partial-ready state when the server reports clusters still pending', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({
      data: { status: 'reviewing', readyCandidates: 10, pendingClusters: 51 },
      error: null,
    });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('First moments are ready')).toBeTruthy());
    expect(screen.queryByText('All done looking')).toBeNull();
    expect(screen.getByText('10 moments,', { exact: false })).toBeTruthy();
  });

  it('shows the fully-done ready state once the server confirms zero clusters pending', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({
      data: { status: 'reviewing', readyCandidates: 10, pendingClusters: 0 },
      error: null,
    });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByText('All done looking')).toBeTruthy());
    expect(screen.queryByText('First moments are ready')).toBeNull();
  });

  it('scrolls, applies the real safe-area insets, and gives the privacy link a tappable affordance that opens the sheet', async () => {
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
    // The shared gi.stickyFooterSurface hairline top border, so content
    // reads as sliding under a deliberate floating surface.
    expect(footerStyle.some((entry: any) => entry?.borderTopWidth > 0 && entry?.borderTopColor)).toBe(true);

    fireEvent.press(screen.getByTestId('gallery-import-privacy-link'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-privacy-sheet')).toBeTruthy());
  });

  it('sweeps progress copy for banned words, the old checkpointed-language register, AI-partner mentions, the no-title product decision, and em-dashes/double-hyphens', async () => {
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 3 }, error: null });
    const screen = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-progress')).toBeTruthy());
    const visibleText = collectRenderedText(screen.toJSON()).join(' ').toLowerCase();
    for (const banned of ['import', 'upload', 'scan', 'checkpointed', 'does not promise', 'ai partner', 'ai service', 'title and caption', '—', '--']) {
      expect(visibleText).not.toContain(banned);
    }
  });

  it('never duplicates "Safe to close Momora. Your place is saved." between the heading and the body', async () => {
    for (const [status, readyCandidates] of [['processing', 0], ['reviewing', 3]] as const) {
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status, readyCandidates }, error: null });
      const screen = render(<GalleryImportProgress runId="run-1" />);
      await waitFor(() => expect(screen.getByTestId('gallery-import-progress')).toBeTruthy());
      const visibleText = collectRenderedText(screen.toJSON()).join(' | ');
      const occurrences = visibleText.split('Safe to close Momora. Your place is saved.').length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
      screen.unmount();
    }
  });
});
