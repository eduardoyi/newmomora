import { focusOtpInput } from '@/utils/otp-input';

describe('focusOtpInput', () => {
  it('clears stale focus before refocusing on the next frame', () => {
    const blur = jest.fn();
    const focus = jest.fn();
    let runScheduledFocus: (() => void) | undefined;

    focusOtpInput(
      { blur, focus },
      false,
      (callback) => {
        runScheduledFocus = callback;
        return 0;
      },
    );

    expect(blur).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();

    runScheduledFocus?.();

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('focuses without blurring when the keyboard is visible', () => {
    const blur = jest.fn();
    const focus = jest.fn();
    const scheduleFocus = jest.fn();

    focusOtpInput({ blur, focus }, true, scheduleFocus);

    expect(blur).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(scheduleFocus).not.toHaveBeenCalled();
  });
});
