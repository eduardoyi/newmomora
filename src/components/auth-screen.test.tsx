import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthButton, AuthErrorMessage, AuthField, AuthInput, AuthScreen } from '@/components/auth-screen';
import { FOOTER_KEYBOARD_CLEARANCE } from '@/components/keyboard-sticky-shell';
import { spacing } from '@/constants/theme';

function renderScreen(element: React.ReactElement, bottomInset = 34) {
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

describe('AuthScreen', () => {
  it('renders the wordmark, headline and subtitle above the form', () => {
    const { getByText } = renderScreen(
      <AuthScreen subtitle="Enter your email to continue." title="Welcome back">
        <AuthField label="Email">
          <AuthInput testID="auth-email-input" />
        </AuthField>
      </AuthScreen>,
    );

    expect(getByText('Welcome back')).toBeTruthy();
    expect(getByText('Enter your email to continue.')).toBeTruthy();
  });

  it('keeps the footer outside the scroll body, in a footer that sticks to the keyboard (regression: keyboard covering the submit button)', () => {
    const onSubmit = jest.fn();
    const { getByTestId } = renderScreen(
      <AuthScreen
        footer={<AuthButton label="Continue" onPress={onSubmit} testID="auth-submit-button" />}
        subtitle="Enter your email to continue."
        title="Welcome back"
      >
        <AuthField label="Email">
          <AuthInput testID="auth-email-input" />
        </AuthField>
      </AuthScreen>,
    );

    const scrollView = getByTestId('auth-screen-scroll');
    const footer = getByTestId('auth-submit-button');

    // The submit button must not be a descendant of the scroll view --
    // otherwise it scrolls out of view / under the keyboard instead of
    // staying pinned above it (the original bug on app/(auth)/login.tsx).
    let ancestor = footer.parent;
    let foundScrollView = false;
    while (ancestor) {
      if (ancestor === scrollView) {
        foundScrollView = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    expect(foundScrollView).toBe(false);

    fireEvent(getByTestId('auth-email-input'), 'focus');
    fireEvent.press(footer);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);
    expect(scrollView.props.disableScrollOnKeyboardHide).toBe(false);
    expect(scrollView.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scrollView.props.mode).toBe('insets');
    expect(scrollView.props.enabled).toBe(true);
  });

  it('folds the rendered footer height into bottomOffset, so a scrolled input clears the footer as well as the keyboard', () => {
    // Mirrors onb-shell.test.tsx's equivalent regression test:
    // `KeyboardAwareScrollView` computes its visible region as window-minus-
    // keyboard and has no idea the sticky footer overlays the bottom of
    // that region too, so the footer's rendered height has to be folded
    // into `bottomOffset` or a focused field can clear the keyboard and
    // still end up hidden under the footer.
    const { getByTestId } = renderScreen(
      <AuthScreen
        footer={<AuthButton label="Continue" onPress={jest.fn()} testID="auth-submit-button" />}
        subtitle="Enter your email to continue."
        title="Welcome back"
      >
        <AuthField label="Email">
          <AuthInput testID="auth-email-input" />
        </AuthField>
      </AuthScreen>,
    );

    const scrollView = getByTestId('auth-screen-scroll');
    const footer = getByTestId('auth-submit-button');

    expect(scrollView.props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE);

    // The `onLayout` handler is registered on the native `SafeAreaView`
    // wrapping the footer content, two levels up from the button itself.
    const footerSafeArea = footer.parent?.parent;
    fireEvent(footerSafeArea, 'layout', { nativeEvent: { layout: { height: 140 } } });

    expect(getByTestId('auth-screen-scroll').props.bottomOffset).toBe(FOOTER_KEYBOARD_CLEARANCE + 140);
  });

  it('does not reserve a phantom action area on screens without a footer', () => {
    const { getByTestId, queryByTestId } = renderScreen(
      <AuthScreen subtitle="Enter your email to continue." title="Welcome back">
        <AuthField label="Email">
          <AuthInput testID="auth-email-input" />
        </AuthField>
      </AuthScreen>,
    );

    expect(queryByTestId('auth-submit-button')).toBeNull();
    expect(getByTestId('auth-screen-scroll').props.bottomOffset).toBe(spacing.lg);
  });

  it('renders AuthErrorMessage only when there is a message, unaffected by the shell restyle', () => {
    const { queryByRole, rerender } = renderScreen(
      <AuthScreen subtitle="s" title="t">
        <AuthErrorMessage message="" />
      </AuthScreen>,
    );
    expect(queryByRole('alert')).toBeNull();

    rerender(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <AuthScreen subtitle="s" title="t">
          <AuthErrorMessage message="Something went wrong." />
        </AuthScreen>
      </SafeAreaProvider>,
    );
    expect(queryByRole('alert')).toBeTruthy();
  });

  it('lets a caller override the scroll and wordmark testIDs (login.tsx keeps its own login-screen-scroll / login-wordmark ids)', () => {
    const { getByTestId, queryByTestId } = renderScreen(
      <AuthScreen
        scrollTestID="login-screen-scroll"
        subtitle="s"
        title="t"
        wordmarkTestID="login-wordmark"
      >
        <AuthField label="Email">
          <AuthInput testID="auth-email-input" />
        </AuthField>
      </AuthScreen>,
    );

    expect(getByTestId('login-screen-scroll')).toBeTruthy();
    expect(getByTestId('login-wordmark')).toBeTruthy();
    expect(queryByTestId('auth-screen-scroll')).toBeNull();
  });
});
