import { fireEvent, render } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ImportDrawer } from '@/components/gallery-import/import-drawer';
import { useGalleryImportRunCandidates } from '@/hooks/useGalleryImport';
import type { GalleryImportCandidate, GalleryImportRun } from '@/services/gallery-import';
import type { GalleryImportCheckpoint } from '@/utils/gallery-import-checkpoint';

const SAFE_AREA_METRICS = {
  frame: { height: 844, width: 390, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 47 },
};

function renderDrawer(props: ComponentProps<typeof ImportDrawer>) {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ImportDrawer {...props} />
    </SafeAreaProvider>,
  );
}

jest.mock('@/hooks/useGalleryImport', () => ({
  useGalleryImportRunCandidates: jest.fn(),
}));

const mockedUseCandidates = useGalleryImportRunCandidates as jest.MockedFunction<typeof useGalleryImportRunCandidates>;

function makeCandidate(overrides: Partial<GalleryImportCandidate> = {}): GalleryImportCandidate {
  return {
    id: 'candidate-1',
    caption: 'A quiet morning',
    memoryDate: '2026-08-01',
    selectedAssetTokens: ['token-1'],
    familyMemberIds: [],
    status: 'ready',
    previewUrls: ['https://example.com/preview.jpg'],
    ...overrides,
  };
}

const checkpoint = {
  version: 1,
  userId: 'user-1',
  familyId: 'family-1',
  runId: 'run-1',
  runCapability: 'cap-1',
  algorithmVersion: 'v1',
  status: 'reviewing',
  assetByToken: {},
  uploadedAssetTokens: [],
  clusterSignatures: [],
  chunks: [],
  deckCursor: 0,
  approvalOutbox: [],
  updatedAt: new Date().toISOString(),
} as unknown as GalleryImportCheckpoint;

function baseProps(overrides: Partial<ComponentProps<typeof ImportDrawer>> = {}) {
  return {
    visible: true,
    state: 'ready' as const,
    attentionReason: null,
    reviewDaysLeft: null,
    run: null,
    checkpoint,
    onClose: jest.fn(),
    onPrimaryAction: jest.fn(),
    ...overrides,
  };
}

