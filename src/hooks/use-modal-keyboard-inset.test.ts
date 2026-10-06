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

  it('adds the nav-bar inset only when the modal root covers the whole window', () => {
    // RN's keyboard height excludes the nav bar; an edge-to-edge dialog
    // extends under it (800 + 48 overlap).
    expect(getAndroidKeyboardInset(2000, 2000, 800, 48, 2000)).toBe(848);
    // dialog sits above the nav bar -> keyboard height alone is right
    expect(getAndroidKeyboardInset(1900, 1900, 800, 48, 2000)).toBe(800);
    // edge-to-edge but window did resize by the full overlap -> nothing
    expect(getAndroidKeyboardInset(2000, 1152, 800, 48, 2000)).toBe(0);
  });
});
