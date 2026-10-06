import {
  getAndroidKeyboardInset,
  getSheetKeyboardAvoidingBehavior,
} from '@/hooks/use-modal-keyboard-inset';

describe('modal keyboard inset', () => {
  it('uses padding on iOS and no avoiding behavior on Android', () => {
    expect(getSheetKeyboardAvoidingBehavior('ios')).toBe('padding');
    // Android's Modal window resizes itself; a second `height` compensation
    // collapsed the sheet behind the keyboard.
    expect(getSheetKeyboardAvoidingBehavior('android')).toBeUndefined();
  });

  it('only pads on Android when the window did not already shrink', () => {
    expect(getAndroidKeyboardInset(2000, 1200, 800)).toBe(0);
    expect(getAndroidKeyboardInset(2000, 2000, 800)).toBe(800);
    expect(getAndroidKeyboardInset(2000, 1500, 800)).toBe(300);
    expect(getAndroidKeyboardInset(0, 1200, 800)).toBe(0);
    expect(getAndroidKeyboardInset(2000, 2000, 0)).toBe(0);
  });
});
