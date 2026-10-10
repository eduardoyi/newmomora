import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { getBottomSheetBottomPadding, shouldDismissBottomSheet } from '@/utils/bottom-sheet-dismiss';

export interface BringInSoundSheetProps {
  visible: boolean;
  /** The composer closes the sheet, waits for `onDismissed`, then opens the
   * document picker (iOS won't present a Modal while another is dismissing). */
  onChooseFile: () => void;
  onClose: () => void;
  /** Fires after the Modal has fully dismissed: iOS `Modal.onDismiss`;
   * Android (where `onDismiss` doesn't exist) right after `visible` flips
   * to false. */
  onDismissed?: () => void;
  testID?: string;
}

const GUIDE_STEPS = [
  {
    key: 'whatsapp',
    icon: { ios: 'bubble.left.fill', android: 'chat' },
    fallback: '💬',
    title: 'From WhatsApp',
    body: 'Press and hold the voice note → Forward → tap the share button (bottom right) → Momora',
  },
  {
    key: 'voice-memos',
    icon: { ios: 'waveform', android: 'mic' },
    fallback: '🎙',
    title: 'From Voice Memos',
    body: 'Tap ⋯ on the recording → Share → Momora',
  },
] as const;

export function BringInSoundSheet({
  visible,
  onChooseFile,
  onClose,
  onDismissed,
  testID = 'bring-in-sound-sheet',
}: BringInSoundSheetProps) {
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(0);
  const wasVisibleRef = useRef(visible);
  const onDismissedRef = useRef(onDismissed);

  useEffect(() => {
    onDismissedRef.current = onDismissed;
  }, [onDismissed]);

  useEffect(() => {
    if (visible) translateY.set(0);
  }, [translateY, visible]);

  // Android has no Modal `onDismiss`: report the dismissal as soon as the
  // sheet is told to close. iOS reports it from `Modal.onDismiss` instead
  // (once the dismiss animation really finished).
  useEffect(() => {
    if (Platform.OS !== 'android') {
      wasVisibleRef.current = visible;
      return;
    }
    if (wasVisibleRef.current && !visible) {
      onDismissedRef.current?.();
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  const handleModalDismiss = () => {
    if (Platform.OS === 'ios') onDismissedRef.current?.();
  };

  const drag = Gesture.Pan()
    .withTestId(`${testID}-dismiss-pan`)
    .activeOffsetY(8)
    .failOffsetX([-30, 30])
    .failOffsetY([-4, Number.MAX_SAFE_INTEGER])
    .maxPointers(1)
    .onUpdate((event) => {
      translateY.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      if (shouldDismissBottomSheet(event.translationY, event.velocityY)) {
        runOnJS(onClose)();
        return;
      }
      translateY.set(withSpring(0));
    })
    .onFinalize((_event, success) => {
      if (!success) translateY.set(withSpring(0));
    });

  const animatedSheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.get() }],
  }));

  return (
    <Modal
      animationType="slide"
      onDismiss={handleModalDismiss}
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      <GestureHandlerRootView style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            animatedSheetStyle,
            { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) + spacing.sm },
          ]}
          testID={testID}
        >
          <GestureDetector gesture={drag}>
            <View collapsable={false} style={styles.dragRegion}>
              <View style={styles.handle} />
              <View style={styles.header}>
                <Text accessibilityRole="header" style={styles.title}>Bring in a sound</Text>
                <Pressable
                  accessibilityLabel="Close"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={onClose}
                  style={styles.closeButton}
                  testID={`${testID}-close`}
                >
                  <Text style={styles.closeButtonText}>×</Text>
                </Pressable>
              </View>
            </View>
          </GestureDetector>

          <View style={styles.body}>
            <Pressable
              accessibilityLabel="Choose from Files"
              accessibilityRole="button"
              onPress={onChooseFile}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
              testID={`${testID}-choose`}
            >
              <SymbolView
                name={{ ios: 'folder', android: 'folder' }}
                size={18}
                tintColor={colors.white}
                fallback={<Text style={styles.primaryButtonIcon}>▤</Text>}
              />
              <Text style={styles.primaryButtonText}>Choose from Files</Text>
            </Pressable>

            <Text style={styles.guideHeading}>Or send it straight from another app</Text>
            <View style={styles.guide}>
              {GUIDE_STEPS.map((step) => (
                <View key={step.key} style={styles.guideRow} testID={`${testID}-guide-${step.key}`}>
                  <View style={styles.guideIcon}>
                    <SymbolView
                      name={step.icon}
                      size={16}
                      tintColor={colors.primary}
                      fallback={<Text style={styles.guideIconFallback}>{step.fallback}</Text>}
                    />
                  </View>
                  <View style={styles.guideText}>
                    <Text style={styles.guideTitle}>{step.title}</Text>
                    <Text style={styles.guideBody}>{step.body}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44,36,24,0.34)',
  },
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
    width: 40,
  },
  dragRegion: { minHeight: 44 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  title: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 20 },
  closeButton: { alignItems: 'center', height: 36, justifyContent: 'center', width: 36 },
  closeButtonText: { color: colors.ink2, fontSize: 22, lineHeight: 22 },
  body: { gap: spacing.md, paddingHorizontal: 20, paddingTop: spacing.xs },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 12,
  },
  primaryButtonPressed: { opacity: 0.85 },
  primaryButtonIcon: { color: colors.white, fontSize: 16 },
  primaryButtonText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 16 },
  guideHeading: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 12,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
  },
  guide: { gap: spacing.md },
  guideRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  guideIcon: {
    alignItems: 'center',
    backgroundColor: colors.primaryTint,
    borderRadius: radius.pill,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  guideIconFallback: { fontSize: 14 },
  guideText: { flex: 1, gap: 2 },
  guideTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14 },
  guideBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
});
