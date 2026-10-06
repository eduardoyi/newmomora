import { useCallback, useEffect, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Shared keyboard handling for the app's in-house `Modal` bottom sheets
// (comments drawer, family roster, report sheet).
//
// iOS: callers use `KeyboardAvoidingView behavior="padding"`.
// Android: callers use NO `KeyboardAvoidingView` behavior. React Native's
// Modal dialog window sets SOFT_INPUT_ADJUST_RESIZE itself, so the window --
// and the sheet's root view with it -- already shrinks for the keyboard.
// Layering `behavior="height"` on top compensated twice and collapsed the
// sheet behind the keyboard (device-observed 2026-10-06). This hook covers
// the residual case of a window that does NOT resize by measuring it.

// Bottom padding an Android sheet root still needs once the keyboard is up:
// the keyboard's overlap with the window minus however much the window
// already shrank (`baselineHeight` is the tallest root height seen).
// Self-correcting -- 0 when the window resized, the full overlap when it
// didn't.
//
// RN's `keyboardDidShow` height is `ime.bottom - systemBars.bottom`
// (ReactRootView.java), i.e. it EXCLUDES the navigation bar. A Modal window
// that runs edge-to-edge (root as tall as the window) extends under that bar,
// so the real overlap is `keyboardHeight + navBarInset`
// (device-observed 2026-10-06: composer left hidden by one nav-bar height).
export function getAndroidKeyboardInset(
  baselineHeight: number,
  currentHeight: number,
  keyboardHeight: number,
  bottomInset = 0,
  windowHeight = 0,
) {
  if (baselineHeight <= 0 || currentHeight <= 0 || keyboardHeight <= 0) return 0;
  const coversWindow = windowHeight > 0 && baselineHeight >= windowHeight - 1;
  const overlap = keyboardHeight + (coversWindow ? bottomInset : 0);
  return Math.max(0, overlap - Math.max(0, baselineHeight - currentHeight));
}

export function getSheetKeyboardAvoidingBehavior(platform: string) {
  return platform === 'ios' ? ('padding' as const) : undefined;
}

export function useModalKeyboardInset(enabled: boolean) {
  const { bottom: bottomInset } = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [rootHeight, setRootHeight] = useState(0);
  // Tallest root height laid out so far. Not "height while the keyboard flag
  // is off": the window can shrink before `keyboardDidShow` fires.
  const [baselineHeight, setBaselineHeight] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const showSubscription = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event?.endCoordinates?.height ?? 0);
      setIsKeyboardVisible(true);
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      setIsKeyboardVisible(false);
      setKeyboardHeight(0);
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [enabled]);

  const onRootLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setBaselineHeight((current) => Math.max(current, height));
    setRootHeight(height);
  }, []);

  const resetKeyboard = useCallback(() => {
    setIsKeyboardVisible(false);
    setKeyboardHeight(0);
  }, []);

  const androidKeyboardInset =
    Platform.OS === 'android' && isKeyboardVisible
      ? getAndroidKeyboardInset(
          baselineHeight,
          rootHeight,
          keyboardHeight,
          bottomInset,
          windowHeight,
        )
      : 0;

  return { isKeyboardVisible, androidKeyboardInset, onRootLayout, resetKeyboard };
}
