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
    // Regression (2026-07-31, later same day, file header cause D): this
    // used to be `enabled={isContentOverflowing}`, which permanently
    // disabled KeyboardAwareScrollView's own keyboard-avoidance on short,
    // centered steps (S6/S7) once `KeyboardAvoidingView` stopped resizing
    // the measured viewport on keyboard-open. `enabled` must stay `true`
    // regardless of measured content size -- see the next test.
    expect(scrollView.props.enabled).toBe(true);
  });

  it('keeps keyboard-avoidance enabled even when content does not overflow the viewport (regression: footer covering the focused input on S6/S7)', () => {
    const { getByTestId } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    // Nothing in this shell measures content vs. viewport anymore to gate
    // `enabled` -- it's simply always on (see file header, cause D, and
    // `isOnboardingContentOverflowing`'s doc comment for why that measured
    // signal is kept exported but no longer consulted here). A short,
    // well-under-viewport content size like S6/S7's must not flip this
    // back off.
    expect(getByTestId('onb-shell-scroll').props.enabled).toBe(true);
    expect(isOnboardingContentOverflowing(300, 800)).toBe(false);
  });

  it('folds the rendered footer height into bottomOffset, so a scrolled input clears the footer as well as the keyboard', () => {
    // Regression (file header cause E): `bottomOffset` used to be a fixed
    // caret-to-footer gap sized for a footer that sat *below* the scroll
    // viewport in normal flow. Now that `KeyboardStickyView` translates the
    // footer *over* the viewport instead, KeyboardAwareScrollView's own
    // "am I visible above the keyboard" math has no idea the footer is
    // there unless the footer's rendered height is folded into
    // `bottomOffset` too -- otherwise a focused input (or anything just
    // below it, like S6's "+ Add another kiddo" affordance or a helper
    // text) can clear the keyboard and still end up under the footer.
    const { getByTestId } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    const scrollView = getByTestId('onb-shell-scroll');
    const footer = getByTestId('onb-shell-footer');
    // `onLayout` is registered one level up, on the native `SafeAreaView`
    // `KeyboardStickyView` translates -- the same box whose rendered size
    // is what actually overlaps content once it's moved on screen.
    const footerSafeArea = footer.parent;

    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);

    fireEvent(footerSafeArea, 'layout', { nativeEvent: { layout: { height: 140 } } });

    expect(getByTestId('onb-shell-scroll').props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE + 140);
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
