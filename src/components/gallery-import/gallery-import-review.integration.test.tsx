import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import {
  GalleryImportReview,
  resetGalleryImportReviewSessionCache,
} from '@/components/gallery-import/gallery-import-review';
import * as galleryService from '@/services/gallery-import';

let mockCheckpoint: any = null;

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() } }));
jest.mock('expo-image', () => { const { View: MockView } = require('react-native'); return { Image: (props: any) => <MockView testID={props.testID} /> }; });
jest.mock('react-native-safe-area-context', () => { const { View: MockView } = require('react-native'); return { SafeAreaView: MockView, useSafeAreaInsets: () => ({ bottom: 28, top: 0, left: 0, right: 0 }) }; });
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
jest.mock('@/hooks/use-family', () => ({ useFamily: () => ({ familyId: 'family-1', role: 'owner' }) }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/services/gallery-import', () => ({
  completeGalleryImportRun: jest.fn(), getGalleryImportCandidates: jest.fn(),
  getGalleryImportRun: jest.fn(), setGalleryImportCandidateSkip: jest.fn(),
}));
jest.mock('@/utils/gallery-import-e2e-adapter', () => ({ getGalleryImportE2eAdapter: () => undefined }));
jest.mock('@/utils/gallery-import-scanner', () => ({
  createExpoGalleryMediaLibraryAdapter: () => ({ resolveAssetUri: jest.fn(async () => 'file://local/photo') }),
}));
jest.mock('@/utils/gallery-import-checkpoint', () => ({
  loadGalleryImportCheckpoint: jest.fn(async () => mockCheckpoint), clearGalleryImportCheckpoint: jest.fn(), clearGalleryImportPreviewCache: jest.fn(),
  updateGalleryImportCheckpoint: jest.fn(async (_u: string, _f: string, _r: string, update: any) => { mockCheckpoint = update(mockCheckpoint); return mockCheckpoint; }),
}));

const mockRouter = jest.requireMock('expo-router').router as { back: jest.Mock; push: jest.Mock; replace: jest.Mock };

const candidate = { id: 'candidate-1', caption: 'A small day.', memoryDate: '2025-05-12', selectedAssetTokens: ['asset-1'], familyMemberIds: [], status: 'ready' as const, previewUrls: ['https://preview'] };
function candidateAt(index: number, status: 'ready' | 'skipped' = 'ready') { return { ...candidate, id: `candidate-${index}`, caption: `Moment ${index}`, status }; }
function checkpoint(overrides: Record<string, unknown> = {}) { return { version: 2, userId: 'user-1', familyId: 'family-1', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'reviewing', assetByToken: {}, uploadedAssetTokens: [], clusterSignatures: [], chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now', ...overrides }; }
// Round 4: server truth (run status + pendingClusters) now drives whether
// more is coming, never the local checkpoint's chunks. Default mirrors the
// old "nothing outstanding" default (comingIndicator 'none') so tests that
// don't care about round 4 specifically keep behaving like before.
function mockRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1', familyId: 'family-1', status: 'reviewing', reviewExpiresAt: null,
    limits: { maxClusters: 20, maxAssetsPerCluster: 6, maxChunks: 4 },
    readyCandidates: 0, pendingClusters: 0,
    ...overrides,
  };
}

async function openSetAsideSheet(screen: ReturnType<typeof render>) {
  fireEvent.press(screen.getByTestId('gallery-import-set-aside-pill'));
  await waitFor(() => expect(screen.getByTestId('gallery-import-set-aside-sheet')).toBeTruthy());
}

