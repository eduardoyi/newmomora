// S10b -- "A year of these": the memory-types showcase (docs/plans/
// onboarding-design-brief.md S10b, docs/plans/onboarding-implementation.md
// WP2's S10b bullet). A calm, NON-INTERACTIVE showcase of 20 REAL example
// cards from src/constants/onboarding-memories.ts (yearMemories) --
// illustrated pages, photos, videos, and one-line quotes from the founders'
// own kids, current-pipeline quality. The user watches; they don't touch.
//
// Device-testing fix (2026-07-31): the user's own captured memory used to
// anchor the top of the mock timeline, mixed in among the demo-family
// cards. Owner feedback: odd for their one real memory to sit among a
// stranger's year. Removed -- this screen now shows only the demo
// memories. The headline was rewritten to match (it used to lean on "these"
// pointing at that now-removed card).
//
// Layout fix (2026-07-31): this screen has no text input and needs no
// keyboard handling, but it was rendering inside `OnbShell`, whose body is
// a `KeyboardAwareScrollView` -- so on real devices the whole
// headline+timeline+body content was user-scrollable, and only the CTA was
// actually pinned. That's backwards for a screen whose entire point is a
// fixed headline/body around a self-scrolling, non-interactive timeline.
// This screen deliberately does NOT use `OnbShell` (its scrolling body
// isn't right for this screen, and `onb-shell.tsx` is being edited by
// another agent concurrently) -- it builds its own small fixed layout
// instead: `SafeAreaView` > pinned header > flexed animated stage > pinned
// footer (body copy directly above the CTA), reusing OnbShell's exported
// `getFooterBottomPadding` helper so the footer still gets the same
// Android-nav-bar-safe bottom padding every other onboarding screen does.
//
// The timeline drifts upward at a CONSTANT speed (DRIFT_SPEED_PX_PER_SECOND)
// rather than a fixed duration, so 20 real cards move at the same visual
// pace a shorter mock once did. It loops SEAMLESSLY: the card list renders
// twice back-to-back, the first copy's measured height is the exact
// translateY distance, and Animated.loop's reset-to-start lands pixel-for-
// pixel on the same frame the animation just reached -- there is no visible
// "snap back" the old alternate/reverse ping-pong had. The second copy is
// hidden from accessibility (it's a visual duplicate, not new content) and
// omits testIDs so nothing in the tree is ambiguously duplicated.
//
// Self-scrolls slowly and stops for reduce-motion or when the screen loses
// focus (the Stack keeps this screen mounted underneath later steps, so a
// plain unmount-only cleanup would leave the loop running).
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Play } from 'lucide-react-native';
import { useCallback, useMemo, useState, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { OnbButton } from '@/components/onboarding/onb-button';
import { getFooterBottomPadding } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { colors, emotionColors, fonts, radius, spacing, type EmotionName } from '@/constants/theme';
import { formatMemoryDayLabel, yearMemories, type OnboardingSampleMemory } from '@/constants/onboarding-memories';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingNotificationsRoute } from '@/lib/onboarding-routes';
import { possessive } from '@/utils/onboarding-copy';

// Constant visual speed (docs/plans/onboarding-implementation.md WP-follow-up
// "replace DRIFT_DURATION_MS with DRIFT_SPEED_PX_PER_SECOND"): the loop's
// duration is derived from the measured content height below, so 20 real
// cards drift at the same pace 5 mock cards once did rather than covering
// more distance in the same fixed time (which would look sped up).
const DRIFT_SPEED_PX_PER_SECOND = 40;

// "the little things" is straight from the VoC copy rules
// (docs/voice-of-customer.md §6); this headline no longer needs to point at
// anything specific on screen (there's no more real card to anchor "these"
// to), so it just names what the demo timeline below it is made of.
const HEADLINE = 'A year of little memories adds up.';

function YearCardFooter({ day, tint }: { day: string; tint?: EmotionName }) {
  const emo = tint ? emotionColors[tint] : null;
  return (
    <View style={styles.cardFooter}>
      <Text style={styles.cardFooterDay}>{day}</Text>
      <View style={styles.footerSpacer} />
      {emo ? (
        <View style={[styles.emotionChip, { backgroundColor: emo.soft }]}>
          <View style={[styles.emotionDot, { backgroundColor: emo.c }]} />
          <Text style={[styles.emotionLabel, { color: emo.ink }]}>{tint}</Text>
        </View>
      ) : null}
    </View>
  );
}

