// "Let's try that again" retry confirmation sheet for the Memory Books
// shelf redesign (owner-approved picker-redesign brief, 2026-09-17). House
// Modal + pan-to-dismiss pattern (same as `create-book-sheet.tsx`), but
// non-scrolling -- its content is a fixed, short confirmation, never a list.
import { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { SymbolView } from 'expo-symbols';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { MemoryBookScopeOption } from '@/utils/memory-book-scope';
import { getBottomSheetBottomPadding, shouldDismissBottomSheet } from '@/utils/bottom-sheet-dismiss';

export interface RetryBookSheetProps {
  visible: boolean;
  /** The scope being retried -- null only while the sheet is closed/closing. */
  option: MemoryBookScopeOption | null;
  childFirstName: string;
  isPending: boolean;
  /** Runs `generate(option)`, dismisses, and shows the toast -- all owned
   * by the caller. */
  onConfirm: () => void;
  onCancel: () => void;
}

export function RetryBookSheet({ visible, option, childFirstName, isPending, onConfirm, onCancel }: RetryBookSheetProps) {
  const insets = useSafeAreaInsets();
  const drawerTranslateY = useSharedValue(0);

  useEffect(() => {
    if (visible) drawerTranslateY.set(0);
  }, [drawerTranslateY, visible]);

  const drawerDrag = Gesture.Pan()
    .withTestId('retry-book-sheet-dismiss-pan')
    .activeOffsetY(8)
    .failOffsetX([-30, 30])
    .failOffsetY([-4, Number.MAX_SAFE_INTEGER])
    .maxPointers(1)
    .onUpdate((event) => {
      drawerTranslateY.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      if (shouldDismissBottomSheet(event.translationY, event.velocityY)) {
        runOnJS(onCancel)();
        return;
      }
      drawerTranslateY.set(withSpring(0));
    })
    .onFinalize((_event, success) => {
      if (!success) {
        drawerTranslateY.set(withSpring(0));
      }
    });

  const animatedSheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drawerTranslateY.get() }],
  }));

  return (
    <Modal animationType="slide" onRequestClose={onCancel} presentationStyle="overFullScreen" transparent visible={visible}>
      <GestureHandlerRootView style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onCancel}
          style={styles.backdrop}
          testID="retry-book-sheet-backdrop"
        />
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, animatedSheetStyle, { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) }]}
          testID="retry-book-sheet"
        >
          <GestureDetector gesture={drawerDrag}>
            <View collapsable={false} style={styles.dragRegion}>
              <View style={styles.handle} />
            </View>
          </GestureDetector>

          {option ? (
            <View style={styles.content}>
              <View style={styles.iconCircle}>
                <SymbolView
                  fallback={<Text style={styles.iconFallback}>!</Text>}
                  name={{ ios: 'exclamationmark.triangle', android: 'warning' }}
                  size={22}
                  tintColor={colors.sunInk}
                />
              </View>
              <Text style={styles.title}>Let’s try that again</Text>
              <Text style={styles.body}>
                The <Text style={styles.bodyBold}>{option.label}</Text> book stopped partway through. Nothing was
                lost. Every memory is still safe in {childFirstName}’s timeline.
              </Text>

              <Pressable
                accessibilityRole="button"
                disabled={isPending}
                onPress={onConfirm}
                style={({ pressed }) => [styles.confirmButton, (pressed || isPending) && styles.buttonPressed]}
                testID="retry-book-confirm"
              >
                <Text style={styles.confirmButtonText}>Make this book again</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancelButton} testID="retry-book-cancel">
                <Text style={styles.cancelButtonText}>Not now</Text>
              </Pressable>
            </View>
          ) : null}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(44,36,24,0.34)' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: radius.pill,
    height: 5,
    marginTop: 10,
    marginBottom: 6,
    width: 40,
  },
  dragRegion: { minHeight: 24 },
  content: { alignItems: 'center', gap: 10, paddingBottom: 20, paddingHorizontal: spacing.xl },
  iconCircle: {
    alignItems: 'center',
    backgroundColor: colors.sunSoft,
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    marginBottom: 4,
    width: 56,
  },
  iconFallback: { color: colors.sunInk, fontSize: 20, fontWeight: '700' },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 20 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  bodyBold: { fontFamily: fonts.sansBold, color: colors.ink },
  confirmButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 50,
  },
  buttonPressed: { opacity: 0.85 },
  confirmButtonText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 },
  cancelButton: { alignItems: 'center', justifyContent: 'center', minHeight: 40, paddingVertical: 6 },
  cancelButtonText: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 14 },
});
