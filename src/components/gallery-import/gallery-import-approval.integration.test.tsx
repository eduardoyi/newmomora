import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  GALLERY_IMPORT_APPROVAL_STEP_TIMEOUT_MS,
  GalleryImportApproval,
} from '@/components/gallery-import/gallery-import-approval';
import { GalleryImportReview } from '@/components/gallery-import/gallery-import-review';
import * as galleryService from '@/services/gallery-import';

const mockAdapter = { getPermission: jest.fn(), requestPermission: jest.fn(), presentPermissionPicker: jest.fn(), isAssetAvailableLocally: jest.fn(), resolveAssetUri: jest.fn(), getAssetFilename: jest.fn() };
let mockCheckpoint: any = null;

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() } }));
jest.mock('expo-image', () => { const { View: MockView } = require('react-native'); return { Image: (props: any) => <MockView testID={props.testID} onError={props.onError} /> }; });
jest.mock('react-native-safe-area-context', () => { const { View: MockView } = require('react-native'); return { SafeAreaView: MockView, useSafeAreaInsets: () => ({ bottom: 28, top: 0, left: 0, right: 0 }) }; });
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
jest.mock('@/hooks/use-family', () => ({ useFamily: () => ({ familyId: 'family-1', role: 'owner' }) }));
jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: () => ({
    members: [{
      id: 'child-1', name: 'Ada', nicknames: [], is_user_profile: true,
      date_of_birth: null, illustrated_profile_key: null, illustrated_profile_status: null, profile_picture_key: null,
    }],
  }),
}));
jest.mock('@/components/family-member-avatar', () => ({ FamilyMemberAvatar: () => null }));
jest.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: jest.fn() }, functions: { invoke: jest.fn() } } }));
// The screen mounts DatePickerField, which renders this native picker on
// Android via an imperative `.open({ onChange })` call -- mirrors the mock
// new-memory.integration.test.tsx uses for the same reason.
jest.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: () => null,
  DateTimePickerAndroid: { open: jest.fn() },
}));
// VoiceSpeakItModal transitively imports expo-audio at module scope via
// useVoiceInput -- stubbed with a lightweight marker so the mic-affordance
// wiring is still testable without a real native audio module.
jest.mock('@/components/voice-speak-it-modal', () => {
  const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native');
  return {
    VoiceSpeakItModal: ({ visible, onResult, onDismiss }: any) => (visible ? (
      <MockView testID="mock-voice-modal">
        <MockPressable onPress={() => onResult({ cleanedText: 'Dictated caption', mentionedMemberIds: [] })} testID="mock-voice-modal-result">
          <MockText>result</MockText>
        </MockPressable>
        <MockPressable onPress={onDismiss} testID="mock-voice-modal-dismiss">
          <MockText>dismiss</MockText>
        </MockPressable>
      </MockView>
    ) : null),
  };
});
jest.mock('@/utils/gallery-import-e2e-adapter', () => ({ getGalleryImportE2eAdapter: () => undefined }));
jest.mock('@/utils/gallery-import-scanner', () => ({ createExpoGalleryMediaLibraryAdapter: () => mockAdapter }));
jest.mock('@/utils/gallery-import-original', () => ({ getGalleryImportOriginalUpload: jest.fn(async () => ({ contentType: 'image/jpeg', byteLength: 12, aspectRatio: 1 })) }));
jest.mock('@/services/media', () => ({ uploadToPresignedUrl: jest.fn(async () => ({ error: null })) }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/services/gallery-import', () => ({
  beginGalleryImportApproval: jest.fn(), completeGalleryImportRun: jest.fn(), finalizeGalleryImportCandidate: jest.fn(),
  getGalleryImportCandidates: jest.fn(), getGalleryImportApprovalUploadUrl: jest.fn(), getGalleryImportRun: jest.fn(),
  recordGalleryImportApprovalUpload: jest.fn(), setGalleryImportCandidateSkip: jest.fn(), updateGalleryImportCandidate: jest.fn(),
}));
jest.mock('@/utils/gallery-import-checkpoint', () => ({
  loadGalleryImportCheckpoint: jest.fn(async () => mockCheckpoint), clearGalleryImportCheckpoint: jest.fn(), clearGalleryImportPreviewCache: jest.fn(),
  updateGalleryImportCheckpoint: jest.fn(async (_u: string, _f: string, _r: string, update: any) => { mockCheckpoint = update(mockCheckpoint); return mockCheckpoint; }),
}));

