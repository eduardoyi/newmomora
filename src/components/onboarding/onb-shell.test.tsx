import { fireEvent, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Pressable, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  FOOTER_KEYBOARD_CLEARANCE,
  getFooterBottomPadding,
  isOnboardingContentOverflowing,
  OnbShell,
} from '@/components/onboarding/onb-shell';
import { spacing } from '@/constants/theme';

function renderShell(element: ReactElement, bottomInset = 48) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 800, width: 360, x: 0, y: 0 },
        insets: { bottom: bottomInset, left: 0, right: 0, top: 24 },
      }}
    >
      {element}
    </SafeAreaProvider>,
  );
}

describe('OnbShell', () => {
  it('keeps the footer outside the scroll body, in a footer that sticks to the keyboard', () => {
    const { getByTestId } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    const scrollView = getByTestId('onb-shell-scroll');
    const stickyFooter = getByTestId('onb-shell-sticky-footer');
    const footer = getByTestId('onb-shell-footer');

    // `KeyboardStickyView` reads the keyboard controller's continuously
    // running animated value directly, so the footer stays correctly
    // positioned even when a screen mounts mid keyboard-animation (see file
    // header, cause A) -- unlike the `KeyboardAvoidingView`-based frame this
    // replaced, there's no separate `enabled`/`behavior` layout mode to
    // assert on here.
    expect(stickyFooter.props.offset).toEqual({ closed: 0, opened: 48 });

    let footerAncestor = footer.parent;
    while (footerAncestor) {
      expect(footerAncestor).not.toBe(scrollView);
      footerAncestor = footerAncestor.parent;
    }
    expect(scrollView.props.children).not.toContain(footer);

    // The native `SafeAreaView edges={['bottom']}` between the sticky view
    // and the footer is the single owner of nav-bar/home-indicator
    // clearance now (cause B/C); the footer's own JS padding just tops up
    // the design's usual gap when that native inset is smaller than it.
    expect(footer.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: spacing.sm })]),
    );
    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);
    expect(FOOTER_KEYBOARD_CLEARANCE).toBeLessThan(spacing.xxl * 2);
    expect(scrollView.props.disableScrollOnKeyboardHide).toBe(false);
    expect(scrollView.props.mode).toBe('insets');
    expect(scrollView.props.bounces).toBe(false);
    expect(scrollView.props.overScrollMode).toBe('never');
    expect(scrollView.props.enabled).toBe(false);
    expect(scrollView.props.onContentSizeChange).toEqual(expect.any(Function));
    expect(scrollView.props.onLayout).toEqual(expect.any(Function));
  });

  it('only enables keyboard spacer scrolling after content exceeds the measured viewport', () => {
    const { getByTestId } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    const scrollView = getByTestId('onb-shell-scroll');
    expect(scrollView.props.enabled).toBe(false);

    fireEvent(scrollView, 'layout', { nativeEvent: { layout: { height: 480 } } });
    fireEvent(scrollView, 'contentSizeChange', 360, 480);
    expect(getByTestId('onb-shell-scroll').props.enabled).toBe(false);

    fireEvent(scrollView, 'contentSizeChange', 360, 800);
    expect(getByTestId('onb-shell-scroll').props.enabled).toBe(true);
  });

  it('does not reserve a phantom action area on steps without a footer', () => {
    const { getByTestId, queryByTestId } = renderShell(
      <OnbShell>
        <TextInput testID="onb-input-without-footer" />
      </OnbShell>,
    );

    expect(queryByTestId('onb-shell-footer')).toBeNull();
    expect(queryByTestId('onb-shell-sticky-footer')).toBeNull();
    expect(getByTestId('onb-shell-scroll').props.bottomOffset).toBe(spacing.lg);
  });

  it('tops the footer gap up to the design floor when the native bottom inset is smaller than it', () => {
    // Inset-less device (e.g. Android hardware nav buttons): the native
    // `SafeAreaView edges={['bottom']}` contributes ~0, so the footer's own
    // padding should supply the full design gap instead of leaving the CTA
    // flush with the screen edge.
    const { getByTestId } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
      0,
    );

    expect(getByTestId('onb-shell-footer').props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paddingBottom: spacing.xl + spacing.sm }),
      ]),
    );
    expect(getByTestId('onb-shell-sticky-footer').props.offset).toEqual({ closed: 0, opened: 0 });
  });

  it('exposes getFooterBottomPadding for year.tsx, which owns its own bottom clearance in JS', () => {
    // app/(onboarding)/year.tsx deliberately doesn't use OnbShell (see its
    // header comment) and calls this helper directly with its own
    // `bottomInset`, with no native `SafeAreaView edges={['bottom']}`
    // wrapping its footer -- so, unlike OnbShell's own footer padding, this
    // must keep returning the full clearance amount unchanged.
    expect(getFooterBottomPadding(48, false)).toBe(48 + spacing.sm);
    expect(getFooterBottomPadding(0, false)).toBe(spacing.xl + spacing.sm);
  });

  it('ignores the isKeyboardVisible parameter (OnbShell no longer tracks keyboard state)', () => {
    // The parameter is kept only so year.tsx's existing call site --
    // `getFooterBottomPadding(bottomInset, false)` -- keeps compiling;
    // changing this signature would mean editing year.tsx, which is out of
    // scope here. Confirm it's truly inert rather than silently reviving
    // the old compact-padding branch.
    expect(getFooterBottomPadding(48, true)).toBe(getFooterBottomPadding(48, false));
    expect(getFooterBottomPadding(0, true)).toBe(getFooterBottomPadding(0, false));
  });

  it('identifies only content beyond the viewport as scrollable', () => {
    expect(isOnboardingContentOverflowing(600, 600)).toBe(false);
    expect(isOnboardingContentOverflowing(600, 598)).toBe(true);
    expect(isOnboardingContentOverflowing(480, 600)).toBe(false);
  });
});