// One example card from yearMemories, rendered per its type. `hidden`
// suppresses the testID for the loop's duplicate copy (see file header).
function ExampleMemoryCard({ hidden, memory }: { hidden?: boolean; memory: OnboardingSampleMemory }) {
  const day = formatMemoryDayLabel(memory.isoDate);
  const testID = hidden ? undefined : `onboarding-year-card-${memory.key}`;

  return (
    <View style={styles.cardBlock}>
      <View style={styles.card} testID={testID}>
        {memory.type === 'text' ? (
          <View style={styles.quoteBody}>
            <Text style={styles.quoteText}>{memory.text}</Text>
          </View>
        ) : (
          <>
            <View style={styles.mediaPreviewWrap}>
              <Image contentFit="cover" source={memory.asset} style={styles.mediaImage} />
              {memory.type === 'video' ? (
                <>
                  <View style={styles.durationChip}>
                    <Text style={styles.durationChipText}>{memory.durationLabel}</Text>
                  </View>
                  <View style={styles.playButton}>
                    <Play color={colors.white} fill={colors.white} size={13} />
                  </View>
                </>
              ) : null}
            </View>
            <View style={styles.captionWrap}>
              <Text style={styles.caption}>{memory.text}</Text>
            </View>
          </>
        )}
        <YearCardFooter day={day} tint={memory.emotion} />
      </View>
      {memory.annotation ? (
        <OnbScript color={colors.ink3} size={16} style={styles.annotation}>
          {memory.annotation}
        </OnbScript>
      ) : null}
    </View>
  );
}

// The full card sequence (all of yearMemories) -- shared by both copies in
// the seamless loop below.
function TimelineCards({ hidden }: { hidden?: boolean }) {
  return (
    <>
      {yearMemories.map((memory) => (
        <ExampleMemoryCard hidden={hidden} key={memory.key} memory={memory} />
      ))}
    </>
  );
}

