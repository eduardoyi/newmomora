// Onboarding screen shell (docs/plans/onboarding-implementation.md WP0
// §0.1). Every full-screen onboarding step uses this: `SafeAreaView` +
// scrollable body + a CTA stack that sits right after the body content
// (visually pinned to the bottom on screens whose content is shorter than
// the viewport, exactly like the handoff's `OnbShell`
// (src/screens/onboarding-story.jsx) fixed-height flex column).
//
// Keyboard-avoidance is built in here rather than left to each of the ~20
// onboarding screens to reinvent -- consistent with `auth-screen.tsx` and
// `keyboard-aware-form-screen.tsx`'s `KeyboardAwareScrollView` pattern.
// `bottomOffset` uses the same treatment as `auth-screen.tsx`'s
// `KEYBOARD_BOTTOM_OFFSET`: the CTA stack sits directly under the screen's
// content (no field-to-button gap in the design), so a focused input needs
// to clear roughly a button height plus breathing room, or Android hides
// the primary action (commit af2c067 fixed exactly this class of bug).
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
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
      <KeyboardAwareScrollView
        bottomOffset={FOOTER_KEYBOARD_CLEARANCE}
        contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
        disableScrollOnKeyboardHide
        keyboardShouldPersistTaps="handled"
        mode="insets"
        testID="onb-shell-scroll"
      >
        <View style={styles.body}>{children}</View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAwareScrollView>
    </SafeAreaView>
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
    paddingBottom: 40,
    gap: 10,
  },
});
