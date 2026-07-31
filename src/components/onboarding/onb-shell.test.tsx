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

  it('drops the redundant safe-area footer gap while the keyboard is open', () => {
    mockedUseKeyboardState.mockReturnValueOnce(true);

    const { getByTestId } = renderShell(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    expect(getByTestId('onb-shell-footer').props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paddingBottom: spacing.sm }),
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