const mockRouter = jest.requireMock('expo-router').router as { back: jest.Mock; push: jest.Mock; replace: jest.Mock };
const mockUploadToPresignedUrl = jest.requireMock('@/services/media').uploadToPresignedUrl as jest.Mock;

const candidate = { id: 'candidate-1', caption: 'A small day.', memoryDate: '2025-05-12', selectedAssetTokens: ['asset-1'], familyMemberIds: [], status: 'ready' as const, previewUrls: ['https://preview'] };
function candidateAt(index: number, status: 'ready' | 'skipped' = 'ready') { return { ...candidate, id: `candidate-${index}`, caption: `Moment ${index}`, status }; }
function checkpoint(overrides: Record<string, unknown> = {}) { return { version: 2, userId: 'user-1', familyId: 'family-1', runId: 'run-1', runCapability: 'cap', algorithmVersion: 'gallery-v1', status: 'reviewing', assetByToken: { 'asset-1': { assetToken: 'asset-1', osAssetId: 'local-1', captureAtMs: 1, width: 10, height: 10, isFavorite: false } }, uploadedAssetTokens: [], clusterSignatures: [], chunks: [{ ordinal: 0, status: 'dispatched', clusters: [], previewUploads: [] }], deckCursor: 0, approvalOutbox: [], updatedAt: 'now', ...overrides }; }

