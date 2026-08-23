import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { GalleryImportEntry } from '@/components/gallery-import/gallery-import-entry';
import { useBilling } from '@/hooks/use-billing';
import { useGalleryImportEntryStatus } from '@/hooks/useGalleryImport';
import { beginGalleryImportPipeline } from '@/utils/gallery-import-pipeline';

const mockAdapter = { getPermission: jest.fn(), requestPermission: jest.fn(), presentPermissionPicker: jest.fn(), isAssetAvailableLocally: jest.fn(), resolveAssetUri: jest.fn(), getAssetFilename: jest.fn() };

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), setParams: jest.fn() } }));
// `footerStyle` is threaded onto the footer MockView (as the real shell
// applies it) so a test can assert on the shared sticky-footer treatment
// (gallery-import-shared.tsx's `gi.stickyFooterSurface`) without needing the
// real shell's keyboard/safe-area machinery here.
jest.mock('@/components/keyboard-sticky-shell', () => { const { View: MockView } = require('react-native'); return { KeyboardStickyShell: ({ children, footer, footerStyle, testID, footerTestID }: any) => <MockView testID={testID}>{children}<MockView style={footerStyle} testID={footerTestID}>{footer}</MockView></MockView> }; });
// The shell itself is mocked away above, but some real, unmocked
// descendants (e.g. GalleryImportExceptionScreen's own SafeAreaView, when
// the lapsed-billing overlay renders) still need a provider-free stand-in.
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 28, left: 0, right: 0 }) }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
jest.mock('@/hooks/use-family', () => ({ useFamily: () => ({ familyId: 'family-1', role: 'owner' }) }));
jest.mock('@/hooks/use-billing', () => ({ useBilling: jest.fn() }));
jest.mock('@/utils/roles', () => ({ canEditFamilyContent: () => true }));
jest.mock('@/utils/gallery-import-e2e-adapter', () => ({ getGalleryImportE2eAdapter: () => undefined }));
jest.mock('@/utils/gallery-import-scanner', () => ({ createExpoGalleryMediaLibraryAdapter: () => mockAdapter, getGalleryPhotoPermissionState: (value: any) => value.state }));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/utils/gallery-import-pipeline', () => ({ beginGalleryImportPipeline: jest.fn() }));
// The device-bound status hook (docs/plans/gallery-import-continuous.md I4a
// step 5) replaces this screen's own loadLatestGalleryImportCheckpoint
// effect -- mocked wholesale so this file never needs a real QueryClient.
jest.mock('@/hooks/useGalleryImport', () => ({ useGalleryImportEntryStatus: jest.fn() }));

function entryStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'none', attentionReason: null, reviewDaysLeft: null, readyCount: 0,
    checkpoint: null, run: null, isLoading: false, refetch: jest.fn(),
    driverState: { phase: 'idle', runId: null, pausedUntil: null, lastError: null, isActive: false },
    comingIndicator: { kind: 'none' },
    ...overrides,
  } as never;
}

function pressStart(screen: ReturnType<typeof render>) {
  fireEvent.press(screen.getByTestId('gallery-import-start'));
}

/** Walks a react-test-renderer JSON tree and collects only actual rendered
 * text nodes (never prop values like testID/style), so a copy sweep can't be
 * fooled into "failing" on a testID that happens to contain a banned word. */
function collectRenderedText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((child) => collectRenderedText(child, out)); return out; }
  if (typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
    collectRenderedText((node as { children?: unknown }).children, out);
  }
  return out;
}

