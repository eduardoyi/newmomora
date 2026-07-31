import { fireEvent, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Pressable, TextInput } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  FOOTER_KEYBOARD_CLEARANCE,
  getFooterBottomPadding,
  isOnboardingContentOverflowing,
  KEYBOARD_VERTICAL_OFFSET,
  OnbShell,
} from '@/components/onboarding/onb-shell';
import { spacing } from '@/constants/theme';

const mockedUseKeyboardState = jest.mocked(useKeyboardState);

function renderShell(element: ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 800, width: 360, x: 0, y: 0 },
        insets: { bottom: 48, left: 0, right: 0, top: 24 },
      }}
    >
      {element}
    </SafeAreaProvider>,
  );
}

describe('OnbShell', () => {
  it('keeps the footer outside the scroll body and resizes the shared frame for the keyboard', () => {
    const { getByTestId } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    fireEvent(getByTestId('onb-lower-input'), 'focus');

    const scrollView = getByTestId('onb-shell-scroll');
    const keyboardFrame = getByTestId('onb-shell-keyboard-frame');
    const footer = getByTestId('onb-shell-footer');

    // The same height-resized frame is used on both platforms, so the CTA
    // remains in layout above the IME instead of translating over the form.
    expect(keyboardFrame.props.behavior).toBe('height');
    expect(keyboardFrame.props.enabled).toBe(true);
    expect(keyboardFrame.props.automaticOffset).toBe(true);
    expect(keyboardFrame.props.keyboardVerticalOffset).toBe(KEYBOARD_VERTICAL_OFFSET);
    let footerAncestor = footer.parent;
    while (footerAncestor) {
      expect(footerAncestor).not.toBe(scrollView);
      footerAncestor = footerAncestor.parent;
    }
    expect(scrollView.props.children).not.toContain(footer);
    expect(footer.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paddingBottom: 48 + spacing.sm }),
      ]),
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
    expect(getByTestId('onb-shell-scroll').props.bottomOffset).toBe(spacing.lg);
  });

  it('drops the redundant safe-area footer gap once the keyboard opens while the screen is showing', () => {
    const { getByTestId, rerender } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    // Mounts with the keyboard closed -- the safe-area padding applies.
    expect(getByTestId('onb-shell-footer').props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paddingBottom: 48 + spacing.sm }),
      ]),
    );

    // A real keyboard-visible transition observed *after* mount (e.g. the
    // user focuses this screen's own input) still drops the redundant gap.
    // A fresh element (not the one captured above) forces React to actually
    // reconcile OnbShell again instead of bailing out on an identical
    // element reference.
    mockedUseKeyboardState.mockReturnValue(true);
    rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 800, width: 360, x: 0, y: 0 },
          insets: { bottom: 48, left: 0, right: 0, top: 24 },
        }}
      >
        <OnbShell footer={<Pressable testID="onb-primary-action" />}>
          <TextInput testID="onb-lower-input" />
        </OnbShell>
      </SafeAreaProvider>,
    );

    expect(getByTestId('onb-shell-footer').props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paddingBottom: spacing.sm }),
      ]),
    );

    // Restore the default (keyboard-hidden) mock so it doesn't leak into
    // later tests -- this test is the only one that sets a persistent
    // (non-Once) return value.
    mockedUseKeyboardState.mockReturnValue(false);
  });

  it('ignores a keyboard-visible reading inherited from the previous screen on its very first commit', () => {
    // `useKeyboardState` is backed by an app-wide singleton in
    // react-native-keyboard-controller: navigating away from a screen with a
    // focused input can leave it reporting `isVisible: true` while the
    // keyboard is still mid dismiss-animation, even on a freshly mounted
    // screen with no focused input of its own (see e.g. S6 kids -> S7
    // family-name, or S7 family-name -> S8 bridge, which has no input at
    // all). `mockReturnValueOnce` simulates exactly that stale snapshot
    // being present for this instance's first render.
    mockedUseKeyboardState.mockReturnValueOnce(true);

    const { getByTestId } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    // The CTA must clear the Android nav bar immediately -- not just once a
    // later `keyboardDidHide` event happens to correct the stale reading.
    expect(getByTestId('onb-shell-footer').props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paddingBottom: 48 + spacing.sm }),
      ]),
    );
  });

  it('adds the Android navigation-bar inset to the footer instead of letting it cover the action', () => {
    expect(getFooterBottomPadding(48, false)).toBe(48 + spacing.sm);
    expect(getFooterBottomPadding(0, false)).toBe(spacing.xl + spacing.sm);
  });

  it('does not stack the navigation-bar inset on top of an open keyboard', () => {
    expect(getFooterBottomPadding(48, true)).toBe(spacing.sm);
  });

  it('identifies only content beyond the viewport as scrollable', () => {
    expect(isOnboardingContentOverflowing(600, 600)).toBe(false);
    expect(isOnboardingContentOverflowing(600, 598)).toBe(true);
    expect(isOnboardingContentOverflowing(480, 600)).toBe(false);
  });
});