describe('gallery import approval composer', () => {
  beforeEach(() => {
    jest.clearAllMocks(); mockCheckpoint = checkpoint();
    mockAdapter.isAssetAvailableLocally.mockResolvedValue(true);
    mockAdapter.resolveAssetUri.mockResolvedValue('file://original.jpg'); mockAdapter.getAssetFilename.mockResolvedValue('original.jpg');
    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [candidate] }, error: null });
    // Round 4: GalleryImportReview (rendered directly by a couple of tests
    // below) now polls server run truth too -- a terminal-ish default here
    // keeps those tests' expectations unaffected by round 4's gate.
    (galleryService.getGalleryImportRun as jest.Mock).mockResolvedValue({
      data: { id: 'run-1', familyId: 'family-1', status: 'reviewing', reviewExpiresAt: null, limits: { maxClusters: 20, maxAssetsPerCluster: 6, maxChunks: 4 }, readyCandidates: 0, pendingClusters: 0 },
      error: null,
    });
    (galleryService.updateGalleryImportCandidate as jest.Mock).mockResolvedValue({ data: { candidate }, error: null });
    (galleryService.beginGalleryImportApproval as jest.Mock).mockResolvedValue({ data: { leaseId: 'lease-1', memoryId: 'memory-1', expiresAt: '2099-01-01', expectedAssets: [] }, error: null });
    (galleryService.getGalleryImportApprovalUploadUrl as jest.Mock).mockResolvedValue({ data: { uploadUrl: 'https://upload', requiredHeaders: {} }, error: null });
    (galleryService.recordGalleryImportApprovalUpload as jest.Mock).mockResolvedValue({ data: { recorded: true }, error: null });
    (galleryService.finalizeGalleryImportCandidate as jest.Mock).mockResolvedValue({ data: { memoryId: 'memory-1' }, error: null });
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
    // The locked-while-recovering composer (editable: false) is covered by
    // "requires an explicit failed-outbox retry..." below, where that state
    // lingers until a manual retry; here recovery runs to completion and
    // swaps in the kept-confirmation, which this test asserts instead.
    const recoveredApproval = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(galleryService.beginGalleryImportApproval).toHaveBeenCalledTimes(2);
    expect(galleryService.updateGalleryImportCandidate).toHaveBeenCalledTimes(1);
    expect(galleryService.getGalleryImportApprovalUploadUrl).toHaveBeenCalledTimes(1);
    expect(mockCheckpoint.approvalOutbox).toEqual([]);
    expect(mockCheckpoint.deckCursor).toBe(1);
    await waitFor(() => expect(recoveredApproval.getByTestId('gallery-import-approval-success')).toBeTruthy());
  });

  it('auto-resumes an uploading outbox once without beginning or editing a second approval', async () => {
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'uploading' }] });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(galleryService.getGalleryImportApprovalUploadUrl).toHaveBeenCalledTimes(1);
    expect(galleryService.recordGalleryImportApprovalUpload).toHaveBeenCalledTimes(1);
    expect(galleryService.updateGalleryImportCandidate).not.toHaveBeenCalled();
    expect(galleryService.beginGalleryImportApproval).not.toHaveBeenCalled();
    expect(mockCheckpoint.approvalOutbox).toEqual([]);
    expect(mockCheckpoint.deckCursor).toBe(1);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-success')).toBeTruthy());
  });

  it('auto-finalizes a finalizing approval outbox after relaunch without re-uploading', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 0, deckTotal: 2, approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'finalizing' }] });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(galleryService.finalizeGalleryImportCandidate).toHaveBeenCalledTimes(1));
    expect(galleryService.getGalleryImportApprovalUploadUrl).not.toHaveBeenCalled();
    expect(mockCheckpoint.deckCursor).toBe(1);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-success')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-approval-next'));
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/review', params: { runId: 'run-1' } });
    screen.unmount();

    (galleryService.getGalleryImportCandidates as jest.Mock).mockResolvedValue({ data: { candidates: [candidateAt(2)] }, error: null });
    const review = render(<GalleryImportReview runId="run-1" />);
    await waitFor(() => expect(review.getByText('Moment 2')).toBeTruthy());
    expect(review.getByTestId('gallery-import-deck-progress').props.accessibilityLabel).toBe('Suggestion 2 of 2');
  });

  it('requires an explicit failed-outbox retry and reuses its lease without update or begin', async () => {
    mockCheckpoint = checkpoint({ approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['asset-1'], status: 'failed', errorCode: 'client_retryable' }] });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-retry')).toBeTruthy());
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

  it('caps captions at 1,000 characters', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />); await waitFor(() => expect(screen.getByTestId('gallery-import-approve')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-caption').props.maxLength).toBe(1_000);
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

  // ── Composer reuse coverage (Job 2 rebuild) ──────────────────────────

  it('renders the shared memory-composer-form component, not a gallery-import fork', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    // "new-memory-media-preview" is MemoryMediaPreview's own internal
    // container testID (src/components/memory-media-preview.tsx) -- the
    // same component new-memory.tsx and edit.tsx mount. Its presence here
    // is only possible if this screen renders the literal shared
    // MemoryComposerForm (src/components/memory-composer-form.tsx), not a
    // lookalike form with its own grid.
    await waitFor(() => expect(screen.getByTestId('new-memory-media-preview')).toBeTruthy());
  });

  it('prefills the date picker with the candidate date, formatted, never raw ISO', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-date')).toBeTruthy());
    const label = screen.getByTestId('gallery-import-date').props.accessibilityLabel as string;
    expect(label).not.toBe(candidate.memoryDate);
    expect(label).not.toContain('2025-05-12');
  });

  it('renders the tag picker with the candidate family members, uncapped', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('memory-tag-child-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('memory-tag-child-1'));
    expect(screen.getByTestId('memory-tag-child-1').props.accessibilityState.selected).toBe(true);
  });

  it('shows and uses the restore-draft affordance only after the caption is edited', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-caption')).toBeTruthy());
    expect(screen.queryByTestId('gallery-import-restore-draft')).toBeNull();
    fireEvent.changeText(screen.getByTestId('gallery-import-caption'), 'Edited words');
    await waitFor(() => expect(screen.getByTestId('gallery-import-restore-draft')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-restore-draft'));
    expect(screen.getByTestId('gallery-import-caption').props.value).toBe(candidate.caption);
    expect(screen.queryByTestId('gallery-import-restore-draft')).toBeNull();
  });

  it('shows an inline unavailable state for a photo whose preview fails to load, and disables Save once all are unavailable', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('memory-media-image-0')).toBeTruthy());
    fireEvent(screen.getByTestId('memory-media-image-0'), 'error');
    await waitFor(() => expect(screen.getByTestId('memory-media-unavailable-0')).toBeTruthy());
    expect(screen.getByTestId('gallery-import-photos-unavailable')).toBeTruthy();
    expect(screen.getByTestId('gallery-import-approve').props.accessibilityState?.disabled ?? screen.getByTestId('gallery-import-approve').props.disabled).toBeTruthy();
  });

  it('removes a photo tile without re-adding it, and lets submit fail with "choose at least one photo"', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('memory-media-remove-0')).toBeTruthy());
    fireEvent.press(screen.getByTestId('memory-media-remove-0'));
    expect(screen.queryByTestId('memory-media-tile-0')).toBeNull();
    fireEvent.press(screen.getByTestId('gallery-import-approve'));
    await waitFor(() => expect(screen.getByText('Choose at least one photo.')).toBeTruthy());
  });

  it('opens the voice modal from the mic affordance and applies its dictated text to the caption', async () => {
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-voice-trigger')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-voice-trigger'));
    await waitFor(() => expect(screen.getByTestId('mock-voice-modal')).toBeTruthy());
    fireEvent.press(screen.getByTestId('mock-voice-modal-result'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-caption').props.value).toBe('Dictated caption'));
    expect(screen.getByTestId('gallery-import-restore-draft')).toBeTruthy();
  });

  it('hands the day-pool chooser the current selection through onAddPhotos and applies its ordered result, including local uris and submitted tokens', async () => {
    const onAddPhotos = jest.fn();
    mockCheckpoint = checkpoint({
      assetByToken: {
        'asset-1': { assetToken: 'asset-1', osAssetId: 'local-1', captureAtMs: 1, width: 10, height: 10, isFavorite: false },
        'asset-2': { assetToken: 'asset-2', osAssetId: 'local-2', captureAtMs: 2, width: 10, height: 10, isFavorite: false },
      },
    });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" onAddPhotos={onAddPhotos} />);
    // The Add tile and its testID come from the shared composer's real media
    // grid (src/components/memory-media-preview.tsx) -- not a gallery-import
    // fork -- so the same "Add" affordance new-memory/edit-memory could use.
    await waitFor(() => expect(screen.getByTestId('memory-media-add')).toBeTruthy());
    fireEvent.press(screen.getByTestId('memory-media-add'));
    expect(onAddPhotos).toHaveBeenCalledWith(expect.objectContaining({
      candidate: expect.objectContaining({ id: 'candidate-1', selectedAssetTokens: ['asset-1'] }),
      selectedAssetTokens: ['asset-1'],
      setPhotos: expect.any(Function),
    }));

    // The chooser hands back an ordered selection; the added pool photo
    // renders from its device uri instead of the missing server preview.
    act(() => {
      onAddPhotos.mock.calls[0][0].setPhotos([
        { assetToken: 'asset-1', uri: 'https://preview' },
        { assetToken: 'asset-2', uri: 'file://local/os-2' },
      ]);
    });
    await waitFor(() => expect(screen.getByTestId('memory-media-tile-1')).toBeTruthy());
    expect(screen.queryByTestId('memory-media-unavailable-1')).toBeNull();
    expect(screen.getByTestId('memory-media-image-1')).toBeTruthy();

    // Submit stages both tokens through the unchanged approval pipeline.
    fireEvent.press(screen.getByTestId('gallery-import-approve'));
    await waitFor(() => expect(galleryService.updateGalleryImportCandidate).toHaveBeenCalledWith(expect.objectContaining({
      assetTokens: ['asset-1', 'asset-2'],
    })));
  });

  it('shows the kept confirmation after a successful save, then lets "Next suggestion" return to the deck and "That is enough" exit', async () => {
    mockCheckpoint = checkpoint({ deckCursor: 3, deckTotal: 10 });
    const screen = render(<GalleryImportApproval runId="run-1" candidateId="candidate-1" />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-approve')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-approve'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-approval-success')).toBeTruthy());
    expect(screen.getByText('Next suggestion · 6 left')).toBeTruthy();
    // The absolute-positioned action stack pads the live bottom inset (28 in
    // this suite's safe-area mock) so "That is enough for now" clears the
    // system nav bar: max(spacing.xl 32, spacing.md 16 + inset 28) = 44.
    expect(screen.getByTestId('gallery-import-approval-success-actions')).toHaveStyle({ paddingBottom: 44 });
    // Same established sticky-footer surface (solid background + hairline
    // top border) every other gallery-import screen's fixed footer uses.
    expect(screen.getByTestId('gallery-import-approval-success-actions')).toHaveStyle({ borderTopWidth: 1 });

    fireEvent.press(screen.getByTestId('gallery-import-approval-stop'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline');
  });
});
