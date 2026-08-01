import { fireEvent, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Pressable, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  FOOTER_KEYBOARD_CLEARANCE,
  getStickyFooterBottomPadding,
  KeyboardStickyShell,
  MIN_FOOTER_BOTTOM_PADDING,
} from '@/components/keyboard-sticky-shell';
import { spacing } from '@/constants/theme';

// Direct coverage of the shared mechanism `OnbShell` (onboarding) and
// `AuthScreen` (auth) both wrap -- see this file's header for the incident
// history it fixes. `onb-shell.test.tsx` and `auth-screen.test.tsx` cover
// the same behavior indirectly through their respective wrappers; this file
// exercises the extracted unit itself so the mechanism has coverage even if
// a future caller wraps it with unfamiliar styling.
function renderShell(element: ReactElement, bottomInset = 34) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: bottomInset, left: 0, right: 0, top: 47 },
      }}
    >
      {element}
    </SafeAreaProvider>,
  );
}

describe('KeyboardStickyShell', () => {
  it('keeps the footer outside the scroll body, in a footer that sticks to the keyboard', () => {
    const { getByTestId } = renderShell(
      <KeyboardStickyShell
        footer={<Pressable testID="shell-primary-action" />}
        footerTestID="shell-footer"
        scrollTestID="shell-scroll"
        stickyFooterTestID="shell-sticky-footer"
      >
        <TextInput testID="shell-lower-input" />
      </KeyboardStickyShell>,
    );

    const scrollView = getByTestId('shell-scroll');
    const stickyFooter = getByTestId('shell-sticky-footer');
    const footer = getByTestId('shell-footer');

    expect(stickyFooter.props.offset).toEqual({ closed: 0, opened: 34 });

    let footerAncestor = footer.parent;
    while (footerAncestor) {
      expect(footerAncestor).not.toBe(scrollView);
      footerAncestor = footerAncestor.parent;
    }

    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);
    expect(scrollView.props.disableScrollOnKeyboardHide).toBe(false);
    expect(scrollView.props.mode).toBe('insets');
    expect(scrollView.props.bounces).toBe(false);
    expect(scrollView.props.overScrollMode).toBe('never');
    expect(scrollView.props.keyboardShouldPersistTaps).toBe('handled');
    // Never gate this on measured content overflow -- see onb-shell.tsx's
    // file header, cause D, for why that permanently breaks keyboard
    // avoidance on short screens once the footer sits over them.
    expect(scrollView.props.enabled).toBe(true);
  });

  it("folds the rendered footer height into bottomOffset, so a scrolled input clears the footer as well as the keyboard", () => {
    const { getByTestId } = renderShell(
      <KeyboardStickyShell footer={<Pressable testID="shell-primary-action" />} scrollTestID="shell-scroll">
        <TextInput testID="shell-lower-input" />
      </KeyboardStickyShell>,
    );

    const scrollView = getByTestId('shell-scroll');
    const footer = getByTestId('shell-primary-action');

    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);

    // `onLayout` is registered on the native `SafeAreaView` two levels above
    // the footer content -- the same box `KeyboardStickyView` translates.
    const footerSafeArea = footer.parent?.parent;
    fireEvent(footerSafeArea, 'layout', { nativeEvent: { layout: { height: 96 } } });

    expect(getByTestId('shell-scroll').props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE + 96);
  });

  it('does not reserve a phantom action area on screens without a footer', () => {
    const { getByTestId, queryByTestId } = renderShell(
      <KeyboardStickyShell footerTestID="shell-footer" scrollTestID="shell-scroll" stickyFooterTestID="shell-sticky-footer">
        <TextInput testID="shell-input-without-footer" />
      </KeyboardStickyShell>,
    );

    expect(queryByTestId('shell-footer')).toBeNull();
    expect(queryByTestId('shell-sticky-footer')).toBeNull();
    expect(getByTestId('shell-scroll').props.bottomOffset).toBe(spacing.lg);
  });

  it('tops the footer gap up to the design floor when the native bottom inset is smaller than it', () => {
    const { getByTestId } = renderShell(
      <KeyboardStickyShell
        footer={<Pressable testID="shell-primary-action" />}
        footerTestID="shell-footer"
        scrollTestID="shell-scroll"
        stickyFooterTestID="shell-sticky-footer"
      >
        <TextInput testID="shell-lower-input" />
      </KeyboardStickyShell>,
      0,
    );

    expect(getByTestId('shell-footer').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: MIN_FOOTER_BOTTOM_PADDING })]),
    );
    expect(getByTestId('shell-sticky-footer').props.offset).toEqual({ closed: 0, opened: 0 });
  });

  it('exposes getStickyFooterBottomPadding as a pure helper matching the design floor', () => {
    expect(getStickyFooterBottomPadding(48)).toBe(spacing.sm);
    expect(getStickyFooterBottomPadding(0)).toBe(MIN_FOOTER_BOTTOM_PADDING);
  });

  it('lets a caller supply a custom keyboardBottomOffset', () => {
    const { getByTestId } = renderShell(
      <KeyboardStickyShell
        footer={<Pressable testID="shell-primary-action" />}
        keyboardBottomOffset={spacing.md}
        scrollTestID="shell-scroll"
      >
        <TextInput testID="shell-lower-input" />
      </KeyboardStickyShell>,
    );

    expect(getByTestId('shell-scroll').props.bottomOffset).toBe(spacing.md);
  });
});
