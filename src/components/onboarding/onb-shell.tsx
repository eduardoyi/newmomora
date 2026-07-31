// Onboarding screen shell (docs/plans/onboarding-implementation.md WP0
// §0.1). Every full-screen onboarding step uses this: `SafeAreaView` +
// scrollable body + a CTA stack pinned below it (exactly like the handoff's
// `OnbShell` (src/screens/onboarding-story.jsx) fixed-height flex column).
//
// Keyboard-avoidance is built in here rather than left to each of the ~20
// onboarding screens to reinvent -- consistent with `auth-screen.tsx` and
// `keyboard-aware-form-screen.tsx`'s `KeyboardAwareScrollView` pattern.
// The footer stays outside the scroll content. Android uses a height-resized
// frame so edge-to-edge navigation and the IME both participate in layout;
// iOS uses the controller's sticky footer because its keyboard animation is
// more reliable than a height reflow for this fixed CTA. The scroll view
// still owns focused-input scrolling on both platforms.
import type { ReactNode } from 'react';
import { useRef } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
  KeyboardStickyView,
  useKeyboardState,
} from 'react-native-keyboard-controller';
import type { KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';

// This value is only the remaining footer/caret clearance. Treating it as a
// second full keyboard height makes KeyboardAwareScrollView needlessly throw
// centered content/headlines off the top of short screens.
export const FOOTER_KEYBOARD_CLEARANCE = spacing.xxl + spacing.lg;
export const KEYBOARD_VERTICAL_OFFSET = spacing.sm;

const MIN_FOOTER_BOTTOM_PADDING = spacing.xl + spacing.sm;

export function getMaxOnboardingScrollOffset(contentHeight: number, viewportHeight: number) {
  return Math.max(0, contentHeight - viewportHeight);
}

export function isShortOnboardingForm(contentHeight: number, viewportHeight: number) {
  return contentHeight <= viewportHeight + 1;
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
  const scrollViewRef = useRef<KeyboardAwareScrollViewRef>(null);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!isKeyboardVisible || viewportHeight.current <= 0 || contentHeight.current <= 0) {
      return;
    }

    // KeyboardAwareScrollView deliberately adds keyboard space to the
    // scrollable area so a focused input can be lifted above the IME. The
    // onboarding CTA is a sibling, though, and short centered steps must not
    // expose that implementation space as blank content when the user drags
    // down. Clamp short forms only; long forms retain the keyboard-aware
    // inset they need to bring lower focused fields above the IME.
    const maxContentOffset = getMaxOnboardingScrollOffset(contentHeight.current, viewportHeight.current);
    const offsetY = event.nativeEvent.contentOffset.y;

    if (isShortOnboardingForm(contentHeight.current, viewportHeight.current) && offsetY > maxContentOffset) {
      scrollViewRef.current?.scrollTo({ y: maxContentOffset, animated: false });
    }
  };

  const footerView = footer ? (
    <KeyboardStickyView enabled={Platform.OS === 'ios'} testID="onb-shell-footer-sticky">
      <View
        style={[styles.footer, { paddingBottom: footerBottomPadding }]}
        testID="onb-shell-footer"
      >
        {footer}
      </View>
    </KeyboardStickyView>
  ) : null;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea} testID={testID}>
      <KeyboardAvoidingView
        automaticOffset
        behavior="height"
        enabled={Platform.OS === 'android'}
        keyboardVerticalOffset={KEYBOARD_VERTICAL_OFFSET}
        style={styles.frame}
        testID="onb-shell-keyboard-frame"
      >
        <KeyboardAwareScrollView
          bottomOffset={footer ? keyboardBottomOffset : spacing.lg}
          contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
          disableScrollOnKeyboardHide={false}
          bounces={false}
          keyboardShouldPersistTaps="handled"
          mode="insets"
          onContentSizeChange={(_, height) => {
            contentHeight.current = height;
          }}
          onLayout={(event) => {
            viewportHeight.current = event.nativeEvent.layout.height;
          }}
          onScroll={handleScroll}
          overScrollMode="never"
          ref={scrollViewRef}
          scrollEventThrottle={16}
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
