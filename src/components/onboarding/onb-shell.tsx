// Onboarding screen shell (docs/plans/onboarding-implementation.md WP0
// §0.1). Every full-screen onboarding step uses this: `SafeAreaView` +
// scrollable body + a CTA stack pinned below it (exactly like the handoff's
// `OnbShell` (src/screens/onboarding-story.jsx) fixed-height flex column).
//
// Nav-bar/home-indicator clearance and keyboard-avoidance are built in here
// rather than left to each of the ~20 onboarding screens to reinvent --
// consistent with `auth-screen.tsx` and `keyboard-aware-form-screen.tsx`'s
// `KeyboardAwareScrollView` pattern.
//
// --- Device-testing history (2026-07-31) ---
// Six previous fixes here (640b398, 417993d, 186dc32, e1954f9, 60d46f9, plus
// a since-removed JS `isKeyboardVisible` compact-padding branch this file
// used to have) all shipped green tests and still landed the CTA under the
// Android nav bar on device. A frame-by-frame extraction of a screen
// recording found three independent causes, none of which any unit test
// here can see -- the failing layers are all flat-mocked in jest:
//
//   A. `KeyboardAvoidingView behavior="height"` seeds a layout capture-lock
//      (`isClosed = false`) at mount. On a screen pushed while the keyboard
//      is still open, its *first* layout lands before the native
//      SafeAreaView applies its top padding (full window height at y=0);
//      the corrective relayout that follows is then rejected by that lock.
//      When the keyboard finishes hiding, Reanimated doesn't unset style
//      keys that disappear from an animated style, so the wrong
//      `height`/`flex: 0` stay applied for good. This shell no longer uses
//      `KeyboardAvoidingView` at all -- see `KeyboardStickyView` below.
//   B. `useSafeAreaInsets().bottom` reads 0 while the IME is open (Android's
//      `SafeAreaUtils.kt` clamps the nav-bar inset to 0 once the IME resize
//      swamps it), so a JS-computed footer padding built from that value is
//      unreliable exactly when it matters most.
//   C. The old 40dp minimum footer padding was smaller than a real
//      3-button Android nav bar (~48dp) -- even a correct read of B could
//      still land the CTA under the bar.
//
// The fix: stop computing nav-bar clearance in JS for this shell.
// `SafeAreaView edges={['bottom']}` around the footer applies that inset
// *natively* -- the one measurement the recording proved survives IME
// transitions -- and `KeyboardStickyView` (not `KeyboardAvoidingView`)
// translates the footer using the keyboard controller's continuously-
// running animated value, so a screen that mounts mid keyboard-animation
// still reads the right position instead of a stale layout capture. No
// keyboard-visibility state lives in this component anymore.
//
// The scroll view only adds keyboard space when its measured content is
// actually taller than its viewport; short centered steps must never
// expose that implementation space as an empty page.
//
// --- Update, later the same day (2026-07-31) ---
// The fix above traded one bug for another: with the keyboard open, the
// (correctly) translated footer now sits *on top of* the scroll content
// instead of shrinking it, and on S6/S7 -- short, centered steps whose
// content doesn't overflow the viewport with the keyboard closed -- that
// left the focused input with nothing pushing it clear.
//
//   D. `KeyboardAwareScrollView`'s own keyboard-avoidance (the code that
//      scrolls a focused input above the keyboard) is gated by its
//      `enabled` prop; when disabled it never adds scroll headroom and
//      never calls `scrollTo`, keyboard or no keyboard
//      (`maybeScroll` -- and the `padding` it reads for content-inset --
//      both short-circuit on `!enabled` in
//      `KeyboardAwareScrollView/index.tsx`). Before this file dropped
//      `KeyboardAvoidingView`, that view's `behavior="height"` frame
//      physically shrank on keyboard-open, so this scroll view's own
//      `onLayout`-measured viewport height shrank with it -- which is what
//      made `isContentOverflowing` flip true right when it mattered, even
//      on a short screen. With `KeyboardAvoidingView` gone, nothing resizes
//      that viewport anymore, so a screen whose content fits when the
//      keyboard is closed reads not-overflowing forever, and the gate never
//      opens. Fixed by not gating on overflow at all: with the keyboard
//      closed, `enabled` makes no observable difference (the library's own
//      `padding` derivation is `enabled ? currentKeyboardFrameHeight.value
//      : 0`, and that shared value is `0` until a real keyboard event
//      raises it) -- the gate was only ever load-bearing for the
//      keyboard-*open* case, which is exactly the case this shell now needs
//      it for.
//   E. Even with (D) fixed, `bottomOffset` (`FOOTER_KEYBOARD_CLEARANCE`) is
//      only ever the caret-to-footer breathing room from the pre-32d55ea
//      layout, where the footer sat in normal flow *below* the scroll
//      viewport -- so the viewport's bottom edge already excluded the
//      footer, and `bottomOffset` only had to cover the small visual gap
//      above it. `KeyboardAwareScrollView` computes its own visible region
//      as `window height - keyboard height`; it has no idea a translated
//      footer now overlays the bottom of that region too, so a
//      `bottomOffset` sized for the old layout clears the *keyboard* but
//      not the *footer* sitting above it -- which is why "Continue" could
//      still overlap a helper text or an affordance just below the input
//      even once the input itself started scrolling clear. Fixed by
//      measuring the rendered footer (the same block `KeyboardStickyView`
//      translates) and folding that height into `bottomOffset`, so the
//      scroll math accounts for keyboard + footer together instead of
//      keyboard alone.
//
// No keyboard-visibility JS state was added to make either fix -- (D) uses
// the library's existing `enabled` semantics as-is, just no longer gated by
// a signal that can't reflect keyboard state anymore, and (E) reads a
// plain `onLayout` measurement of the footer's own rendered box, not
// anything derived from `useKeyboardState`'s cross-screen singleton (see
// cause A above for why that pattern is banned in this file).
//
// --- Extraction, 2026-08-01 ---
// The mechanism above (native bottom-inset SafeAreaView, KeyboardStickyView
// footer, always-on KeyboardAwareScrollView, measured-footer-height folded
// into bottomOffset) moved to `src/components/keyboard-sticky-shell.tsx`
// (`KeyboardStickyShell`) so `AuthScreen` (`src/components/auth-screen.tsx`)
// and the login screen could reuse it for the same keyboard-covers-the-CTA
// bug instead of re-deriving it a third time. `OnbShell` below is now a
// thin styling wrapper around that shared component -- its own prop
// contract and rendered behavior (testIDs, footer padding, bottomOffset
// math) are unchanged; every test in `onb-shell.test.tsx` still exercises
// this file's public surface directly.
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  FOOTER_KEYBOARD_CLEARANCE,
  KeyboardStickyShell,
  MIN_FOOTER_BOTTOM_PADDING,
} from '@/components/keyboard-sticky-shell';
import { colors, spacing } from '@/constants/theme';

