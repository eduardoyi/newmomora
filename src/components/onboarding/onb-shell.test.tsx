import { fireEvent, render } from '@testing-library/react-native';
import { Pressable, TextInput } from 'react-native';

import { OnbShell } from '@/components/onboarding/onb-shell';
import { spacing } from '@/constants/theme';

describe('OnbShell', () => {
  it('keeps the footer outside the scrollable input body and attaches it to keyboard movement', () => {
    const { getByTestId } = render(
      <OnbShell footer={<Pressable testID="onb-primary-action" />}>
        <TextInput testID="onb-lower-input" />
      </OnbShell>,
    );

    fireEvent(getByTestId('onb-lower-input'), 'focus');

    const scrollView = getByTestId('onb-shell-scroll');
    const stickyFooter = getByTestId('onb-shell-footer');

    // This is a structural contract, not just a keyboard-controller prop:
    // the action is a sibling of the scroll view, so it cannot be scrolled
    // under the IME with the rest of the page.
    let footerAncestor = stickyFooter.parent;
    while (footerAncestor) {
      expect(footerAncestor).not.toBe(scrollView);
      footerAncestor = footerAncestor.parent;
    }
    expect(scrollView.props.children).not.toContain(stickyFooter);
    expect(stickyFooter.props.children.props.style).toEqual(
      expect.objectContaining({ paddingBottom: 40 }),
    );
    expect(scrollView.props.bottomOffset).toBe(spacing.xxl * 2);
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
