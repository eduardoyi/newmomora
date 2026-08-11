import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import Svg from 'react-native-svg';

import { GalleryImportTopBar, gi } from '@/components/gallery-import/gallery-import-shared';

jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() } }));

describe('gi.stickyFooterSurface', () => {
  it('gives every gallery-import fixed footer one shared solid-background + hairline-top-border treatment, with no bottom-padding value of its own', () => {
    // Bottom clearance belongs entirely to KeyboardStickyShell's own
    // `getStickyFooterBottomPadding` computation (real safe-area inset +
    // a modest top-up token) -- a per-screen paddingBottom baked into this
    // shared surface style would double-count that inset, which is exactly
    // the reported oversized-footer-gap regression.
    expect(gi.stickyFooterSurface.backgroundColor).toBeTruthy();
    expect(gi.stickyFooterSurface.borderTopWidth).toBeGreaterThan(0);
    expect(gi.stickyFooterSurface.borderTopColor).toBeTruthy();
    expect(gi.stickyFooterSurface).not.toHaveProperty('paddingBottom');
  });
});

describe('GalleryImportTopBar', () => {
  const originalOS = Platform.OS;
  afterEach(() => { Platform.OS = originalOS; });

  it('renders the design-spec Android chevron: 22px ink icon centered in a 44x44 round touchable', () => {
    // Design gi-shared.jsx GITopBar verbatim. The regression this guards:
    // the bar must own its edge padding (paddingLeft 12) and be rendered
    // full-bleed via KeyboardStickyShell's `header` slot -- rendering it
    // inside a padded content container stacked paddings and pushed the
    // chevron ~2x too far from the edge on device.
    Platform.OS = 'android';
    const screen = render(<GalleryImportTopBar left="Not now" onLeft={jest.fn()} testID="top-bar-back" />);
    const back = screen.getByTestId('top-bar-back');
    expect(back.findAllByType(Svg).length).toBe(1);
    const style = [back.props.style].flat(Infinity).filter(Boolean).reduce((acc: Record<string, unknown>, entry: Record<string, unknown>) => ({ ...acc, ...entry }), {});
    expect(style.width).toBe(44);
    expect(style.height).toBe(44);
    expect(screen.queryByText('Not now')).toBeNull();
  });

  it('keeps the bar right padding design-exact', () => {
    // paddingLeft is platform-computed at module load (12 android / 20 ios)
    // and cannot be flipped per-test; the right edge is 20 on both.
    expect(gi.topBar.paddingRight).toBe(20);
  });

  it('still renders the iOS text button unaffected', () => {
    Platform.OS = 'ios';
    const screen = render(<GalleryImportTopBar left="Cancel" onLeft={jest.fn()} testID="top-bar-cancel" />);
    expect(screen.getByText('Cancel')).toBeTruthy();
  });
});
