import { fireEvent, render } from '@testing-library/react-native';

import { AuthButton, AuthField, AuthInput, AuthScreen } from '@/components/auth-screen';
import { spacing } from '@/constants/theme';

describe('AuthScreen', () => {
  it('keeps the focused field and its submit button above the Android keyboard', () => {
    const onSubmit = jest.fn();
    const { getByTestId } = render(
      <AuthScreen subtitle="Enter your email to continue." title="Welcome back">
        <AuthField label="Email">
          <AuthInput testID="auth-email-input" />
        </AuthField>
        <AuthButton label="Continue" onPress={onSubmit} testID="auth-submit-button" />
      </AuthScreen>,
    );
    const scrollView = getByTestId('auth-screen-scroll');

    fireEvent(getByTestId('auth-email-input'), 'focus');
    fireEvent.press(getByTestId('auth-submit-button'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Enough room under the focused input for the CTA that sits beneath it.
    expect(scrollView.props.bottomOffset).toBe(spacing.xxl * 2);
    expect(scrollView.props.disableScrollOnKeyboardHide).toBe(true);
    expect(scrollView.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scrollView.props.mode).toBe('insets');
  });
});
