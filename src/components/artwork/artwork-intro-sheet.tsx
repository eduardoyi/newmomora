// First-time intro shown before the artwork scanner opens
// (docs/plans/artwork-scanning-v2.md decision 7): a framed crayon doodle on a
// plaster panel, two scanning tips and a primary "Start scanning" action.
// Modelled on `BringInSoundSheet` (Modal presentation, pull-down dismiss,
// safe-area padding, platform-split `onDismissed`).
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { ArtworkFrame } from '@/components/artwork-frame';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { getBottomSheetBottomPadding, shouldDismissBottomSheet } from '@/utils/bottom-sheet-dismiss';

export interface ArtworkIntroSheetProps {
  visible: boolean;
  /** "Start scanning": the parent closes the sheet, waits for `onDismissed`,
   * then opens the scanner (iOS won't present VisionKit over a Modal that is
   * still dismissing). */
  onStart: () => void;
  /** Any other way out: backdrop, close button, pull-down, hardware back. */
  onClose: () => void;
  /** Fires after the Modal has fully dismissed: iOS `Modal.onDismiss`;
   * Android (where `onDismiss` doesn't exist) right after `visible` flips
   * to false. */
  onDismissed?: () => void;
  testID?: string;
}

export const ARTWORK_INTRO_COPY = {
  eyebrow: 'NEW · ARTWORK',
  title: 'Let’s hang it on the wall',
  body: 'Scan your kid’s drawings and they’ll show up framed on your Timeline.',
  tips: [
    { key: 'flat', title: 'Lay it flat', body: 'Smooth out folds so the edges come out straight.' },
    {
      key: 'dark',
      title: 'Use a darker surface',
      body: 'A wooden table or the floor helps the scanner find the paper.',
    },
  ],
  start: 'Start scanning',
} as const;

const PLASTER = '#EEE3D3';
const DOODLE_ART_WIDTH = 110;
const PANEL_HEIGHT = 196;
const PANEL_FRAME_TOP = 22;
const PANEL_TILT = -3;

// Crayon-ish strokes on white paper: a squiggly sun, a little house, grass.
function CrayonDoodle() {
  return (
    <Svg height={DOODLE_ART_WIDTH} viewBox="0 0 110 110" width={DOODLE_ART_WIDTH}>
      <Rect fill="#FFFFFF" height={110} width={110} />
      {/* sun */}
      <Circle cx={30} cy={30} fill="#F8DB7E" fillOpacity={0.55} r={11} />
      <Path
        d="M30 14.5c3 .8 3.4 4.6 6 3.4M45 30c-.8 3 2.6 4.4 1.2 7M30 46c-3-.8-3.6-3.6-6.2-2.6M14.5 30c.8-3-2.2-4.6-1-7.2M40.6 18.4c2.6-.4 2.2 2.8 4.6 3.4M19.4 41.6c-1.8 1.6-3.6.2-5.4 1.8M40 41.6c2 .6 2.4 2.8 4.6 3M19.6 18.4c-1.6-1.6-.4-3.4-2.2-4.6"
        fill="none"
        stroke="#E8A317"
        strokeLinecap="round"
        strokeWidth={2.6}
      />
      <Path
        d="M19.5 30c.4-6.4 4.6-10.6 10.6-10.4 6.2.2 10.4 4.8 10.2 10.6-.2 6-4.8 10.2-10.8 10-5.8-.2-10-4.2-10-10.2z"
        fill="none"
        stroke="#E8A317"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.6}
      />
      {/* house */}
      <Path
        d="M55 92V68.5h30V92"
        fill="#F4A6B6"
        fillOpacity={0.55}
        stroke="#D63E78"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.8}
      />
      <Path
        d="M51 71.5L70.4 53.5 89 71.5"
        fill="none"
        stroke="#4A8FD6"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={3}
      />
      <Rect fill="none" height={13} rx={1} stroke="#4A8FD6" strokeWidth={2.4} width={9} x={65} y={79} />
      <Path d="M76 76.5h5.5v5H76z" fill="none" stroke="#4A8FD6" strokeLinejoin="round" strokeWidth={2} />
      {/* grass scribble */}
      <Path
        d="M10 94.5c4-3.6 6.4 1.6 10 .2s5.6-4.4 9.6-.8 6.2 1.8 10-.4 6.4 1.4 9 .8M92 95c3.2-2.6 5.4.6 8 .2 2-.4 3-1.8 4.6-.8"
        fill="none"
        stroke="#4FA77A"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.6}
      />
    </Svg>
  );
}