export default function OnboardingYearScreen() {
  const { draft } = useOnboardingFlow();
  const { bottom: bottomInset } = useSafeAreaInsets();

  const taggedNames = (draft.capture?.taggedKidIndexes ?? [])
    .map((index) => draft.kidNames[index])
    .filter((name): name is string => Boolean(name));
  const journalOwner = taggedNames.length === 1 ? possessive(taggedNames[0]) : 'their';

  const [firstListHeight, setFirstListHeight] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
  const [driftAnim] = useState(() => new Animated.Value(0));
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  const startDrift = useCallback(() => {
    loopRef.current?.stop();

    if (firstListHeight <= stageHeight) {
      return;
    }

    driftAnim.setValue(0);

    const duration = (firstListHeight / DRIFT_SPEED_PX_PER_SECOND) * 1000;

    const loop = Animated.loop(
      Animated.timing(driftAnim, {
        toValue: -firstListHeight,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loopRef.current = loop;
    loop.start();
  }, [driftAnim, firstListHeight, stageHeight]);

  const stopDrift = useCallback(() => {
    loopRef.current?.stop();
    loopRef.current = null;
  }, []);

  // Reduce-motion + focus both gate the loop: hold still for reduce-motion
  // (docs/plans/onboarding-implementation.md WP2 "S10b must ... respect
  // AccessibilityInfo.isReduceMotionEnabled()"), and stop entirely once this
  // screen isn't the focused route -- the Stack keeps it mounted underneath
  // S11/S12, so an unmount-only cleanup would never fire.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      void AccessibilityInfo.isReduceMotionEnabled().then((reduceMotionEnabled) => {
        if (!cancelled && !reduceMotionEnabled) {
          startDrift();
        }
      });

      const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (reduceMotionEnabled) => {
        if (reduceMotionEnabled) {
          stopDrift();
        } else {
          startDrift();
        }
      });

      return () => {
        cancelled = true;
        subscription.remove();
        stopDrift();
      };
    }, [startDrift, stopDrift]),
  );

  const handleContinue = () => {
    router.push(onboardingNotificationsRoute);
  };

  const bodyText = useMemo(
    () => `Talk, type, photos, video. Some become illustrated pages. All of it lands in ${journalOwner} journal.`,
    [journalOwner],
  );

  // No keyboard is ever open on this screen (no TextInput), so the shell's
  // keyboard-aware footer padding always resolves to its closed-keyboard
  // branch -- reused here (rather than re-derived) so this screen keeps the
  // exact same Android-nav-bar overlap protection every other onboarding
  // footer has.
  const footerBottomPadding = getFooterBottomPadding(bottomInset, false);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea} testID="onboarding-year-screen">
      <View style={styles.header} testID="onboarding-year-header">
        <OnbDisplay size={30}>{HEADLINE}</OnbDisplay>
      </View>

      <View
        onLayout={(event) => setStageHeight(event.nativeEvent.layout.height)}
        style={styles.stage}
        testID="onboarding-year-stage"
      >
        <Animated.View style={[styles.timelineTrack, { transform: [{ translateY: driftAnim }] }]}>
          <View onLayout={(event) => setFirstListHeight(event.nativeEvent.layout.height)} style={styles.timelineList}>
            <TimelineCards />
          </View>
          {/* Seamless-loop duplicate: a visual repeat of the same content,
              not new information -- hidden from accessibility on both
              platforms and given no testIDs (TimelineCards' `hidden` prop). */}
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.timelineList}
          >
            <TimelineCards hidden />
          </View>
        </Animated.View>

        <LinearGradient
          colors={[colors.bg, `${colors.bg}00`]}
          pointerEvents="none"
          style={styles.topMask}
        />
        <LinearGradient
          colors={[`${colors.bg}00`, colors.bg]}
          pointerEvents="none"
          style={styles.bottomMask}
        />
      </View>

      <View style={[styles.footer, { paddingBottom: footerBottomPadding }]} testID="onboarding-year-footer">
        <OnbBody muted size={14} style={styles.belowMockCaption}>
          {bodyText}
        </OnbBody>
        <OnbButton
          label="I could actually do this"
          onPress={handleContinue}
          style={styles.fullWidthButton}
          testID="onboarding-year-continue"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  header: {
    paddingHorizontal: 26,
    paddingTop: 20,
  },
  stage: {
    flex: 1,
    marginTop: 14,
    overflow: 'hidden',
    position: 'relative',
  },
  timelineTrack: {
    paddingHorizontal: 24,
    paddingTop: 4,
  },
  // Both loop copies share this: `gap` spaces cards within a copy, and
  // `paddingBottom` (the same value as `gap`) is the seam between this
  // copy's last card and the next copy's first -- keeping every transition,
  // including the loop's wrap point, visually identical.
  timelineList: {
    gap: 20,
    paddingBottom: 20,
  },
  cardBlock: {
    gap: 6,
  },
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  quoteBody: {
    padding: 16,
    paddingBottom: 2,
  },
  quoteText: {
    color: colors.ink,
    fontFamily: fonts.displayItalic,
    fontSize: 15,
    lineHeight: 1.42 * 15,
  },
  mediaPreviewWrap: {
    aspectRatio: 4 / 3,
    position: 'relative',
    width: '100%',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  playButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(44,36,24,0.5)',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -17,
    marginTop: -17,
    position: 'absolute',
    top: '50%',
    width: 34,
  },
  durationChip: {
    backgroundColor: 'rgba(44,36,24,0.62)',
    borderRadius: 999,
    bottom: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    position: 'absolute',
    right: 8,
  },
  durationChipText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
  },
  captionWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: 11,
  },
  caption: {
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 1.4 * 13,
  },
  cardFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
    paddingBottom: 11,
    paddingHorizontal: 13,
    paddingTop: 9,
  },
  cardFooterDay: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 9,
    letterSpacing: 0.07 * 9,
    textTransform: 'uppercase',
  },
  footerSpacer: {
    flex: 1,
  },
  emotionChip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 5,
    paddingLeft: 7,
    paddingRight: 9,
    paddingVertical: 3,
  },
  emotionDot: {
    borderRadius: 999,
    height: 5,
    width: 5,
  },
  emotionLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
  },
  annotation: {
    paddingHorizontal: 4,
    transform: [{ rotate: '-1deg' }],
  },
  topMask: {
    height: 30,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  bottomMask: {
    bottom: 0,
    height: 48,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  footer: {
    gap: 14,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  belowMockCaption: {
    textAlign: 'center',
  },
  fullWidthButton: {
    width: '100%',
  },
});
