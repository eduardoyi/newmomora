import { scrollInputAboveKeyboard } from '@/components/keyboard-aware-form-screen';
import { spacing } from '@/constants/theme';

describe('scrollInputAboveKeyboard', () => {
  const input = {} as never;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lets Android finish resizing before using the native focused-input scroll', () => {
    jest.useFakeTimers();
    const scrollResponderScrollNativeHandleToKeyboard = jest.fn();

    scrollInputAboveKeyboard(
      { scrollResponderScrollNativeHandleToKeyboard },
      input,
      'android',
    );

    expect(scrollResponderScrollNativeHandleToKeyboard).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(scrollResponderScrollNativeHandleToKeyboard).toHaveBeenCalledWith(
      input,
      spacing.xl,
      true,
    );
  });

  it('scrolls immediately on iOS', () => {
    const scrollResponderScrollNativeHandleToKeyboard = jest.fn();

    scrollInputAboveKeyboard(
      { scrollResponderScrollNativeHandleToKeyboard },
      input,
      'ios',
    );

    expect(scrollResponderScrollNativeHandleToKeyboard).toHaveBeenCalledWith(
      input,
      spacing.xl,
      true,
    );
  });
});