describe('gallery import review deck', () => {
  beforeEach(() => {
    jest.clearAllMocks(); mockCheckpoint = checkpoint();
    resetGalleryImportReviewSessionCache();
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [candidate] }, error: null });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun(), error: null });
    // Mirror the real endpoint: set-gallery-import-candidate-skip responds
    // WITHOUT preview urls (only get-candidates signs them).
    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockResolvedValue({ data: { candidate: { ...candidate, status: 'skipped', previewUrls: [] } }, error: null });
  });

  it('keeps the deck read-only and requires explicit set-aside then bring back from the sheet', async () => {
    const screen = render(<GalleryImportReview runId="run-1" />); await waitFor(() => expect(screen.getByTestId('gallery-import-set-aside')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-caption')).toBeNull();
    fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenCalledWith(expect.objectContaining({ skip: true })));
    // The set-aside list lives in the "Set aside · N" sheet, not under the deck.
    await waitFor(() => expect(screen.getByTestId('gallery-import-set-aside-pill')).toBeTruthy());
    expect(screen.getByText('Set aside · 1')).toBeTruthy();
    // The sheet's quiet re-sign fetch returns the post-skip server state.
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [{ ...candidate, status: 'skipped' }] }, error: null });
    await openSetAsideSheet(screen);
    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockResolvedValueOnce({ data: { candidate: { ...candidate, status: 'ready', previewUrls: [] } }, error: null });
    expect(screen.queryByText('Restore')).toBeNull();
    fireEvent.press(screen.getByTestId('gallery-import-restore-candidate-1'));
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenLastCalledWith(expect.objectContaining({ skip: false })));
  });

  it('keeps preview images through the aside sheet and bring back even though the skip endpoint returns none', async () => {
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-hero')).toBeTruthy());

    fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenCalledWith(expect.objectContaining({ skip: true })));

    // Opening the sheet re-signs the short-lived preview urls through
    // get-candidates -- the only endpoint that produces them.
    const callsBeforeSheet = (galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length;
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [{ ...candidate, status: 'skipped', previewUrls: ['https://re-signed'] }] },
      error: null,
    });
    await openSetAsideSheet(screen);
    expect((galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length).toBe(callsBeforeSheet + 1);
    // Symptom (a): the aside row renders its photo, not an empty square.
    await waitFor(() => expect(screen.getByTestId('gallery-import-aside-thumb-candidate-1')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-aside-thumb-empty-candidate-1')).toBeNull();

    // Symptom (b): bring back -- the restore response also carries no urls,
    // so the merge must keep the re-signed ones for the returning card. The
    // mutation itself lands before bring back's own quiet re-sign fires, so
    // get-candidates now reflects the server's post-restore 'ready' status.
    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockResolvedValueOnce({ data: { candidate: { ...candidate, status: 'ready', previewUrls: [] } }, error: null });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [{ ...candidate, status: 'ready', previewUrls: ['https://re-signed'] }] },
      error: null,
    });
    fireEvent.press(screen.getByTestId('gallery-import-restore-candidate-1'));
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenLastCalledWith(expect.objectContaining({ skip: false })));
    fireEvent.press(screen.getByTestId('gallery-import-set-aside-sheet-close'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-hero')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-hero-fallback')).toBeNull();
  });

  it('re-signs the preview url again on bring back itself, not only from opening the sheet', async () => {
    // Root cause: the sheet's own quiet re-sign (openAsideSheet) only covers
    // the moment it is opened. A signed preview url is short-lived, and
    // someone can sit on an open sheet for a while before tapping Bring
    // back, so bring back must trigger its own quiet re-sign rather than
    // trust whatever was signed when the sheet first opened.
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-hero')).toBeTruthy());

    fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenCalledWith(expect.objectContaining({ skip: true })));

    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [{ ...candidate, status: 'skipped', previewUrls: ['https://re-signed-at-open'] }] },
      error: null,
    });
    await openSetAsideSheet(screen);
    const callsAfterOpen = (galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length;

    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockResolvedValueOnce({ data: { candidate: { ...candidate, status: 'ready', previewUrls: [] } }, error: null });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [{ ...candidate, status: 'ready', previewUrls: ['https://re-signed-on-restore'] }] },
      error: null,
    });
    fireEvent.press(screen.getByTestId('gallery-import-restore-candidate-1'));
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenLastCalledWith(expect.objectContaining({ skip: false })));
    // A second, independent re-sign fired for the restore itself.
    await waitFor(() => expect((galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length).toBe(callsAfterOpen + 1));

    fireEvent.press(screen.getByTestId('gallery-import-set-aside-sheet-close'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-hero')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-hero-fallback')).toBeNull();
  });

  it('gives every deck-surface footer the shared sticky-footer treatment', async () => {
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-action-area')).toBeTruthy());
    const flattened = StyleSheet.flatten(screen.getByTestId('gallery-import-action-area').props.style);
    expect(flattened.borderTopWidth).toBeGreaterThan(0);
    expect(flattened.borderTopColor).toBeTruthy();
    expect(flattened.backgroundColor).toBeTruthy();
  });

  it('advances the deterministic ready queue once per skip and decrements progress on bring back', async () => {
    const ordered = [candidateAt(1), candidateAt(2), candidateAt(3), candidateAt(4)];
    // Stateful server double: skip/restore mutate status, get-candidates
    // reflects it (so the sheet's quiet re-sign fetch stays truthful), and the
    // skip endpoint never returns preview urls, like the real one.
    const statusById: Record<string, 'ready' | 'skipped'> = {};
    (galleryService.getGalleryImportCandidates as jest.Mock).mockImplementation(async () => ({
      data: { candidates: ordered.map((item) => ({ ...item, status: statusById[item.id] ?? 'ready' })) },
      error: null,
    }));
    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockImplementation(async ({ candidateId, skip }) => {
      statusById[candidateId] = skip ? 'skipped' : 'ready';
      return {
        data: { candidate: { ...ordered.find((item) => item.id === candidateId)!, status: skip ? 'skipped' : 'ready', previewUrls: [] } },
        error: null,
      };
    });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Moment 1')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Suggestion 1 of 4');

    fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
    await waitFor(() => expect(screen.getByText('Moment 2')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Suggestion 2 of 4');

    fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
    await waitFor(() => expect(screen.getByText('Moment 3')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Suggestion 3 of 4');

    await openSetAsideSheet(screen);
    fireEvent.press(screen.getByTestId('gallery-import-restore-candidate-1'));
    await waitFor(() => expect(screen.getByText('Moment 1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-set-aside-sheet-close'));
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Suggestion 2 of 4');
  });

  // Device-tested finding: after Set aside (button or swipe), the same card
  // could re-render as the front card for a fraction of a second before the
  // next one appeared. The 240ms exit animation finishes well before the
  // setGalleryImportCandidateSkip mutation does, and `candidates` state still
  // carries the acted-on card's pre-mutation 'ready' status for that whole
  // window -- this holds the mutation open past the animation and asserts
  // the acted-on card is never shown again from the moment the animation
  // ends, not only once the mutation eventually resolves.
  it('never shows the acted-on card again once its exit animation ends, even while its skip mutation is still in flight', async () => {
    const ordered = [candidateAt(1), candidateAt(2)];
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: ordered }, error: null });
    let resolveSkip: ((value: unknown) => void) | undefined;
    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockImplementation(
      () => new Promise((resolve) => { resolveSkip = resolve; }),
    );

    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Moment 1')).toBeTruthy());

    jest.useFakeTimers();
    try {
      fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
      // Mid-exit (before the 240ms animation completes): unchanged so far.
      expect(screen.getByText('Moment 1')).toBeTruthy();

      // The exit animation finishes and the mutation starts, but is held
      // open (network still "in flight") -- the front card must already
      // have advanced, not wait on the network round trip.
      await act(async () => { await jest.advanceTimersByTimeAsync(240); });
      expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenCalledWith(
        expect.objectContaining({ candidateId: 'candidate-1', skip: true }),
      );
      expect(screen.getByText('Moment 2')).toBeTruthy();
      expect(screen.queryByText('Moment 1')).toBeNull();
      // Round 4, device-tested finding (card promotion jank): the freshly
      // promoted card (candidate-2) must not inherit candidate-1's still-in-
      // flight "Set aside" exit styling -- the parent only ever passes
      // exitDirection for the candidate actually exiting (candidate-1, not
      // the newly-promoted current card), so the stamp reads as untouched.
      expect(StyleSheet.flatten(screen.getByTestId('gallery-import-intent-aside').props.style).opacity).not.toBe(1);
      expect(StyleSheet.flatten(screen.getByTestId('gallery-import-intent-keep').props.style).opacity).not.toBe(1);

      // The mutation resolves well after the animation ended -- this must
      // not flicker candidate-1 back onto the front of the deck.
      await act(async () => {
        resolveSkip?.({ data: { candidate: { ...ordered[0], status: 'skipped', previewUrls: [] } }, error: null });
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Moment 2')).toBeTruthy();
      expect(screen.queryByText('Moment 1')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a 59-card sheet list virtualized and preserves the unique total after an approval remount', async () => {
    const remaining = [candidateAt(60), ...Array.from({ length: 59 }, (_, index) => candidateAt(index + 1, 'skipped'))];
    mockCheckpoint = checkpoint({ deckCursor: 59, deckTotal: 60 });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: remaining }, error: null });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Moment 60')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Suggestion 60 of 60');
    expect(screen.getByText('Set aside · 59')).toBeTruthy();
    await openSetAsideSheet(screen);
    // A FlatList virtualizes the long list instead of mounting 59 rows.
    expect(screen.getByTestId('gallery-import-set-aside-scroll')).toBeTruthy();
    expect(screen.getByTestId('gallery-import-set-aside-scroll').props.data).toHaveLength(59);
  });

  it('commits keep on a past-threshold swipe and leaves the card in place below threshold', async () => {
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-deck-card')).toBeTruthy());

    // Below the 92px commit threshold: nothing fires.
    await act(async () => {
      fireGestureHandler(getByGestureTestId('gallery-import-deck-pan'), [
        { state: State.BEGAN, translationX: 0, velocityX: 0 },
        { state: State.ACTIVE, translationX: 40, velocityX: 0 },
        { state: State.END, translationX: 40, velocityX: 0 },
      ]);
    });
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(galleryService.setGalleryImportCandidateSkip).not.toHaveBeenCalled();

    // Past the threshold to the right: Keep opens the composer as a push.
    await act(async () => {
      fireGestureHandler(getByGestureTestId('gallery-import-deck-pan'), [
        { state: State.BEGAN, translationX: 0, velocityX: 0 },
        { state: State.ACTIVE, translationX: 120, velocityX: 0 },
        { state: State.END, translationX: 120, velocityX: 0 },
      ]);
    });
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/approve', params: { runId: 'run-1', candidateId: 'candidate-1' } }));
    expect(galleryService.setGalleryImportCandidateSkip).not.toHaveBeenCalled();
  });

  it('commits set aside on a past-threshold left swipe', async () => {
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-deck-card')).toBeTruthy());
    await act(async () => {
      fireGestureHandler(getByGestureTestId('gallery-import-deck-pan'), [
        { state: State.BEGAN, translationX: 0, velocityX: 0 },
        { state: State.ACTIVE, translationX: -120, velocityX: 0 },
        { state: State.END, translationX: -120, velocityX: 0 },
      ]);
    });
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 'candidate-1', skip: true })));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('exposes screen-reader actions that keep and set aside without the gesture', async () => {
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-deck-card')).toBeTruthy());
    const card = screen.getByTestId('gallery-import-deck-card');
    expect(card.props.accessibilityActions).toEqual([
      { name: 'keep', label: 'Keep this' },
      { name: 'set_aside', label: 'Set aside' },
      { name: 'choose_photos', label: 'Choose photos' },
      { name: 'show_set_aside', label: 'Show set-aside list' },
    ]);
    expect(card.props.accessibilityLabel).toBe('Suggestion 1 of 1. Monday, May 12, 2025. A small day.');

    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'keep' } });
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ candidateId: 'candidate-1' }) })));

    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'set_aside' } });
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenCalledWith(expect.objectContaining({ skip: true })));
  });

  it('shows segment ticks, the +N coming indicator, and the kept/set-aside ledger from the server-reported pendingClusters count', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 3, deckTotal: 6 });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun({ pendingClusters: 2 }), error: null });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [candidateAt(4), candidateAt(5), candidateAt(6), candidateAt(1, 'skipped')] },
      error: null,
    });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-deck-card')).toBeTruthy());
    // deckTotal = 4 live candidates + (cursor 3 − 1 skipped) already-approved.
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Suggestion 4 of 6');
    expect(screen.getByTestId('gallery-import-still-coming')).toBeTruthy();
    expect(screen.getByText('+2 coming')).toBeTruthy();
    // deckCursor 3 with 1 skipped = 2 kept.
    expect(screen.getByTestId('gallery-import-ledger').props.accessibilityLabel).toBe('2 kept, 1 set aside, 2 still coming');
  });

  // Round 4: when the server cannot (yet) compute pendingClusters, or the
  // run has not finished scanning/registering, show qualitative "more
  // coming" copy -- never a guessed or stale digit.
  it('shows qualitative "more coming" copy (no number) when pendingClusters is not yet known', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 0, deckTotal: 1 });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun({ pendingClusters: null }), error: null });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-deck-card')).toBeTruthy());
    expect(screen.getByText('more coming')).toBeTruthy();
    expect(screen.getByTestId('gallery-import-ledger').props.accessibilityLabel).toBe('0 kept, 0 set aside, more still coming');
  });

  it('offers a rest point after six keeps, resumes on Keep going, and exits without completing the run', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 6, deckTotal: 9 });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [candidateAt(7), candidateAt(8), candidateAt(9)] },
      error: null,
    });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-rest-point')).toBeTruthy());
    expect(screen.getByText(/That is 6/)).toBeTruthy();
    expect(screen.getByText('Your place is saved')).toBeTruthy();
    expect(screen.getByText('Keep going · 3 ready')).toBeTruthy();
    // The rest-point footer gets the same sticky-footer treatment as the
    // deck and done state (defect #2 audit).
    expect(StyleSheet.flatten(screen.getByTestId('gallery-import-action-area').props.style).borderTopWidth).toBeGreaterThan(0);

    fireEvent.press(screen.getByTestId('gallery-import-rest-continue'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-deck-card')).toBeTruthy());
    expect(galleryService.completeGalleryImportRun).not.toHaveBeenCalled();
  });

  it('leaves the rest point to the timeline without completing the run', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 6, deckTotal: 9 });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [candidateAt(7)] },
      error: null,
    });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-rest-point')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-rest-stop'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline');
    expect(galleryService.completeGalleryImportRun).not.toHaveBeenCalled();
  });

  it('shows the done state with kept count, 30-day set-aside copy, and a route into the sheet', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 4, deckTotal: 4 });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [candidateAt(2, 'skipped')] },
      error: null,
    });
    (galleryService.completeGalleryImportRun as jest.Mock).mockResolvedValue({ data: { completed: true }, error: null });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-done')).toBeTruthy());
    // deckCursor 4 with 1 skipped = 3 kept.
    expect(screen.getByText(/3 memories,/)).toBeTruthy();
    expect(screen.getByText(/one quiet summary, not 3 notifications/)).toBeTruthy();
    expect(screen.getByText('1 set aside')).toBeTruthy();
    expect(screen.getByText('Kept for 30 days if you change your mind. They will not come back in a future look.')).toBeTruthy();
    expect(screen.queryByText(/future import/)).toBeNull();
    // Kept > 0: the CTA still promises something to see, and the
    // "will not come back" sentence lives exactly once (the aside-pill
    // line above), not duplicated into the body copy too.
    expect(screen.getByText('See them in my journal')).toBeTruthy();
    expect(screen.queryByText('Go to my journal')).toBeNull();
    expect(screen.getAllByText(/will not come back in a future look/).length).toBe(1);
    // The done-state footer gets the same sticky-footer treatment as the
    // deck and rest point (defect #2 audit).
    expect(StyleSheet.flatten(screen.getByTestId('gallery-import-action-area').props.style).borderTopWidth).toBeGreaterThan(0);

    fireEvent.press(screen.getByTestId('gallery-import-done-aside'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-set-aside-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-set-aside-sheet-close'));

    fireEvent.press(screen.getByTestId('gallery-import-complete'));
    await waitFor(() => expect(galleryService.completeGalleryImportRun).toHaveBeenCalledWith({ runId: 'run-1', capability: 'cap' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline');
  });

  // Device screenshot: "See them in my journal" reads wrong when nothing was
  // kept (nothing to "see"), and the "will not come back" sentence appeared
  // twice on screen -- once in the body, once in the aside-pill line right
  // below it.
  it('shows a "Go to my journal" CTA and deduplicated copy when everything was set aside (nothing kept)', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 2, deckTotal: 2 });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [candidateAt(1, 'skipped'), candidateAt(2, 'skipped')] },
      error: null,
    });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-done')).toBeTruthy());
    // stillComing is 0 (default checkpoint's only chunk is dispatched, no
    // clusters) -- the true done state, not the between-batches one.
    expect(screen.queryByTestId('gallery-import-between-batches')).toBeNull();
    expect(screen.getByText('All caught up.')).toBeTruthy();
    expect(screen.getByText('Nothing new to look at right now.')).toBeTruthy();
    expect(screen.getByText('Go to my journal')).toBeTruthy();
    expect(screen.queryByText('See them in my journal')).toBeNull();
    // The "will not come back" sentence lives once, in the aside-pill line.
    expect(screen.getByText('Kept for 30 days if you change your mind. They will not come back in a future look.')).toBeTruthy();
    expect(screen.getAllByText(/will not come back in a future look/).length).toBe(1);

    fireEvent.press(screen.getByTestId('gallery-import-complete'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline'));
    expect(galleryService.completeGalleryImportRun).toHaveBeenCalledWith({ runId: 'run-1', capability: 'cap' });
  });

  function stillComingCheckpoint(overrides: Record<string, unknown> = {}) {
    return checkpoint({ deckCursor: 1, deckTotal: 2, ...overrides });
  }

  // Round 3+4, device-tested finding: chunks now genuinely keep streaming in
  // for minutes after 'reviewing' (server truth, not the local checkpoint
  // plan -- round 4), so a user who reviews faster than the AI writes can
  // empty the queue with real work still coming. "All caught up" would be
  // false in that case, and the server still permits completing a run with
  // in-flight chunks -- this screen must not offer to.
  it('shows a between-batches waiting state instead of "done" when the queue is empty but more is still coming', async () => {
    mockCheckpoint = stillComingCheckpoint();
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun({ pendingClusters: 1 }), error: null });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [candidateAt(1, 'skipped')] },
      error: null,
    });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-between-batches')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-done')).toBeNull();
    expect(screen.getByText('More on the way')).toBeTruthy();
    expect(screen.getByText(/1 more suggestion/)).toBeTruthy();

    // The only exit here is plain navigation -- it must never complete the
    // run while chunks are still outstanding.
    fireEvent.press(screen.getByTestId('gallery-import-between-batches-journal'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline'));
    expect(galleryService.completeGalleryImportRun).not.toHaveBeenCalled();
  });

  // Round 4: the old empty/refreshing "Writing drafts." + manual "Check
  // again" screen is gone -- an empty queue is always the between-batches
  // waiting room (or done), never a dead end requiring a manual tap.
  it('never shows the old manual "Check again" empty screen', async () => {
    mockCheckpoint = stillComingCheckpoint();
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun({ pendingClusters: 1 }), error: null });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [candidateAt(1, 'skipped')] },
      error: null,
    });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-between-batches')).toBeTruthy());
    expect(screen.queryByText('Writing drafts.')).toBeNull();
    expect(screen.queryByText('Check again')).toBeNull();
  });

  it('polls quietly every ~9s for candidates and server run status while the run is reviewing (even after pendingClusters settles), and stops once the run is truly terminal', async () => {
    mockCheckpoint = stillComingCheckpoint();
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun({ pendingClusters: 1 }), error: null });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
      data: { candidates: [candidateAt(1, 'skipped')] },
      error: null,
    });

    // Fake timers must be active *before* mount: the poll is scheduled by an
    // effect that runs on mount, not by a later user action, so switching to
    // fake timers only after render (as elsewhere in this file) would leave
    // that first setInterval running for real and untouched by
    // advanceTimersByTimeAsync below. Promise microtasks (the mocked
    // checkpoint/candidates/run fetches) are unaffected by the timer mock,
    // so the initial load still settles via a plain flush.
    jest.useFakeTimers();
    try {
      const screen = render(<GalleryImportReview runId="run-1" />);
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('gallery-import-between-batches')).toBeTruthy();
      const candidateCallsBeforePoll = (galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length;
      const runCallsBeforePoll = (galleryService.getGalleryImportRun as jest.Mock).mock.calls.length;

      await act(async () => { await jest.advanceTimersByTimeAsync(9_000); });
      expect((galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length).toBe(candidateCallsBeforePoll + 1);
      expect((galleryService.getGalleryImportRun as jest.Mock).mock.calls.length).toBe(runCallsBeforePoll + 1);

      // The rest lands and the server confirms nothing is pending anymore --
      // "done" becomes reachable, but the run is still 'reviewing' (not
      // truly terminal), so the poll must keep watching in case a
      // stalled/resumed chunk registers late (the 26-minute-gap scenario).
      (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({
        data: { candidates: [candidateAt(1, 'skipped'), candidateAt(2)] },
        error: null,
      });
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun({ pendingClusters: 0 }), error: null });
      await act(async () => { await jest.advanceTimersByTimeAsync(9_000); });
      expect(screen.getByTestId('gallery-import-deck-card')).toBeTruthy();
      expect(screen.queryByTestId('gallery-import-still-coming')).toBeNull();

      const candidateCallsAfterSettling = (galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length;
      const runCallsAfterSettling = (galleryService.getGalleryImportRun as jest.Mock).mock.calls.length;
      await act(async () => { await jest.advanceTimersByTimeAsync(9_000); });
      expect((galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length).toBe(candidateCallsAfterSettling + 1);
      expect((galleryService.getGalleryImportRun as jest.Mock).mock.calls.length).toBe(runCallsAfterSettling + 1);

      // Now the server confirms the run is genuinely terminal -- polling stops.
      (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun({ status: 'completed', pendingClusters: 0 }), error: null });
      await act(async () => { await jest.advanceTimersByTimeAsync(9_000); });
      const candidateCallsAfterTerminal = (galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length;
      const runCallsAfterTerminal = (galleryService.getGalleryImportRun as jest.Mock).mock.calls.length;
      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      expect((galleryService.getGalleryImportCandidates as jest.Mock).mock.calls.length).toBe(candidateCallsAfterTerminal);
      expect((galleryService.getGalleryImportRun as jest.Mock).mock.calls.length).toBe(runCallsAfterTerminal);
    } finally {
      jest.useRealTimers();
    }
  });

  // Round 4, device evidence: a run can be terminal (e.g. cancelled from
  // another device/screen) while this deck is still open with candidates
  // already reviewed. The done state must still be reachable (queue is
  // empty, comingIndicator is 'none' because the run is terminal), but
  // completing must not call the server -- complete_gallery_import_run (SQL)
  // requires status 'reviewing' and would just error for no reason; there is
  // nothing left to complete.
  it('reaches the done state for a terminal-but-not-completed run, and leaves without calling completeGalleryImportRun', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 1, deckTotal: 1 });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: mockRun({ status: 'cancelled', pendingClusters: null }), error: null });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [] }, error: null });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-done')).toBeTruthy());

    fireEvent.press(screen.getByTestId('gallery-import-complete'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline'));
    expect(galleryService.completeGalleryImportRun).not.toHaveBeenCalled();
  });

  it('keeps the locked deck copy: the verbatim hint line and a film strip that opens the day pool', async () => {
    mockCheckpoint = checkpoint({
      assetByToken: {
        'asset-1': { assetToken: 'asset-1', osAssetId: 'os-1', captureAtMs: Date.UTC(2025, 4, 12, 9, 0, 0), width: 100, height: 100, isFavorite: false },
        'asset-2': { assetToken: 'asset-2', osAssetId: 'os-2', captureAtMs: Date.UTC(2025, 4, 12, 10, 0, 0), width: 100, height: 100, isFavorite: false },
      },
      uploadedAssetTokens: ['asset-1', 'asset-2'],
    });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-deck-card')).toBeTruthy());
    expect(screen.getByText('Keeping opens the memory so you can change the words, photos, date and who is in it before it is saved.')).toBeTruthy();
    expect(screen.getByText('Monday, May 12, 2025')).toBeTruthy();
    // Never the raw ISO date anywhere on the deck (defect #3 guard).
    expect(screen.queryByText('2025-05-12')).toBeNull();
    expect(screen.getByText('1 photo chosen')).toBeTruthy();
    expect(screen.getByText('from 2 photos that day')).toBeTruthy();

    fireEvent.press(screen.getByTestId('gallery-import-film-strip'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-photo-chooser')).toBeTruthy());
    // Browse-only from the read-only deck.
    expect(screen.getByTestId('gallery-import-chooser-browse-hint')).toBeTruthy();
    expect(screen.queryByTestId('gallery-import-chooser-use')).toBeNull();
  });

  it.each(['uploading', 'finalizing', 'failed'] as const)('redirects a relaunched review with a %s outbox before rendering deck actions', async (status) => {
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status }] });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-outbox-redirect')).toBeTruthy());
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/approve', params: { runId: 'run-1', candidateId: 'candidate-1' } });
    expect(screen.queryByTestId('gallery-import-set-aside')).toBeNull();
    expect(screen.queryByTestId('gallery-import-keep')).toBeNull();
    expect(galleryService.getGalleryImportCandidates).not.toHaveBeenCalled();
    expect(galleryService.setGalleryImportCandidateSkip).not.toHaveBeenCalled();
  });
});