export { FOOTER_KEYBOARD_CLEARANCE };

// `OnbShell` itself no longer calls this -- it used to gate
// `KeyboardAwareScrollView`'s `enabled` prop, which (cause D above) also
// disabled the keyboard-open scrolling short screens need once the footer
// moved on top of them instead of below them. Kept exported and tested as a
// small, still-correct pure predicate in case a future caller needs the
// same "does this content overflow this viewport" check for something that
// isn't keyboard-avoidance.
export function isOnboardingContentOverflowing(contentHeight: number, viewportHeight: number) {
  return contentHeight > viewportHeight + 1;
}

/**
 * Bottom padding for a footer that owns 100% of its own nav-bar/home-
 * indicator clearance in JS (i.e. nothing else around it applies a native
 * bottom safe-area inset). That's `app/(onboarding)/year.tsx`'s situation:
 * it deliberately doesn't use `OnbShell` (see that file's header comment)
 * and calls this directly with its own `bottomInset`.
 *
 * `OnbShell` itself no longer calls this or tracks keyboard visibility --
 * its footer's nav-bar clearance is now a *native* `SafeAreaView
 * edges={['bottom']}` inset (see file header, causes A-C), and its own
 * bottom-padding math lives in `getStickyFooterBottomPadding` in
 * `keyboard-sticky-shell.tsx`, which assumes that native inset is already
 * applied outside of it.
 *
 * `isKeyboardVisible` is kept as a parameter, always ignored, solely so
 * `year.tsx`'s existing `getFooterBottomPadding(bottomInset, false)` call
 * site keeps compiling and behaving exactly as before -- year.tsx is out of
 * scope for this change (another agent owns it concurrently), and changing
 * this signature would require editing it.
 */
export function getFooterBottomPadding(bottomInset: number, _isKeyboardVisible: boolean) {
  // Keep the visual gap that the design expects while guaranteeing that an
  // edge-to-edge Android navigation bar can never cover the CTA.
  return Math.max(MIN_FOOTER_BOTTOM_PADDING, bottomInset + spacing.sm);
}

interface OnbShellProps {
  /** Illustration + headline/body content. Give it `flex: 1` internally to fill the screen. */
  children: ReactNode;
  /** Pinned CTA stack (`padding: 0 24 40`, `gap: 10`), rendered after `children`. */
  footer?: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  keyboardBottomOffset?: number;
  testID?: string;
}

export function OnbShell({
  children,
  footer,
  contentContainerStyle,
  keyboardBottomOffset = FOOTER_KEYBOARD_CLEARANCE,
  testID,
}: OnbShellProps) {
  return (
    <KeyboardStickyShell
      contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
      footer={footer}
      footerStyle={styles.footer}
      footerTestID="onb-shell-footer"
      keyboardBottomOffset={keyboardBottomOffset}
      safeAreaStyle={styles.safeArea}
      scrollTestID="onb-shell-scroll"
      stickyFooterTestID="onb-shell-sticky-footer"
      testID={testID}
    >
      <View style={styles.body}>{children}</View>
    </KeyboardStickyShell>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    flexGrow: 1,
  },
  body: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    gap: 10,
  },
});
