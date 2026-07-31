// Onboarding screen shell (docs/plans/onboarding-implementation.md WP0
// §0.1). Every full-screen onboarding step uses this: `SafeAreaView` +
// scrollable body + a CTA stack pinned below it (exactly like the handoff's
// `OnbShell` (src/screens/onboarding-story.jsx) fixed-height flex column).
//
// Keyboard-avoidance is built in here rather than left to each of the ~20
// onboarding screens to reinvent -- consistent with `auth-screen.tsx` and
// `keyboard-aware-form-screen.tsx`'s `KeyboardAwareScrollView` pattern.
// The footer stays outside the scroll content, inside a keyboard-avoiding
// frame. This matters for the kid-name, family-name, account, and first-
// capture fields: translating a footer over an unchanged scroll viewport
// makes the CTA tappable but lets it intercept taps on inputs and controls
// underneath. Shrinking the frame instead keeps the footer in layout above
// the IME on both platforms, while the scroll view keeps focused fields and
// the controls immediately after them above that footer.
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
  useKeyboardState,
} from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';

// Reserve one large CTA/footer (~96 pt) plus enough room for the controls
// immediately after a focused field (the kids' add/helper controls or the
// account screen's second input). A smaller offset kept the caret visible but
// still put those tappable siblings underneath the footer.
export const FOOTER_KEYBOARD_CLEARANCE = spacing.xxl * 3 + spacing.md;

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
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea} testID={testID}>
      <KeyboardAvoidingView
        automaticOffset
        behavior="height"
        keyboardVerticalOffset={spacing.xl}
        style={styles.frame}
        testID="onb-shell-keyboard-frame"
      >
        <KeyboardAwareScrollView
          bottomOffset={footer ? keyboardBottomOffset : spacing.lg}
          contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
          disableScrollOnKeyboardHide
          keyboardShouldPersistTaps="handled"
          mode="insets"
          style={styles.scrollView}
          testID="onb-shell-scroll"
        >
          <View style={styles.body}>{children}</View>
        </KeyboardAwareScrollView>

        {footer ? (
          <View
            style={[styles.footer, isKeyboardVisible && styles.footerKeyboardOpen]}
            testID="onb-shell-footer"
          >
            {footer}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  frame: {
    flex: 1,
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
    paddingBottom: spacing.xl + spacing.sm,
    gap: 10,
  },
  footerKeyboardOpen: {
    paddingBottom: spacing.sm,
  },
});
