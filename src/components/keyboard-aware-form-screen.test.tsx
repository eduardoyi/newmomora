import { fireEvent, render } from '@testing-library/react-native';
import { TextInput } from 'react-native';

import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { spacing } from '@/constants/theme';

describe('KeyboardAwareFormScreen', () => {
  it('keeps focused inputs inside the edge-to-edge-aware scroll view', () => {
    const onFocus = jest.fn();
    const { getByTestId } = render(
      <KeyboardAwareFormScreen>
        <TextInput onFocus={onFocus} testID="lower-form-input" />
      </KeyboardAwareFormScreen>,
    );
    const scrollView = getByTestId('keyboard-aware-form-scroll');

    fireEvent(getByTestId('lower-form-input'), 'focus');

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(scrollView.props.bottomOffset).toBe(spacing.xl);
    expect(scrollView.props.disableScrollOnKeyboardHide).toBe(true);
    expect(scrollView.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scrollView.props.mode).toBe('insets');
  });
});
