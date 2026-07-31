import { fireEvent, render } from '@testing-library/react-native';
import { Pressable, TextInput } from 'react-native';

import {
  FOOTER_KEYBOARD_CLEARANCE,
  OnbShell,
} from '@/components/onboarding/onb-shell';
import { spacing } from '@/constants/theme';

describe('OnbShell', () => {
  it('shrinks the shared frame around the sticky footer instead of translating the footer over form controls', () => {
    const { getByTestId } = render(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    fireEvent(getByTestId('onb-lower-input'), 'focus');

    const scrollView = getByTestId('onb-shell-scroll');
    const keyboardFrame = getByTestId('onb-shell-keyboard-frame');
    const footer = getByTestId('onb-shell-footer');

    // This structural contract prevents the observed iOS regression: a
    // translated footer floated over the kids/family/account inputs and
    // intercepted taps. The whole frame now loses keyboard height, while the
    // footer remains a normal sibling below the scroll viewport.
    expect(keyboardFrame.props.behavior).toBe('height');
    expect(keyboardFrame.props.automaticOffset).toBe(true);
    expect(keyboardFrame.props.keyboardVerticalOffset).toBe(spacing.xl);
    let footerAncestor = footer.parent;
    while (footerAncestor) {
      expect(footerAncestor).not.toBe(scrollView);
      footerAncestor = footerAncestor.parent;
    }
    expect(scrollView.props.children).not.toContain(footer);
    expect(footer.props.style).toEqual(expect.objectContaining({ paddingBottom: 40 }));
    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);
    expect(FOOTER_KEYBOARD_CLEARANCE).toBeGreaterThan(spacing.xxl * 2);
    expect(scrollView.props.mode).toBe('insets');
  });

  it('does not reserve a phantom action area on steps without a footer', () => {
    const { getByTestId, queryByTestId } = render(
      <OnbShell>
        <TextInput testID="onb-input-without-footer" />
      </OnbShell>,
    );

    expect(queryByTestId('onb-shell-footer')).toBeNull();
    expect(getByTestId('onb-shell-scroll').props.bottomOffset).toBe(spacing.lg);
  });
});
