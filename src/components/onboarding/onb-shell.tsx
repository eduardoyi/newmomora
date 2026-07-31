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
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  KeyboardAwareScrollView,
  KeyboardStickyView,
} from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';

// This value is only the remaining footer/caret clearance. Treating it as a
// second full keyboard height makes KeyboardAwareScrollView needlessly throw
// centered content/headlines off the top of short screens.
export const FOOTER_KEYBOARD_CLEARANCE = spacing.xxl + spacing.lg;

// The design's default footer bottom gap on a device with no meaningful
// native bottom inset (e.g. Android 3-button nav, older hardware). Used two
// different ways below -- see `getFooterBottomPadding` (year.tsx's screen,
// which owns its own clearance) and `getStickyFooterBottomPadding` (this
// shell's footer, which tops a *native* inset up to this floor instead of
// stacking JS padding on top of it).
const MIN_FOOTER_BOTTOM_PADDING = spacing.xl + spacing.sm;

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
 * bottom-padding math lives in `getStickyFooterBottomPadding` below, which
 * assumes that native inset is already applied outside of it.
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

// Unlike `getFooterBottomPadding` above, this shell's own footer sits
// inside a native `SafeAreaView edges={['bottom']}` that already supplies
// real nav-bar/home-indicator clearance (see file header). Adding
// `bottomInset + spacing.sm` on top of that here would double-count the
// inset. Instead this only tops the design's usual footer gap up to
// `MIN_FOOTER_BOTTOM_PADDING` on devices whose native inset is smaller than
// that gap (e.g. 0 on an inset-less Android phone); on devices with a
// generous inset (e.g. a ~48dp Android nav bar) it shrinks to the bare
// `spacing.sm` visual gap. Worst case this gap is merely tight -- it can
// never land the CTA under the nav bar, since the native inset is applied
// regardless of this value.
function getStickyFooterBottomPadding(bottomInset: number) {
  return Math.max(MIN_FOOTER_BOTTOM_PADDING - bottomInset, spacing.sm);
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
  const { bottom: bottomInset } = useSafeAreaInsets();
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const [isContentOverflowing, setIsContentOverflowing] = useState(false);

  const updateContentOverflow = () => {
    const nextValue = isOnboardingContentOverflowing(contentHeight.current, viewportHeight.current);
    setIsContentOverflowing((currentValue) => (currentValue === nextValue ? currentValue : nextValue));
  };

  const footerView = footer ? (
    <KeyboardStickyView
      offset={{ closed: 0, opened: bottomInset }}
      testID="onb-shell-sticky-footer"
    >
      <SafeAreaView edges={['bottom']}>
        <View
          style={[styles.footer, { paddingBottom: getStickyFooterBottomPadding(bottomInset) }]}
          testID="onb-shell-footer"
        >
          {footer}
        </View>
      </SafeAreaView>
    </KeyboardStickyView>
  ) : null;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea} testID={testID}>
      <KeyboardAwareScrollView
        bottomOffset={footer ? keyboardBottomOffset : spacing.lg}
        contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
        disableScrollOnKeyboardHide={false}
        enabled={isContentOverflowing}
        bounces={false}
        keyboardShouldPersistTaps="handled"
        mode="insets"
        onContentSizeChange={(_, height) => {
          contentHeight.current = height;
          updateContentOverflow();
        }}
        onLayout={(event) => {
          viewportHeight.current = event.nativeEvent.layout.height;
          updateContentOverflow();
        }}
        overScrollMode="never"
        style={styles.scrollView}
        testID="onb-shell-scroll"
      >
        <View style={styles.body}>{children}</View>
      </KeyboardAwareScrollView>

      {footerView}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollView: {
    flex: 1,
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
