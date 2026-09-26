import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { colors } from '@/constants/theme';
import { StubTear } from './stub-tear';

describe('StubTear', () => {
  it('punches its notches in the background behind the card, not the card color', () => {
    const { getByTestId } = render(<StubTear testID="stub-tear" />);
    for (const side of ['left', 'right']) {
      const notch = StyleSheet.flatten(getByTestId(`stub-tear-notch-${side}`).props.style);
      expect(notch.backgroundColor).toBe(colors.bg);
      expect(notch.backgroundColor).not.toBe(colors.white);
      // A rim in the card's border color makes the bite read as a hole.
      expect(notch.borderColor).toBe(colors.border);
    }
  });

  it('accepts a different background for cards on other surfaces', () => {
    const { getByTestId } = render(<StubTear backgroundColor="#F2EFF8" testID="stub-tear" />);
    expect(StyleSheet.flatten(getByTestId('stub-tear-notch-left').props.style).backgroundColor).toBe('#F2EFF8');
  });
});
