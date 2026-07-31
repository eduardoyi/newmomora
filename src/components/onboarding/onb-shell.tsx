// Onboarding screen shell (docs/plans/onboarding-implementation.md WP0
// §0.1). Every full-screen onboarding step uses this: `SafeAreaView` +
// scrollable body + a CTA stack pinned below it (exactly like the handoff's
// `OnbShell` (src/screens/onboarding-story.jsx) fixed-height flex column).
//
// Keyboard-avoidance is built in here rather than left to each of the ~20
// onboarding screens to reinvent -- consistent with `auth-screen.tsx` and
// `keyboard-aware-form-screen.tsx`'s `KeyboardAwareScrollView` pattern.
// The footer stays outside the scroll content, inside one keyboard-resized
// frame. The scroll view only adds keyboard space when its measured content is
// actually taller than its viewport; short centered steps must never expose
// that implementation space as an empty page.
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
  useKeyboardState,
} from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';

// This value is only the remaining footer/caret clearance. Treating it as a
// second full keyboard height makes KeyboardAwareScrollView needlessly throw
// centered content/headlines off the top of short screens.
export const FOOTER_KEYBOARD_CLEARANCE = spacing.xxl + spacing.lg;
export const KEYBOARD_VERTICAL_OFFSET = Platform.select({
  ios: spacing.xl,
  default: spacing.sm,
}) ?? spacing.sm;

const MIN_FOOTER_BOTTOM_PADDING = spacing.xl + spacing.sm;

export function isOnboardingContentOverflowing(contentHeight: number, viewportHeight: number) {
  return contentHeight > viewportHeight + 1;
}

export function getFooterBottomPadding(bottomInset: number, isKeyboardVisible: boolean) {
  if (isKeyboardVisible) {
    // The open keyboard already includes the system navigation region.
    return spacing.sm;
  }

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
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const { bottom: bottomInset } = useSafeAreaInsets();
  const footerBottomPadding = getFooterBottomPadding(bottomInset, isKeyboardVisible);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const [isContentOverflowing, setIsContentOverflowing] = useState(false);

  const updateContentOverflow = () => {
    const nextValue = isOnboardingContentOverflowing(contentHeight.current, viewportHeight.current);
    setIsContentOverflowing((currentValue) => (currentValue === nextValue ? currentValue : nextValue));
  };

  const footerView = footer ? (
    <View
      style={[styles.footer, { paddingBottom: footerBottomPadding }]}
      testID="onb-shell-footer"
    >
      {footer}
    </View>
  ) : null;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea} testID={testID}>
      <KeyboardAvoidingView
        automaticOffset
        behavior="height"
        enabled
        keyboardVerticalOffset={KEYBOARD_VERTICAL_OFFSET}
        style={styles.frame}
        testID="onb-shell-keyboard-frame"
      >
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
    gap: 10,
  },
});
