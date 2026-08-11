import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { GalleryImportPermissionOutcome, GalleryImportTrustExplainer } from '@/components/gallery-import/gallery-import-trust';
import { getStickyFooterBottomPadding } from '@/components/keyboard-sticky-shell';

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() } }));

// A faithful-enough stand-in for react-native-safe-area-context: applies
// paddingTop/Bottom/Left/Right from a *nonzero* inset per requested `edges`,
// the same way the real SafeAreaView does, so a regression that drops or
// double-applies the inset (as the device-tested trust-explainer bug did --
// content starting behind the status bar, footer with no bottom clearance)
// shows up as a real assertion failure instead of passing against a dumb
// pass-through mock.
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

/** Walks a react-test-renderer JSON tree and collects only actual rendered
 * text nodes, so a copy sweep can't be fooled by a testID/style value that
 * happens to contain a stray character. See gallery-import-entry.integration.test.tsx
 * for the original of this helper. */
function collectRenderedText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((child) => collectRenderedText(child, out)); return out; }
  if (typeof node === 'object' && node !== null && 'children' in node) {
    collectRenderedText((node as { children?: unknown }).children, out);
  }
  return out;
}

describe('GalleryImportTrustExplainer', () => {
  it('never renders an em-dash or double-hyphen, including inside both detail sheets', async () => {
    const screen = render(<GalleryImportTrustExplainer onCancel={jest.fn()} onContinue={jest.fn()} reviewDays={26} />);
    expect(collectRenderedText(screen.toJSON()).join(' ')).not.toContain('—');
    expect(collectRenderedText(screen.toJSON()).join(' ')).not.toContain('--');

    fireEvent.press(screen.getByTestId('gallery-import-trust-detail-What a preview is'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-trust-preview-sheet')).toBeTruthy());
    let visibleText = collectRenderedText(screen.toJSON()).join(' ');
    expect(visibleText).not.toContain('—');
    expect(visibleText).not.toContain('--');
    fireEvent.press(screen.getByTestId('gallery-import-trust-preview-sheet-close'));

    fireEvent.press(screen.getByTestId('gallery-import-trust-detail-What is kept, and for how long'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-trust-retention-sheet')).toBeTruthy());
    visibleText = collectRenderedText(screen.toJSON()).join(' ');
    expect(visibleText).not.toContain('—');
    expect(visibleText).not.toContain('--');
  });

  it('shows the three trust cards and opens both detail sheets', async () => {
    const onContinue = jest.fn();
    const onCancel = jest.fn();
    const screen = render(<GalleryImportTrustExplainer onCancel={onCancel} onContinue={onContinue} reviewDays={26} />);
    expect(screen.getByText('Your phone does the looking')).toBeTruthy();
    expect(screen.getByText(/Small previews are sent/)).toBeTruthy();
    expect(screen.getByText('Only what you keep is saved')).toBeTruthy();

    fireEvent.press(screen.getByTestId('gallery-import-trust-detail-What a preview is'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-trust-preview-sheet')).toBeTruthy());
    // The detail sheet's own content must scroll rather than silently clip --
    // device testing found long sheet content unreachable.
    expect(screen.getByTestId('gallery-import-trust-preview-sheet-scroll')).toBeTruthy();

    fireEvent.press(screen.getByTestId('gallery-import-trust-detail-What is kept, and for how long'));
    await waitFor(() => expect(screen.getByTestId('gallery-import-trust-retention-sheet')).toBeTruthy());
    expect(screen.getByText(/Up to 26 days/)).toBeTruthy();
  });

  it('gives Not now equal weight to the primary action', () => {
    const onContinue = jest.fn();
    const onCancel = jest.fn();
    const screen = render(<GalleryImportTrustExplainer onCancel={onCancel} onContinue={onContinue} />);
    fireEvent.press(screen.getByTestId('gallery-import-trust-not-now'));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('gallery-import-trust-continue'));
    expect(onContinue).toHaveBeenCalled();
  });

  it('uses iOS vs Android continue copy', () => {
    const ios = render(<GalleryImportTrustExplainer onCancel={jest.fn()} onContinue={jest.fn()} platform="ios" />);
    expect(ios.getByText('Choose which photos')).toBeTruthy();
    const android = render(<GalleryImportTrustExplainer onCancel={jest.fn()} onContinue={jest.fn()} platform="android" />);
    expect(android.getByText('Continue')).toBeTruthy();
  });

  it('scrolls its body and applies the real top/bottom safe-area insets, not a fixed simulated status-bar padding', () => {
    const screen = render(<GalleryImportTrustExplainer onCancel={jest.fn()} onContinue={jest.fn()} />);
    // A real ScrollView, not a plain View that lets tall content clip
    // unreachably -- the device-tested "screen does not scroll at all" bug.
    expect(screen.getByTestId('gallery-import-trust-scroll')).toBeTruthy();

    const tree = screen.toJSON();
    const outer = Array.isArray(tree) ? tree[0] : tree;
    const outerStyle = [outer.props.style].flat(Infinity).filter(Boolean);
    expect(outerStyle).toEqual(expect.arrayContaining([expect.objectContaining({ paddingTop: TEST_INSETS.top })]));

    // The footer must fold the real bottom inset into its own padding
    // (KeyboardStickyShell's own computation), not a hard-coded value that
    // ignores the device -- and it must carry an opaque background plus a
    // hairline top border (the shared gi.stickyFooterSurface treatment) so
    // scrolled content reads as sliding under a deliberate floating
    // surface, not clipping behind a flat, accidental-looking cut.
    const footer = screen.getByTestId('gallery-import-trust-footer');
    const footerStyle = [footer.props.style].flat(Infinity).filter(Boolean);
    expect(footerStyle).toEqual(expect.arrayContaining([
      expect.objectContaining({ paddingBottom: TEST_INSETS.bottom + getStickyFooterBottomPadding(TEST_INSETS.bottom) }),
    ]));
    expect(footerStyle.some((entry: any) => entry?.backgroundColor)).toBe(true);
    expect(footerStyle.some((entry: any) => entry?.borderTopWidth > 0 && entry?.borderTopColor)).toBe(true);

    // The trailing caption must not stack a second, redundant safe-area
    // inset of its own on top of the shell's already inset-aware padding
    // (the reported oversized-gap bug).
    const hint = screen.getByText(/will ask what Momora may see/);
    const hintStyle = [hint.props.style].flat(Infinity).filter(Boolean).reduce((acc: Record<string, unknown>, entry: Record<string, unknown>) => ({ ...acc, ...entry }), {});
    expect(hintStyle.paddingBottom).toBeUndefined();
  });
});

describe('GalleryImportPermissionOutcome', () => {
  it('never renders an em-dash or double-hyphen in any outcome kind\'s copy', () => {
    const kinds = ['limited', 'denied', 'blocked'] as const;
    for (const kind of kinds) {
      for (const platform of ['ios', 'android'] as const) {
        const screen = render(<GalleryImportPermissionOutcome accessibleCount={4} kind={kind} onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} platform={platform} />);
        const visibleText = collectRenderedText(screen.toJSON()).join(' ');
        expect(visibleText).not.toContain('—');
        expect(visibleText).not.toContain('--');
        screen.unmount();
      }
    }
  });

  it('renders distinct copy and actions per permission outcome kind', () => {
    const onPrimary = jest.fn();
    const onSecondary = jest.fn();
    const onClose = jest.fn();

    const limited = render(<GalleryImportPermissionOutcome kind="limited" onClose={onClose} onPrimary={onPrimary} onSecondary={onSecondary} />);
    expect(limited.getByText(/Momora can see/)).toBeTruthy();
    fireEvent.press(limited.getByTestId('gallery-import-permission-limited-primary'));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    fireEvent.press(limited.getByTestId('gallery-import-permission-limited-top-bar-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    limited.unmount();

    const denied = render(<GalleryImportPermissionOutcome kind="denied" onClose={onClose} onPrimary={onPrimary} onSecondary={onSecondary} />);
    expect(denied.getByText(/Momora cannot/)).toBeTruthy();
    denied.unmount();

    const blocked = render(<GalleryImportPermissionOutcome kind="blocked" onClose={onClose} onPrimary={onPrimary} onSecondary={onSecondary} />);
    expect(blocked.getByText(/has to/)).toBeTruthy();
  });

  it('keeps Close distinct from the labeled secondary action', () => {
    const onSecondary = jest.fn();
    const onClose = jest.fn();
    const screen = render(<GalleryImportPermissionOutcome kind="limited" onClose={onClose} onPrimary={jest.fn()} onSecondary={onSecondary} />);
    fireEvent.press(screen.getByTestId('gallery-import-permission-limited-secondary'));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('scrolls and applies real safe-area insets, same as the explainer', () => {
    const screen = render(<GalleryImportPermissionOutcome kind="blocked" onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} />);
    expect(screen.getByTestId('gallery-import-permission-blocked-scroll')).toBeTruthy();
    const footer = screen.getByTestId('gallery-import-permission-blocked-footer');
    const footerStyle = [footer.props.style].flat(Infinity).filter(Boolean);
    expect(footerStyle).toEqual(expect.arrayContaining([
      expect.objectContaining({ paddingBottom: TEST_INSETS.bottom + getStickyFooterBottomPadding(TEST_INSETS.bottom) }),
    ]));
    expect(footerStyle.some((entry: any) => entry?.backgroundColor)).toBe(true);
    expect(footerStyle.some((entry: any) => entry?.borderTopWidth > 0 && entry?.borderTopColor)).toBe(true);
  });
});
