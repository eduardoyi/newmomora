// Onboarding screen shell (docs/plans/onboarding-implementation.md WP0
// §0.1). Every full-screen onboarding step uses this: `SafeAreaView` +
// scrollable body + a CTA stack pinned below it (exactly like the handoff's
// `OnbShell` (src/screens/onboarding-story.jsx) fixed-height flex column).
//
// Keyboard-avoidance is built in here rather than left to each of the ~20
// onboarding screens to reinvent -- consistent with `auth-screen.tsx` and
// `keyboard-aware-form-screen.tsx`'s `KeyboardAwareScrollView` pattern.
// The footer is a `KeyboardStickyView`, not part of the scroll content. This
// matters for the kid-name and first-capture fields: scrolling the focused
// input into view alone cannot guarantee that the CTA below it remains
// tappable. The sticky footer follows the IME on both platforms, while the
// scroll view keeps the focused input above that footer.
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardAwareScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';

const FOOTER_KEYBOARD_CLEARANCE = spacing.xxl * 2;

interface OnbShellProps {
  /** Illustration + headline/body content. Give it `flex: 1` internally to fill the screen. */
  children: ReactNode;
  /** Pinned CTA stack (`padding: 0 24 40`, `gap: 10`), rendered after `children`. */
  footer?: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export function OnbShell({ children, footer, contentContainerStyle, testID }: OnbShellProps) {
  return (
    <SafeAreaView style={styles.safeArea} testID={testID}>
      <View style={styles.frame}>
        <KeyboardAwareScrollView
          bottomOffset={footer ? FOOTER_KEYBOARD_CLEARANCE : spacing.lg}
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
          <KeyboardStickyView testID="onb-shell-footer">
            <View style={styles.footer}>{footer}</View>
          </KeyboardStickyView>
        ) : null}
      </View>
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
    paddingBottom: 40,
    gap: 10,
  },
});