describe('ImportDrawer', () => {
  beforeEach(() => {
    mockedUseCandidates.mockReturnValue({ data: [] } as unknown as ReturnType<typeof useGalleryImportRunCandidates>);
  });

  it('shows the ready-state copy and fires the CTA', () => {
    mockedUseCandidates.mockReturnValue({
      data: [makeCandidate(), makeCandidate({ id: 'c2' })],
    } as unknown as ReturnType<typeof useGalleryImportRunCandidates>);
    const run = { id: 'run-1', familyId: 'family-1', status: 'reviewing', reviewExpiresAt: null, limits: { maxClusters: 1, maxAssetsPerCluster: 1, maxChunks: 1 }, readyCandidates: 2 } as GalleryImportRun;
    const onPrimaryAction = jest.fn();
    const { getByText, getByTestId } = renderDrawer(baseProps({ run, onPrimaryAction, state: 'ready' }));

    expect(getByText('2 suggestions from your photos')).toBeTruthy();
    fireEvent.press(getByTestId('import-drawer-cta'));
    expect(onPrimaryAction).toHaveBeenCalledTimes(1);
  });

  it('shows the resume-state copy with real kept/left counts', () => {
    mockedUseCandidates.mockReturnValue({
      data: [
        makeCandidate({ id: 'c1', status: 'ready' }),
        makeCandidate({ id: 'c2', status: 'kept' }),
        makeCandidate({ id: 'c3', status: 'kept' }),
      ],
    } as unknown as ReturnType<typeof useGalleryImportRunCandidates>);
    const run = { id: 'run-1', familyId: 'family-1', status: 'reviewing', reviewExpiresAt: null, limits: { maxClusters: 1, maxAssetsPerCluster: 1, maxChunks: 1 } } as GalleryImportRun;
    const { getByText } = renderDrawer(baseProps({ checkpoint: { ...checkpoint, deckCursor: 2 }, run, state: 'resume' }));

    expect(getByText('1 suggestion left to look at')).toBeTruthy();
    expect(getByText('2 kept so far. Your place is saved.')).toBeTruthy();
  });

  it('shows the waiting-for-wifi attention copy', () => {
    const { getByText } = renderDrawer(baseProps({ attentionReason: 'waiting_for_wifi', state: 'attention' }));
    expect(getByText('Paused until you are on Wi‑Fi')).toBeTruthy();
  });

  it('shows the run-failed attention copy distinctly from waiting-for-wifi', () => {
    const { getByText, queryByText } = renderDrawer(baseProps({ attentionReason: 'run_failed', state: 'attention' }));
    expect(getByText('Something needs a second look')).toBeTruthy();
    expect(queryByText('Paused until you are on Wi‑Fi')).toBeNull();
  });

  it('shows the expiring-state copy using the real day count and set-aside total', () => {
    mockedUseCandidates.mockReturnValue({
      data: [makeCandidate({ status: 'skipped' }), makeCandidate({ id: 'c2', status: 'skipped' })],
    } as unknown as ReturnType<typeof useGalleryImportRunCandidates>);
    const { getByText } = renderDrawer(baseProps({ reviewDaysLeft: 3, state: 'expiring' }));
    expect(getByText('2 set aside, 3 days left')).toBeTruthy();
  });

  it('shows the processing-state copy with an indeterminate bar', () => {
    const run = { id: 'run-1', familyId: 'family-1', status: 'processing', reviewExpiresAt: null, limits: { maxClusters: 1, maxAssetsPerCluster: 1, maxChunks: 1 }, readyCandidates: 4 } as GalleryImportRun;
    const { getByText } = renderDrawer(baseProps({ run, state: 'processing' }));
    expect(getByText('4 suggestions ready so far')).toBeTruthy();
    expect(getByText('Still looking through the rest. Safe to close Momora.')).toBeTruthy();
    expect(getByText('Start reviewing')).toBeTruthy();
  });

  // Device evidence (round 4): at readyCount 0 the eyebrow and title used to
  // be the identical string stacked, and the CTA still said "Start
  // reviewing" though there is nothing to review yet -- it routes to the
  // progress screen (timeline.tsx), not a deck.
  it('gives the zero-ready processing card its own title and a CTA that names the progress screen', () => {
    const run = { id: 'run-1', familyId: 'family-1', status: 'processing', reviewExpiresAt: null, limits: { maxClusters: 1, maxAssetsPerCluster: 1, maxChunks: 1 }, readyCandidates: 0 } as GalleryImportRun;
    const { getByText, queryByText } = renderDrawer(baseProps({ run, state: 'processing' }));
    expect(getByText('Looking through your photos')).toBeTruthy();
    expect(getByText('Momora is still looking.')).toBeTruthy();
    expect(getByText('Check progress')).toBeTruthy();
    expect(queryByText('Start reviewing')).toBeNull();
  });

  it('does not show a captions-settings link or the camera-roll reassure line', () => {
    const { queryByTestId, queryByText } = renderDrawer(baseProps());
    expect(queryByTestId('import-drawer-settings-link')).toBeNull();
    expect(queryByText('How captions are written')).toBeNull();
    expect(queryByText('Your camera roll is never changed.')).toBeNull();
  });

  it('still shows the suggestions-clear note', () => {
    const { getByText } = renderDrawer(baseProps({ reviewDaysLeft: 5 }));
    expect(getByText('Suggestions clear in 5 days. Kept memories stay forever.')).toBeTruthy();
  });

  it('fires onClose from the close button', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderDrawer(baseProps({ onClose }));

    fireEvent.press(getByTestId('import-drawer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
