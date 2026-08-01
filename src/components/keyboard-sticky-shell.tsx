// Shared keyboard-avoidance shell mechanism -- extracted from
// `src/components/onboarding/onb-shell.tsx` (`OnbShell`) so screens outside
// onboarding (the auth group) can reuse the same eight-attempt-hardened
// pattern instead of re-deriving it. Read `onb-shell.tsx`'s file header for
// the full incident history; the short version:
//
//   - `KeyboardAvoidingView behavior="height"` seeds a layout capture-lock
//     at mount that can freeze a stale frame permanently once Reanimated
//     stops updating an animated style whose keys disappear -- this shell
//     never uses it.
//   - `useSafeAreaInsets().bottom` reads 0 mid-IME-transition on Android, so
//     nav-bar/home-indicator clearance for the footer comes from a *native*
//     `SafeAreaView edges={['bottom']}`, not a JS-computed inset.
//   - `KeyboardAwareScrollView`'s `enabled` prop must never be gated on a
//     content-overflow signal -- it short-circuits the library's own
//     keyboard-avoidance entirely, which breaks short screens once the
//     keyboard opens.
//   - The footer lives *outside* the scroll view and is translated above
//     the keyboard by `KeyboardStickyView`; because the scroll view computes
//     its visible region as window-minus-keyboard with no idea a translated
//     footer overlays the bottom of that region, the footer's *rendered*
//     height (via `onLayout`) is folded into `bottomOffset`.
//
// `OnbShell` and `AuthScreen` (`src/components/auth-screen.tsx`) are both
// thin styling wrappers around this component. There must be exactly one
// implementation of this mechanism -- do not fork this file's keyboard
// logic into either of them, or into any other screen shell.
import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  KeyboardAwareScrollView,
  KeyboardStickyView,
} from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing } from '@/constants/theme';

// Only the remaining footer/caret clearance -- the footer's own measured
// height is folded in separately (see `bottomOffset` below), so treating
// this as a second full keyboard height would needlessly throw short
// screens' content off the top when the keyboard opens.
export const FOOTER_KEYBOARD_CLEARANCE = spacing.xxl + spacing.lg;

// The design's default footer bottom gap on a device with no meaningful
// native bottom inset (e.g. Android 3-button nav, older hardware).
export const MIN_FOOTER_BOTTOM_PADDING = spacing.xl + spacing.sm;

// This shell's footer sits inside a native `SafeAreaView edges={['bottom']}`
// that already supplies real nav-bar/home-indicator clearance. Adding
// `bottomInset + spacing.sm` on top of that would double-count the inset --
// instead this only tops the design's usual footer gap up to
// `MIN_FOOTER_BOTTOM_PADDING` on devices whose native inset is smaller than
// that gap; on devices with a generous inset it shrinks to the bare
// `spacing.sm` visual gap. Worst case this gap is merely tight -- it can
// never land the CTA under the nav bar, since the native inset is applied
// regardless of this value.
export function getStickyFooterBottomPadding(bottomInset: number) {
  return Math.max(MIN_FOOTER_BOTTOM_PADDING - bottomInset, spacing.sm);
}

interface KeyboardStickyShellProps {
  /** Scrollable body content. */
  children: ReactNode;
  /** Pinned CTA stack, rendered after `children` but outside the scroll view. */
  footer?: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  keyboardBottomOffset?: number;
  /** Style for the outer `SafeAreaView` (top/left/right) -- background color, flex, etc. */
  safeAreaStyle?: StyleProp<ViewStyle>;
  /** Style for the `KeyboardAwareScrollView` itself (not its content container). */
  scrollStyle?: StyleProp<ViewStyle>;
  /** Style for the footer's inner `View` -- horizontal padding, gap, etc. Bottom padding is computed. */
  footerStyle?: StyleProp<ViewStyle>;
  testID?: string;
  scrollTestID?: string;
  footerTestID?: string;
  stickyFooterTestID?: string;
}

export function KeyboardStickyShell({
  children,
  footer,
  contentContainerStyle,
  keyboardBottomOffset = FOOTER_KEYBOARD_CLEARANCE,
  safeAreaStyle,
  scrollStyle,
  footerStyle,
  testID,
  scrollTestID,
  footerTestID,
  stickyFooterTestID,
}: KeyboardStickyShellProps) {
  const { bottom: bottomInset } = useSafeAreaInsets();

  // How tall the translated footer actually renders, so it can be folded
  // into `bottomOffset` below. Measured on the same box `KeyboardStickyView`
  // translates (native inset padding included), not derived from
  // `bottomInset` -- see file header. Starts at `0` until the first layout
  // pass; `KeyboardAwareScrollView` re-syncs itself whenever `bottomOffset`
  // changes, so the one-frame lag self-corrects rather than sticking.
  const [footerHeight, setFooterHeight] = useState(0);

  const handleFooterLayout = (event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    setFooterHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
  };

  const footerView = footer ? (
    <KeyboardStickyView offset={{ closed: 0, opened: bottomInset }} testID={stickyFooterTestID}>
      <SafeAreaView edges={['bottom']} onLayout={handleFooterLayout}>
        <View
          style={[footerStyle, { paddingBottom: getStickyFooterBottomPadding(bottomInset) }]}
          testID={footerTestID}
        >
          {footer}
        </View>
      </SafeAreaView>
    </KeyboardStickyView>
  ) : null;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={safeAreaStyle} testID={testID}>
      <KeyboardAwareScrollView
        // Always-on: with the keyboard closed this is not a behavior change
        // (the library's own `padding` derivation is `enabled ?
        // currentKeyboardFrameHeight.value : 0`, and that shared value is 0
        // until a real keyboard event raises it) -- gating this on content
        // overflow permanently disabled keyboard-avoidance on short,
        // non-overflowing screens. See file header.
        enabled
        bottomOffset={footer ? keyboardBottomOffset + footerHeight : spacing.lg}
        contentContainerStyle={contentContainerStyle}
        disableScrollOnKeyboardHide={false}
        bounces={false}
        keyboardShouldPersistTaps="handled"
        mode="insets"
        overScrollMode="never"
        style={[styles.scrollView, scrollStyle]}
        testID={scrollTestID}
      >
        {children}
      </KeyboardAwareScrollView>

      {footerView}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
});