describe('gallery import entry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdapter.getPermission.mockResolvedValue({ state: 'full' });
    mockAdapter.requestPermission.mockResolvedValue({ state: 'full' });
    (useBilling as jest.Mock).mockReturnValue({ status: { has_write_access: true, has_ever_had_access: true } });
    (useGalleryImportEntryStatus as jest.Mock).mockReturnValue(entryStatus());
  });

  it('gives the footer the shared solid-background/hairline-border treatment, and never stacks a second safe-area inset onto the trailing hint (the reported oversized-gap bug)', async () => {
    const screen = render(<GalleryImportEntry />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-entry')).toBeTruthy());

    const footer = screen.getByTestId('gallery-import-entry-footer');
    const footerStyle = [footer.props.style].flat(Infinity).filter(Boolean).reduce((acc: Record<string, unknown>, entry: Record<string, unknown>) => ({ ...acc, ...entry }), {});
    expect(footerStyle.backgroundColor).toBeTruthy();
    expect(footerStyle.borderTopWidth).toBeGreaterThan(0);
    expect(footerStyle.borderTopColor).toBeTruthy();

    // Bottom clearance is owned entirely by KeyboardStickyShell's own
    // computed footer padding now -- this trailing caption must not carry a
    // second, redundant `paddingBottom: insets.bottom` of its own on top of
    // that (the double-counted-inset bug that made the gap look oversized).
    const hint = screen.getByText('You can start this any time from Settings.');
    const hintStyle = [hint.props.style].flat(Infinity).filter(Boolean).reduce((acc: Record<string, unknown>, entry: Record<string, unknown>) => ({ ...acc, ...entry }), {});
    expect(hintStyle.paddingBottom).toBeUndefined();
  });

  it('starts the pipeline and navigates to progress *immediately* with full access -- the entry screen must never stay visible waiting for a run id', async () => {
    const { router } = jest.requireMock('expo-router');
    const screen = render(<GalleryImportEntry />);
    await waitFor(() => expect(screen.queryByTestId('gallery-import-choose-more')).toBeNull());
    pressStart(screen);
    // Navigation must happen synchronously off the permission check, not
    // after awaiting the runner (which can take 5-10s on a real device).
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(app)/gallery-import/progress'));
    expect(beginGalleryImportPipeline).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', familyId: 'family-1', useCellular: false, permissionMode: 'full',
    }));
    // No runId param -- the progress screen picks the run up through the
    // pending-start slot until one exists (see gallery-import-pending-start.ts).
    expect(router.replace).not.toHaveBeenCalledWith(expect.objectContaining({ params: expect.anything() }));
  });

  it('starts directly with an already-established limited grant, without a confirmation screen', async () => {
    mockAdapter.getPermission.mockResolvedValue({ state: 'limited' });
    const { router } = jest.requireMock('expo-router');
    const screen = render(<GalleryImportEntry />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-choose-more')).toBeTruthy());
    pressStart(screen);
    await waitFor(() => expect(beginGalleryImportPipeline).toHaveBeenCalled());
    expect(router.replace).toHaveBeenCalledWith('/(app)/gallery-import/progress');
    expect(screen.queryByTestId('gallery-import-permission-limited')).toBeNull();
  });

  it('gates a never-asked permission behind the trust explainer, then navigates immediately once the OS prompt resolves to full', async () => {
    mockAdapter.getPermission.mockResolvedValue({ state: 'denied' });
    mockAdapter.requestPermission.mockResolvedValue({ state: 'full' });
    const { router } = jest.requireMock('expo-router');
    const screen = render(<GalleryImportEntry />);
    pressStart(screen);
    await waitFor(() => expect(screen.getByTestId('gallery-import-trust-explainer')).toBeTruthy());
    expect(beginGalleryImportPipeline).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('gallery-import-trust-continue'));
    await waitFor(() => expect(mockAdapter.requestPermission).toHaveBeenCalled());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(app)/gallery-import/progress'));
    expect(beginGalleryImportPipeline).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'full' }));
  });

  it('shows the limited outcome screen after the OS prompt, and starts the pipeline from its primary action', async () => {
    mockAdapter.getPermission.mockResolvedValue({ state: 'denied' });
    mockAdapter.requestPermission.mockResolvedValue({ state: 'limited' });
    const { router } = jest.requireMock('expo-router');
    const screen = render(<GalleryImportEntry />);
    pressStart(screen);
    await waitFor(() => expect(screen.getByTestId('gallery-import-trust-explainer')).toBeTruthy());
    fireEvent.press(screen.getByTestId('gallery-import-trust-continue'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-permission-limited')).toBeTruthy());
    expect(beginGalleryImportPipeline).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('gallery-import-permission-limited-primary'));
    await waitFor(() => expect(beginGalleryImportPipeline).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'limited' })));
    expect(router.replace).toHaveBeenCalledWith('/(app)/gallery-import/progress');
  });

  it('shows the denied outcome screen and opens device settings for blocked, without starting a pipeline', async () => {
    mockAdapter.getPermission.mockResolvedValue({ state: 'denied' });
    mockAdapter.requestPermission.mockResolvedValue({ state: 'denied' });
    const denied = render(<GalleryImportEntry />);
    fireEvent.press(denied.getByTestId('gallery-import-start'));
    await waitFor(() => expect(denied.getByTestId('gallery-import-trust-explainer')).toBeTruthy());
    fireEvent.press(denied.getByTestId('gallery-import-trust-continue'));
    await waitFor(() => expect(denied.getByTestId('gallery-import-permission-denied')).toBeTruthy());
    expect(beginGalleryImportPipeline).not.toHaveBeenCalled();
    denied.unmount();

    mockAdapter.getPermission.mockResolvedValue({ state: 'blocked' });
    const blocked = render(<GalleryImportEntry />);
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(true);
    fireEvent.press(blocked.getByTestId('gallery-import-start'));
    await waitFor(() => expect(blocked.getByTestId('gallery-import-permission-blocked')).toBeTruthy());
    fireEvent.press(blocked.getByTestId('gallery-import-permission-blocked-primary'));
    expect(openSettings).toHaveBeenCalled();
    expect(beginGalleryImportPipeline).not.toHaveBeenCalled();
  });

  it('shows the lapsed exception up front when billing already reports no write access, without starting a pipeline', async () => {
    (useBilling as jest.Mock).mockReturnValue({ status: { has_write_access: false, has_ever_had_access: true } });
    const screen = render(<GalleryImportEntry />);
    pressStart(screen);
    await waitFor(() => expect(screen.getByTestId('gallery-import-exception-primary')).toBeTruthy());
    expect(beginGalleryImportPipeline).not.toHaveBeenCalled();
  });

  it('reports the surface param the route forwarded it', async () => {
    const { trackEvent } = jest.requireMock('@/services/analytics');
    render(<GalleryImportEntry surface="glyph" />);
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('gallery_import_opened', { surface: 'glyph' }));
  });

  it('sweeps entry copy for banned words (import/upload/scan/library) and em-dashes/double-hyphens', async () => {
    const screen = render(<GalleryImportEntry />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-entry')).toBeTruthy());
    const visibleText = collectRenderedText(screen.toJSON()).join(' ').toLowerCase();
    for (const banned of ['import', 'upload', 'scan', 'library', '—', '--']) {
      expect(visibleText).not.toContain(banned);
    }
  });

  // I4a step 5: an existing checkpoint now routes by state instead of
  // always bouncing through progress, and only advertises "Pick up where
  // you left off" once there is something ready to review.
  describe('an existing checkpoint routes by state', () => {
    it('routes straight to the review deck when suggestions are already ready, with the resume label', async () => {
      (useGalleryImportEntryStatus as jest.Mock).mockReturnValue(entryStatus({
        state: 'ready', readyCount: 5, checkpoint: { runId: 'run-1' },
      }));
      const { router } = jest.requireMock('expo-router');
      const screen = render(<GalleryImportEntry />);
      await waitFor(() => expect(screen.getByText('Pick up where you left off')).toBeTruthy());
      pressStart(screen);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/review', params: { runId: 'run-1' } }));
      expect(beginGalleryImportPipeline).not.toHaveBeenCalled();
    });

    it('routes to progress, with the default label, when a checkpoint exists but nothing is ready yet', async () => {
      (useGalleryImportEntryStatus as jest.Mock).mockReturnValue(entryStatus({
        state: 'processing', readyCount: 0, checkpoint: { runId: 'run-1' },
      }));
      const { router } = jest.requireMock('expo-router');
      const screen = render(<GalleryImportEntry />);
      expect(screen.getByText('Look through my photos')).toBeTruthy();
      pressStart(screen);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/progress', params: { runId: 'run-1' } }));
      expect(beginGalleryImportPipeline).not.toHaveBeenCalled();
    });
  });

  it('gives the screen a single exit: no second footer dismiss button next to the primary action', async () => {
    const screen = render(<GalleryImportEntry />);
    await waitFor(() => expect(screen.getByTestId('gallery-import-entry')).toBeTruthy());
    // The mocked KeyboardStickyShell above does not render `header`, so the
    // top-bar "Not now" itself isn't observable here -- gallery-import-shared.tsx's
    // own GalleryImportTopBar is unit-covered elsewhere. This only asserts
    // the footer no longer duplicates it with a second dismiss control.
    expect(screen.queryByTestId('gallery-import-not-now')).toBeNull();
    expect(screen.queryByText('Maybe later')).toBeNull();
  });
});