function LayFlatIcon() {
  return (
    <Svg fill="none" height={20} stroke={colors.primary} strokeLinejoin="round" strokeWidth={1.9} viewBox="0 0 24 24" width={20}>
      <Path d="M4 7l8-4 8 4-8 4-8-4z" />
      <Path d="M4 12l8 4 8-4" />
    </Svg>
  );
}

function DarkSurfaceIcon() {
  return (
    <Svg fill="none" height={20} stroke={colors.white} strokeLinejoin="round" strokeWidth={1.9} viewBox="0 0 24 24" width={20}>
      <Rect height={14} rx={1.5} width={12} x={6} y={5} />
    </Svg>
  );
}

export function ArtworkIntroSheet({
  visible,
  onStart,
  onClose,
  onDismissed,
  testID = 'artwork-intro-sheet',
}: ArtworkIntroSheetProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
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
            {
              maxHeight: Math.max(320, windowHeight - insets.top - spacing.md),
              paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) + spacing.sm,
            },
          ]}
          testID={testID}
        >
          <GestureDetector gesture={drag}>
            <View collapsable={false} style={styles.dragRegion}>
              <View style={styles.handle} />
            </View>
          </GestureDetector>

          <ScrollView
            bounces={false}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
          >
            <View style={styles.panel} testID={`${testID}-illustration`}>
              <LinearGradient
                colors={['rgba(255,249,236,0)', 'rgba(255,249,236,0.6)', 'rgba(255,249,236,0)']}
                end={{ x: 1, y: 1 }}
                locations={[0.2, 0.4, 0.6]}
                pointerEvents="none"
                start={{ x: 0, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
              <View style={styles.panelFrame}>
                <ArtworkFrame
                  artWidth={DOODLE_ART_WIDTH}
                  aspectRatio={1}
                  color={colors.frameButter}
                  kind="bobble"
                  testID={`${testID}-frame`}
                  tilt={PANEL_TILT}
                >
                  <CrayonDoodle />
                </ArtworkFrame>
              </View>
            </View>

            <View style={styles.copy}>
              <Text style={styles.eyebrow}>{ARTWORK_INTRO_COPY.eyebrow}</Text>
              <Text accessibilityRole="header" style={styles.title}>
                {ARTWORK_INTRO_COPY.title}
              </Text>
              <Text style={styles.body}>{ARTWORK_INTRO_COPY.body}</Text>
            </View>

            <View style={styles.tips}>
              {ARTWORK_INTRO_COPY.tips.map((tip) => (
                <View key={tip.key} style={styles.tipRow} testID={`${testID}-tip-${tip.key}`}>
                  <View style={[styles.tipTile, tip.key === 'dark' ? styles.tipTileDark : styles.tipTileLight]}>
                    {tip.key === 'dark' ? <DarkSurfaceIcon /> : <LayFlatIcon />}
                  </View>
                  <View style={styles.tipText}>
                    <Text style={styles.tipTitle}>{tip.title}</Text>
                    <Text style={styles.tipBody}>{tip.body}</Text>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              accessibilityLabel={ARTWORK_INTRO_COPY.start}
              accessibilityRole="button"
              onPress={onStart}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
              testID={`${testID}-start`}
            >
              <Text style={styles.primaryButtonText}>{ARTWORK_INTRO_COPY.start}</Text>
            </Pressable>
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
    backgroundColor: 'rgba(44,36,24,0.38)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
  },
  dragRegion: { minHeight: 28, paddingBottom: 8 },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: radius.pill,
    height: 5,
    marginTop: 12,
    width: 40,
  },
  scroll: { flexShrink: 1 },
  scrollContent: { gap: 18, paddingHorizontal: 24, paddingTop: 4 },
  panel: {
    backgroundColor: PLASTER,
    borderRadius: radius.lg,
    height: PANEL_HEIGHT,
    overflow: 'hidden',
  },
  panelFrame: { alignItems: 'center', left: 0, position: 'absolute', right: 0, top: PANEL_FRAME_TOP },
  copy: { gap: 6 },
  eyebrow: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.9,
  },
  title: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 28, lineHeight: 32 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 },
  tips: { gap: 14 },
  tipRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  tipTile: {
    alignItems: 'center',
    borderRadius: radius.md,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  tipTileLight: { backgroundColor: colors.primaryTint },
  tipTileDark: { backgroundColor: colors.ink },
  tipText: { flex: 1, gap: 1 },
  tipTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  tipBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  footer: { paddingHorizontal: 24, paddingTop: 18 },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    height: 52,
    justifyContent: 'center',
  },
  primaryButtonPressed: { opacity: 0.85 },
  primaryButtonText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 16 },
});
