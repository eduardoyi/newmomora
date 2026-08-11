import { fireEvent, render } from '@testing-library/react-native';

import { GalleryImportEmptyOutcome } from '@/components/gallery-import/gallery-import-empty';
import { getStickyFooterBottomPadding } from '@/components/keyboard-sticky-shell';

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() } }));

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

describe('GalleryImportEmptyOutcome', () => {
  it('never renders an em-dash or double-hyphen in any kind\'s copy', () => {
    const kinds = ['nothing', 'emptyLibrary', 'limitedNothing'] as const;
    for (const kind of kinds) {
      const screen = render(<GalleryImportEmptyOutcome kind={kind} onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} />);
      const visibleText = collectRenderedText(screen.toJSON()).join(' ');
      expect(visibleText).not.toContain('—');
      expect(visibleText).not.toContain('--');
      screen.unmount();
    }
  });

  it('renders distinct copy per empty kind and defaults a kind-scoped testID', () => {
    const nothing = render(<GalleryImportEmptyOutcome kind="nothing" onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} />);
    expect(nothing.getByTestId('gallery-import-empty-nothing')).toBeTruthy();
    expect(nothing.getByText(/Nothing stood out/)).toBeTruthy();
    nothing.unmount();

    const emptyLibrary = render(<GalleryImportEmptyOutcome kind="emptyLibrary" onClose={jest.fn()} onPrimary={jest.fn()} />);
    expect(emptyLibrary.getByTestId('gallery-import-empty-emptyLibrary')).toBeTruthy();
    expect(emptyLibrary.getByText(/No photos here/)).toBeTruthy();
    // emptyLibrary has no secondary action -- omitting onSecondary must not render a dead button.
    expect(emptyLibrary.queryByTestId('gallery-import-empty-emptyLibrary-secondary')).toBeNull();
    emptyLibrary.unmount();

    const limitedNothing = render(<GalleryImportEmptyOutcome kind="limitedNothing" onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} />);
    expect(limitedNothing.getByText(/Nothing yet from/)).toBeTruthy();
  });

  it('wires primary/secondary/close callbacks', () => {
    const onPrimary = jest.fn();
    const onSecondary = jest.fn();
    const onClose = jest.fn();
    const screen = render(<GalleryImportEmptyOutcome kind="nothing" onClose={onClose} onPrimary={onPrimary} onSecondary={onSecondary} />);
    fireEvent.press(screen.getByTestId('gallery-import-empty-nothing-primary'));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('gallery-import-empty-nothing-secondary'));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('gallery-import-empty-nothing-top-bar-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('scrolls its body and applies the real top/bottom safe-area insets', () => {
    const screen = render(<GalleryImportEmptyOutcome kind="nothing" onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} />);
    expect(screen.getByTestId('gallery-import-empty-nothing-scroll')).toBeTruthy();

    const tree = screen.toJSON();
    const outer = Array.isArray(tree) ? tree[0] : tree;
    const outerStyle = [outer.props.style].flat(Infinity).filter(Boolean);
    expect(outerStyle).toEqual(expect.arrayContaining([expect.objectContaining({ paddingTop: TEST_INSETS.top })]));

    const footer = screen.getByTestId('gallery-import-empty-nothing-footer');
    const footerStyle = [footer.props.style].flat(Infinity).filter(Boolean);
    expect(footerStyle).toEqual(expect.arrayContaining([
      expect.objectContaining({ paddingBottom: TEST_INSETS.bottom + getStickyFooterBottomPadding(TEST_INSETS.bottom) }),
    ]));
    expect(footerStyle.some((entry: any) => entry?.backgroundColor)).toBe(true);
    // The shared gi.stickyFooterSurface hairline top border, so content
    // reads as sliding under a deliberate floating surface.
    expect(footerStyle.some((entry: any) => entry?.borderTopWidth > 0 && entry?.borderTopColor)).toBe(true);
  });
});
