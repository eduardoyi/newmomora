import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking, View } from 'react-native';

import { GALLERY_IMPORT_APPROVAL_STEP_TIMEOUT_MS, GalleryImportApproval, GalleryImportEntry, GalleryImportProgress, GalleryImportReview } from '@/components/gallery-import/gallery-import-flow';
import * as galleryService from '@/services/gallery-import';
import { startGalleryImportRunner } from '@/services/gallery-import-runner';

const mockAdapter = { getPermission: jest.fn(), requestPermission: jest.fn(), presentPermissionPicker: jest.fn(), isAssetAvailableLocally: jest.fn(), resolveAssetUri: jest.fn(), getAssetFilename: jest.fn() };
let mockCheckpoint: any = null;

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() } }));
jest.mock('expo-image', () => { const { View: MockView } = require('react-native'); return { Image: (props: any) => <MockView testID={props.testID} /> }; });
jest.mock('react-native-safe-area-context', () => { const { View: MockView } = require('react-native'); return { SafeAreaView: MockView, useSafeAreaInsets: () => ({ bottom: 28, top: 0, left: 0, right: 0 }) }; });
jest.mock('@/components/keyboard-sticky-shell', () => { const { View: MockView } = require('react-native'); return { KeyboardStickyShell: ({ children, footer, testID, footerTestID, footerKeyboardSticky = true }: any) => <MockView testID={testID}>{children}<MockView testID={footerKeyboardSticky ? 'mock-keyboard-sticky-footer' : 'mock-fixed-footer'}><MockView testID={footerTestID}>{footer}</MockView></MockView></MockView> }; });
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
jest.mock('@/hooks/use-family', () => ({ useFamily: () => ({ familyId: 'family-1', role: 'owner' }) }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: () => ({ members: [{ id: 'child-1', name: 'Ada' }] }) }));
jest.mock('@/utils/roles', () => ({ canEditFamilyContent: () => true }));
jest.mock('@/utils/gallery-import-e2e-adapter', () => ({ getGalleryImportE2eAdapter: () => undefined }));
jest.mock('@/utils/gallery-import-scanner', () => ({ createExpoGalleryMediaLibraryAdapter: () => mockAdapter, getGalleryPhotoPermissionState: (value: any) => value.state }));
jest.mock('@/utils/gallery-import-original', () => ({ getGalleryImportOriginalUpload: jest.fn(async () => ({ contentType: 'image/jpeg', byteLength: 12, aspectRatio: 1 })) }));
jest.mock('@/services/media', () => ({ uploadToPresignedUrl: jest.fn(async () => ({ error: null })) }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/services/gallery-import-runner', () => ({ GalleryImportWaitingForWifiError: class extends Error {}, galleryImportRunnerErrorMessage: (error: any) => error.message, startGalleryImportRunner: jest.fn(), resumeGalleryImportRunner: jest.fn(async () => undefined) }));
jest.mock('@/services/gallery-import', () => ({ beginGalleryImportApproval: jest.fn(), cancelGalleryImportRun: jest.fn(), completeGalleryImportRun: jest.fn(), finalizeGalleryImportCandidate: jest.fn(), getGalleryImportCandidates: jest.fn(), getGalleryImportRun: jest.fn(), getGalleryImportApprovalUploadUrl: jest.fn(), recordGalleryImportApprovalUpload: jest.fn(), setGalleryImportCandidateSkip: jest.fn(), updateGalleryImportCandidate: jest.fn() }));
jest.mock('@/utils/gallery-import-checkpoint', () => ({
  loadGalleryImportCheckpoint: jest.fn(async () => mockCheckpoint), loadLatestGalleryImportCheckpoint: jest.fn(async () => null), clearGalleryImportCheckpoint: jest.fn(), clearGalleryImportPreviewCache: jest.fn(),
  updateGalleryImportCheckpoint: jest.fn(async (_u: string, _f: string, _r: string, update: any) => { mockCheckpoint = update(mockCheckpoint); return mockCheckpoint; }),
}));

const mockRouter = jest.requireMock('expo-router').router as { back: jest.Mock; push: jest.Mock; replace: jest.Mock };
const mockUploadToPresignedUrl = jest.requireMock('@/services/media').uploadToPresignedUrl as jest.Mock;

const candidate = { id: 'candidate-1', caption: 'A small day.', memoryDate: '2025-05-12', selectedAssetTokens: ['asset-1'], familyMemberIds: [], status: 'ready' as const, previewUrls: ['https://preview'] };
function candidateAt(index: number, status: 'ready' | 'skipped' = 'ready') { return { ...candidate, id: `candidate-${index}`, caption: `Moment ${index}`, status }; }
function checkpoint(overrides: Record<string, unknown> = {}) { return { version: 2, userId: 'user-1', familyId: 'family-1', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'reviewing', assetByToken: { 'asset-1': { assetToken: 'asset-1', osAssetId: 'local-1', captureAtMs: 1, width: 10, height: 10, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: [], chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now', ...overrides }; }

describe('gallery import flow integration', () => {
  beforeEach(() => {
    jest.clearAllMocks(); mockCheckpoint = checkpoint();
    mockAdapter.getPermission.mockResolvedValue({ state: 'full' }); mockAdapter.requestPermission.mockResolvedValue({ state: 'full' });
    mockAdapter.isAssetAvailableLocally.mockResolvedValue(true);
    mockAdapter.resolveAssetUri.mockResolvedValue('file://original.jpg'); mockAdapter.getAssetFilename.mockResolvedValue('original.jpg');
    (startGalleryImportRunner as jest.Mock).mockResolvedValue({ runId: 'run-1', scannedAssetCount: 3, clusterCount: 1 });
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'reviewing', readyCandidates: 1 }, error: null });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [candidate] }, error: null });
    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockResolvedValue({ data: { candidate: { ...candidate, status: 'skipped' } }, error: null });
    (galleryService.updateGalleryImportCandidate as jest.Mock).mockResolvedValue({ data: { candidate }, error: null });
    (galleryService.beginGalleryImportApproval as jest.Mock).mockResolvedValue({ data: { leaseId: 'lease-1', memoryId: 'memory-1', expiresAt: '2099-01-01', expectedAssets: [] }, error: null });
    (galleryService.getGalleryImportApprovalUploadUrl as jest.Mock).mockResolvedValue({ data: { uploadUrl: 'https://upload', requiredHeaders: {} }, error: null });
    (galleryService.recordGalleryImportApprovalUpload as jest.Mock).mockResolvedValue({ data: { recorded: true }, error: null });
    (galleryService.finalizeGalleryImportCandidate as jest.Mock).mockResolvedValue({ data: { memoryId: 'memory-1' }, error: null });
  });

  it.each(['full', 'limited'] as const)('starts with %s access and exposes the limited-library picker only when applicable', async (state) => {
    mockAdapter.getPermission.mockResolvedValue({ state });
    const screen = render(<GalleryImportEntry />);
    await waitFor(() => state === 'limited' ? expect(screen.getByTestId('gallery-import-choose-more')).toBeTruthy() : expect(screen.queryByTestId('gallery-import-choose-more')).toBeNull());
    if (state === 'limited') fireEvent.press(screen.getByTestId('gallery-import-choose-more'));
    fireEvent.press(screen.getByTestId('gallery-import-start'));
    await waitFor(() => expect(startGalleryImportRunner).toHaveBeenCalled());
    if (state === 'limited') expect(mockAdapter.presentPermissionPicker).toHaveBeenCalled();
  });

  it('shows denied and blocked permission recovery without starting a scan, including device settings', async () => {
    mockAdapter.getPermission.mockResolvedValue({ state: 'denied' }); mockAdapter.requestPermission.mockResolvedValue({ state: 'denied' });
    const denied = render(<GalleryImportEntry />); fireEvent.press(denied.getByTestId('gallery-import-start'));
    await waitFor(() => expect(denied.getByText(/not granted/)).toBeTruthy()); expect(startGalleryImportRunner).not.toHaveBeenCalled(); denied.unmount();
    mockAdapter.getPermission.mockResolvedValue({ state: 'blocked' });
    const blocked = render(<GalleryImportEntry />);
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(true);
    await waitFor(() => expect(blocked.getByTestId('gallery-import-open-settings')).toBeTruthy()); fireEvent.press(blocked.getByTestId('gallery-import-open-settings')); expect(openSettings).toHaveBeenCalled(); fireEvent.press(blocked.getByTestId('gallery-import-start'));
    await waitFor(() => expect(blocked.getByText(/device settings/)).toBeTruthy()); expect(startGalleryImportRunner).not.toHaveBeenCalled();
  });

  it('keeps generic terminal/device states free of candidate details', async () => {
    mockCheckpoint = null; const device = render(<GalleryImportProgress runId="run-1" />); await waitFor(() => expect(device.getByText(/device that started/)).toBeTruthy()); expect(device.queryByText(candidate.caption)).toBeNull(); device.unmount();
    mockCheckpoint = checkpoint(); (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValueOnce({ data: { status: 'expired', readyCandidates: 0 }, error: null });
    const expired = render(<GalleryImportProgress runId="run-1" />); await waitFor(() => expect(expired.getByTestId('gallery-import-expired-back')).toBeTruthy()); expect(expired.queryByText(candidate.caption)).toBeNull(); expired.unmount();
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValueOnce({ data: { status: 'failed', readyCandidates: 0 }, error: null });
    const access = render(<GalleryImportProgress runId="run-1" />); await waitFor(() => expect(access.getByTestId('gallery-import-access-lost-back')).toBeTruthy());
  });

  it('ignores a late status response after progress unmounts', async () => {
    let resolveFirstStatus: ((value: unknown) => void) | undefined;
    (galleryService.getGalleryImportRun as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { resolveFirstStatus = resolve; }));
    const first = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(galleryService.getGalleryImportRun).toHaveBeenCalledTimes(1));
    first.unmount();

    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({ data: { status: 'expired', readyCandidates: 0 }, error: null });
    const second = render(<GalleryImportProgress runId="run-1" />);
    await waitFor(() => expect(second.getByTestId('gallery-import-expired-back')).toBeTruthy());
    await act(async () => { resolveFirstStatus?.({ data: { status: 'reviewing', readyCandidates: 4 }, error: null }); });
    expect(second.getByTestId('gallery-import-expired-back')).toBeTruthy();
    expect(galleryService.getGalleryImportRun).toHaveBeenCalledTimes(2);
  });

  it('keeps the deck read-only and requires explicit set-aside then restore', async () => {
    const screen = render(<GalleryImportReview runId="run-1" />); await waitFor(() => expect(screen.getByTestId('gallery-import-set-aside')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-caption')).toBeNull(); fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenCalledWith(expect.objectContaining({ skip: true })));
    await waitFor(() => expect(screen.getByTestId('gallery-import-restore-candidate-1')).toBeTruthy());
    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockResolvedValueOnce({ data: { candidate: { ...candidate, status: 'ready' } }, error: null });
    fireEvent.press(screen.getByTestId('gallery-import-restore-candidate-1'));
    await waitFor(() => expect(galleryService.setGalleryImportCandidateSkip).toHaveBeenLastCalledWith(expect.objectContaining({ skip: false })));
  });

  it('advances the deterministic ready queue once per skip and decrements progress on restore', async () => {
    const ordered = [candidateAt(1), candidateAt(2), candidateAt(3), candidateAt(4)];
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: ordered }, error: null });
    (galleryService.setGalleryImportCandidateSkip as jest.Mock).mockImplementation(async ({ candidateId, skip }) => ({
      data: { candidate: { ...ordered.find((item) => item.id === candidateId)!, status: skip ? 'skipped' : 'ready' } },
      error: null,
    }));
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Moment 1')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Moment 1 of 4');

    fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
    await waitFor(() => expect(screen.getByText('Moment 2')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Moment 2 of 4');

    fireEvent.press(screen.getByTestId('gallery-import-set-aside'));
    await waitFor(() => expect(screen.getByText('Moment 3')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Moment 3 of 4');

    fireEvent.press(screen.getByTestId('gallery-import-restore-candidate-1'));
    await waitFor(() => expect(screen.getByText('Moment 1')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Moment 2 of 4');
  });

  it('keeps a 59-card restore list bounded and preserves the unique total after an approval remount', async () => {
    const remaining = [candidateAt(60), ...Array.from({ length: 59 }, (_, index) => candidateAt(index + 1, 'skipped'))];
    mockCheckpoint = checkpoint({ deckCursor: 59, deckTotal: 60 });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: remaining }, error: null });
    const screen = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Moment 60')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Moment 60 of 60');
    expect(screen.getByText('Set aside · 59')).toBeTruthy();
    expect(screen.getByTestId('gallery-import-set-aside-scroll')).toHaveStyle({ maxHeight: 168 });
    expect(screen.getByTestId('gallery-import-set-aside-scroll').props.nestedScrollEnabled).toBe(true);
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

  it('recovers an ambiguous late begin from an approving candidate without editing or completing the run', async () => {
    let resolveFirstBegin: ((value: unknown) => void) | undefined;
    (galleryService.beginGalleryImportApproval as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { resolveFirstBegin = resolve; }));
    const firstApproval = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(firstApproval.getByTestId('gallery-import-approve')).toBeTruthy());
    jest.useFakeTimers();
    try {
      fireEvent.press(firstApproval.getByTestId('gallery-import-approve'));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(galleryService.beginGalleryImportApproval).toHaveBeenCalledTimes(1);
      await act(async () => { await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_APPROVAL_STEP_TIMEOUT_MS); });
      expect(firstApproval.getByText(/paused before it could finish/)).toBeTruthy();
      expect(mockCheckpoint.approvalOutbox).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
    resolveFirstBegin?.({ data: { leaseId: 'lease-1', memoryId: 'memory-1', expiresAt: '2099-01-01', expectedAssets: [] }, error: null });
    await act(async () => { await Promise.resolve(); });
    firstApproval.unmount();

    const approvingCandidate = { ...candidate, status: 'approving' as const };
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [approvingCandidate] }, error: null });
    const review = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/approve', params: { runId: 'run-1', candidateId: 'candidate-1' } }));
    expect(review.getByTestId('gallery-import-outbox-redirect')).toBeTruthy();
    expect(review.queryByTestId('gallery-import-complete')).toBeNull();
    review.unmount();

    (galleryService.beginGalleryImportApproval as jest.Mock).mockResolvedValue({ data: { leaseId: 'lease-1', memoryId: 'memory-1', expiresAt: '2099-01-01', expectedAssets: [] }, error: null });
    const recoveredApproval = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(recoveredApproval.getByTestId('gallery-import-caption').props.editable).toBe(false);
    expect(galleryService.beginGalleryImportApproval).toHaveBeenCalledTimes(2);
    expect(galleryService.updateGalleryImportCandidate).toHaveBeenCalledTimes(1);
    expect(galleryService.getGalleryImportApprovalUploadUrl).toHaveBeenCalledTimes(1);
    expect(mockCheckpoint.approvalOutbox).toEqual([]);
    expect(mockCheckpoint.deckCursor).toBe(1);
  });

  it('auto-resumes an uploading outbox once without beginning or editing a second approval', async () => {
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'uploading' }] });
    render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(galleryService.getGalleryImportApprovalUploadUrl).toHaveBeenCalledTimes(1);
    expect(galleryService.recordGalleryImportApprovalUpload).toHaveBeenCalledTimes(1);
    expect(galleryService.updateGalleryImportCandidate).not.toHaveBeenCalled();
    expect(galleryService.beginGalleryImportApproval).not.toHaveBeenCalled();
    expect(mockCheckpoint.approvalOutbox).toEqual([]);
    expect(mockCheckpoint.deckCursor).toBe(1);
  });

  it('auto-finalizes a finalizing approval outbox after relaunch without re-uploading', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 0, deckTotal: 2, approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'finalizing' }] });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(galleryService.getGalleryImportApprovalUploadUrl).not.toHaveBeenCalled();
    expect(mockCheckpoint.deckCursor).toBe(1);
    screen.unmount();

    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [candidateAt(2)] }, error: null });
    const review = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(review.getByText('Moment 2')).toBeTruthy());
    expect(review.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Moment 2 of 2');
  });

  it('requires an explicit failed-outbox retry and reuses its lease without update or begin', async () => {
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'failed', errorCode: 'client_retryable' }] });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-retry')).toBeTruthy());
    expect(screen.getByTestId('mock-fixed-footer')).toBeTruthy();
    expect(screen.queryByTestId('mock-keyboard-sticky-footer')).toBeNull();
    expect(galleryService.getGalleryImportApprovalUploadUrl).not.toHaveBeenCalled();
    expect(galleryService.finalizeGalleryImportCandidate).not.toHaveBeenCalled();
    expect(screen.getByTestId('gallery-import-caption').props.editable).toBe(false);

    fireEvent.press(screen.getByTestId('gallery-import-approval-retry'));
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(galleryService.getGalleryImportApprovalUploadUrl).toHaveBeenCalledTimes(1);
    expect(galleryService.updateGalleryImportCandidate).not.toHaveBeenCalled();
    expect(galleryService.beginGalleryImportApproval).not.toHaveBeenCalled();
    expect(mockCheckpoint.approvalOutbox).toEqual([]);
    expect(mockCheckpoint.deckCursor).toBe(1);
  });

  it('lets PhotoKit resolve a selected iCloud original during approval without a local-only preflight', async () => {
    mockAdapter.isAssetAvailableLocally.mockResolvedValue(false);
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approve')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-approve'));
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(mockAdapter.isAssetAvailableLocally).not.toHaveBeenCalled();
    expect(mockAdapter.resolveAssetUri).toHaveBeenCalledWith('local-1');
    expect(mockCheckpoint.approvalOutbox).toEqual([]);
  });

  it('reports content-free secure-request, upload, and confirmation progress for each original', async () => {
    let resolveUploadUrl: ((value: unknown) => void) | undefined;
    let resolveUpload: ((value: unknown) => void) | undefined;
    let resolveRecord: ((value: unknown) => void) | undefined;
    (galleryService.getGalleryImportApprovalUploadUrl as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { resolveUploadUrl = resolve; }));
    mockUploadToPresignedUrl.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    (galleryService.recordGalleryImportApprovalUpload as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { resolveRecord = resolve; }));
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'failed', errorCode: 'client_retryable' }] });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-retry')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-approval-retry'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-progress').props.children).toBe('Requesting secure upload 1 of 1…'));

    await act(async () => { resolveUploadUrl?.({ data: { uploadUrl: 'https://upload', requiredHeaders: {} }, error: null }); });
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-progress').props.children).toBe('Uploading photo 1 of 1…'));
    await act(async () => { resolveUpload?.({ error: null }); });
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-progress').props.children).toBe('Confirming photo 1 of 1…'));
    await act(async () => { resolveRecord?.({ data: { recorded: true }, error: null }); });
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockCheckpoint.approvalOutbox).toEqual([]));
  });

  it('treats an unconfirmed upload receipt as a staged retryable error', async () => {
    (galleryService.recordGalleryImportApprovalUpload as jest.Mock).mockResolvedValueOnce({ data: { recorded: false }, error: null });
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'failed', errorCode: 'client_retryable' }] });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-retry')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-approval-retry'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-error').props.children).toBe('Confirming secure upload: Could not confirm the photo upload.'));
    expect(mockCheckpoint.approvalOutbox[0]).toEqual(expect.objectContaining({ status: 'failed', leaseId: 'lease-1' }));
    expect(galleryService.finalizeGalleryImportCandidate).not.toHaveBeenCalled();
  });

  it('retries a failed finalization even when the already-approved candidate is no longer listed', async () => {
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'failed', errorCode: 'client_retryable_finalizing' }] });
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [] }, error: null });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-retry')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-approval-retry'));
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(galleryService.getGalleryImportApprovalUploadUrl).not.toHaveBeenCalled();
    expect(galleryService.recordGalleryImportApprovalUpload).not.toHaveBeenCalled();
    expect(galleryService.updateGalleryImportCandidate).not.toHaveBeenCalled();
    expect(galleryService.beginGalleryImportApproval).not.toHaveBeenCalled();
    expect(mockCheckpoint.approvalOutbox).toEqual([]);
    expect(mockCheckpoint.deckCursor).toBe(1);
  });

  it('bounds a hung original during initial approval before opening a lease', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approve')).toBeTruthy());
    mockAdapter.resolveAssetUri.mockImplementation(() => new Promise(() => undefined));
    jest.useFakeTimers();
    try {
      fireEvent.press(screen.getByTestId('gallery-import-approve'));
      await act(async () => { await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_APPROVAL_STEP_TIMEOUT_MS); });
      expect(screen.getByText(/paused before it could finish/)).toBeTruthy();
      expect(galleryService.beginGalleryImportApproval).not.toHaveBeenCalled();
      expect(mockCheckpoint.approvalOutbox).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a hung original during automatic resume, then retries once without a late duplicate action', async () => {
    jest.useFakeTimers();
    let resolveLate: ((uri: string) => void) | undefined;
    mockAdapter.resolveAssetUri.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveLate = resolve; }));
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'uploading' }] });
    try {
      const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await jest.advanceTimersByTimeAsync(GALLERY_IMPORT_APPROVAL_STEP_TIMEOUT_MS); });
      expect(mockCheckpoint.approvalOutbox[0]).toEqual(expect.objectContaining({ status: 'failed', leaseId: 'lease-1' }));
      expect(screen.getByTestId('gallery-import-approval-retry')).toBeTruthy();
      expect(screen.getByText(/paused before it could finish/)).toBeTruthy();
      expect(galleryService.getGalleryImportApprovalUploadUrl).not.toHaveBeenCalled();
      expect(galleryService.finalizeGalleryImportCandidate).not.toHaveBeenCalled();
      await act(async () => { await Promise.resolve(); });
      expect(mockAdapter.resolveAssetUri).toHaveBeenCalledTimes(1);

      mockAdapter.resolveAssetUri.mockResolvedValue('file://retry.jpg');
      jest.useRealTimers();
      fireEvent.press(screen.getByTestId('gallery-import-approval-retry'));
      await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
      resolveLate?.('file://late-first-attempt.jpg');
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(galleryService.getGalleryImportApprovalUploadUrl).toHaveBeenCalledTimes(1);
      expect(galleryService.recordGalleryImportApprovalUpload).toHaveBeenCalledTimes(1);
      expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1);
      expect(galleryService.updateGalleryImportCandidate).not.toHaveBeenCalled();
      expect(galleryService.beginGalleryImportApproval).not.toHaveBeenCalled();
      expect(mockCheckpoint.approvalOutbox).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('validates and edits the composer photo/tag selections before approval', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />); await waitFor(() => expect(screen.getByTestId('gallery-import-approve')).toBeTruthy());
    expect(screen.getByTestId('mock-keyboard-sticky-footer')).toBeTruthy();
    expect(screen.queryByTestId('mock-fixed-footer')).toBeNull();
    fireEvent.press(screen.getByTestId('gallery-import-photo-0')); fireEvent.press(screen.getByTestId('gallery-import-approve'));
    await waitFor(() => expect(screen.getByText(/at least one photo/)).toBeTruthy()); fireEvent.press(screen.getByTestId('gallery-import-photo-0')); fireEvent.press(screen.getByTestId('gallery-import-member-child-1'));
    expect(screen.getByTestId('gallery-import-member-child-1').props.accessibilityState.checked).toBe(true);
  });

  it('caps captions at 1,000 characters and rejects impossible calendar dates', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />); await waitFor(() => expect(screen.getByTestId('gallery-import-approve')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-caption').props.maxLength).toBe(1_000);
    fireEvent.changeText(screen.getByTestId('gallery-import-date'), '2026-99-99');
    fireEvent.press(screen.getByTestId('gallery-import-approve'));
    await waitFor(() => expect(screen.getByText('Enter a real date in YYYY-MM-DD format.')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('gallery-import-date'), '2026-02-28');
    fireEvent.changeText(screen.getByTestId('gallery-import-caption'), 'x'.repeat(1_001));
    fireEvent.press(screen.getByTestId('gallery-import-approve'));
    await waitFor(() => expect(screen.getByText('Keep the caption to 1,000 characters or fewer.')).toBeTruthy());
    expect(galleryService.beginGalleryImportApproval).not.toHaveBeenCalled();
  });

  it('refuses an approval lease when every selected original disappeared', async () => {
    const original = jest.requireMock('@/utils/gallery-import-original').getGalleryImportOriginalUpload as jest.Mock;
    original.mockRejectedValueOnce(new Error('removed'));
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />); await waitFor(() => expect(screen.getByTestId('gallery-import-approve')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-approve'));
    await waitFor(() => expect(screen.getByText(/no longer available/)).toBeTruthy());
    expect(galleryService.beginGalleryImportApproval).not.toHaveBeenCalled();
  });
});
