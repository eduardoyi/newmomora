import { fireEvent, render } from '@testing-library/react-native';

import { GalleryImportExceptionScreen } from '@/components/gallery-import/gallery-import-exception';
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

describe('GalleryImportExceptionScreen', () => {
  const kinds = ['lapsed', 'demoted', 'capped', 'offline', 'errorRecoverable', 'errorFinal'] as const;

  it('renders every distinguishable exception kind with its own copy', () => {
    for (const kind of kinds) {
      const screen = render(<GalleryImportExceptionScreen kind={kind} onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} />);
      expect(screen.getByTestId('gallery-import-exception-primary')).toBeTruthy();
      screen.unmount();
    }
  });

  it('never renders an em-dash or double-hyphen in any kind\'s copy', () => {
    for (const kind of kinds) {
      const screen = render(<GalleryImportExceptionScreen kind={kind} onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} readyCount={9} reviewDaysLeft={26} />);
      const visibleText = collectRenderedText(screen.toJSON()).join(' ');
      expect(visibleText).not.toContain('—');
      expect(visibleText).not.toContain('--');
      screen.unmount();
    }
  });

  it('folds a real ready count and review-days-left into the lapsed note without fabricating one when absent', () => {
    const withCounts = render(<GalleryImportExceptionScreen kind="lapsed" onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} readyCount={9} reviewDaysLeft={26} />);
    expect(withCounts.getByText(/9 suggestions still here are safe for 26 more days/)).toBeTruthy();
    withCounts.unmount();

    const withoutCounts = render(<GalleryImportExceptionScreen kind="lapsed" onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} />);
    expect(withoutCounts.queryByText(/suggestions still here/)).toBeNull();
  });

  it('shows no note at all for any kind other than lapsed, even when counts are supplied', () => {
    for (const kind of kinds.filter((item) => item !== 'lapsed')) {
      const screen = render(<GalleryImportExceptionScreen kind={kind} onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} readyCount={9} reviewDaysLeft={26} />);
      expect(screen.queryByText(/suggestions still here/)).toBeNull();
      screen.unmount();
    }
  });

  it('wires primary/secondary/close', () => {
    const onPrimary = jest.fn();
    const onSecondary = jest.fn();
    const onClose = jest.fn();
    const screen = render(<GalleryImportExceptionScreen kind="errorFinal" onClose={onClose} onPrimary={onPrimary} onSecondary={onSecondary} />);
    fireEvent.press(screen.getByTestId('gallery-import-exception-primary'));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('gallery-import-exception-secondary'));
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it('scrolls its body and applies the real top/bottom safe-area insets', () => {
    const testID = 'gallery-import-exception-test';
    const screen = render(<GalleryImportExceptionScreen kind="errorFinal" onClose={jest.fn()} onPrimary={jest.fn()} onSecondary={jest.fn()} testID={testID} />);
    expect(screen.getByTestId(`${testID}-scroll`)).toBeTruthy();

    const tree = screen.toJSON();
    const outer = Array.isArray(tree) ? tree[0] : tree;
    const outerStyle = [outer.props.style].flat(Infinity).filter(Boolean);
    expect(outerStyle).toEqual(expect.arrayContaining([expect.objectContaining({ paddingTop: TEST_INSETS.top })]));

    const footer = screen.getByTestId(`${testID}-footer`);
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
