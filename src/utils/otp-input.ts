interface FocusableInput {
  blur: () => void;
  focus: () => void;
}

/**
 * iOS can hide the keyboard while leaving the OTP TextInput focused. React
 * Native then treats a focus request on that same input as a no-op. Clear the
 * stale focus and give UIKit a run-loop turn before asking it to focus again.
 */
export function focusOtpInput(
  input: FocusableInput | null,
  isKeyboardVisible: boolean,
  scheduleFocus: (callback: () => void) => number = (callback) =>
    requestAnimationFrame(callback),
): void {
  if (!input) {
    return;
  }

  if (isKeyboardVisible) {
    input.focus();
    return;
  }

  input.blur();
  scheduleFocus(() => input.focus());
}
