// S10b -- "A year of these": the memory-types showcase (docs/plans/
// onboarding-design-brief.md S10b, docs/plans/onboarding-implementation.md
// WP2). The user's real first card (from the device-local draft, same as
// S10 -- nothing is saved server-side yet) anchors a mocked timeline of
// example cards using founder-family sample content from the design
// handoff. Self-scrolls slowly and stops for reduce-motion or when the
// screen loses focus (the Stack keeps this screen mounted underneath later
// steps, so a plain unmount-only cleanup would leave the loop running).
import { router, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { colors, emotionColors, fonts, radius, spacing, type EmotionName } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingNotificationsRoute } from '@/lib/onboarding-routes';
import { possessive } from '@/utils/onboarding-copy';

// One full forward pass of the drift (docs/plans/onboarding-design-brief.md
// S10b "~38s" note) -- the loop then plays the same distance back up before
// repeating, matching the handoff's `alternate infinite` CSS animation.
const DRIFT_DURATION_MS = 38000;

function YearCardFooter({ day, tint }: { day: string; tint: EmotionName }) {
  const emo = emotionColors[tint];
  return (
    <View style={styles.cardFooter}>
      <Text style={styles.cardFooterDay}>{day}</Text>
      <View style={styles.footerSpacer} />
      <View style={[styles.emotionChip, { backgroundColor: emo.soft }]}>
        <View style={[styles.emotionDot, { backgroundColor: emo.c }]} />
        <Text style={[styles.emotionLabel, { color: emo.ink }]}>{tint}</Text>
      </View>
    </View>
  );
}

function ExampleWash({ tint }: { tint: EmotionName }) {
  const emo = emotionColors[tint];
  return (
    <View style={styles.exampleWash}>
      <LinearGradient
        colors={[emo.soft, `${emo.c}55`]}
        end={{ x: 1, y: 1 }}
        start={{ x: 0, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

function PlaceholderMedia({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.exampleWash, { backgroundColor: color }]}>
      <Text style={styles.placeholderMediaLabel}>{label}</Text>
    </View>
  );
}

export default function OnboardingYearScreen() {
  const { draft } = useOnboardingFlow();
  const capture = draft.capture;

  const taggedNames = (capture?.taggedKidIndexes ?? [])
    .map((index) => draft.kidNames[index])
    .filter((name): name is string => Boolean(name));
  const journalOwner = taggedNames.length === 1 ? possessive(taggedNames[0]) : 'their';

  const [contentHeight, setContentHeight] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
  const [driftAnim] = useState(() => new Animated.Value(0));
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  const driftDistance = Math.max(contentHeight - stageHeight, 0);

  const startDrift = useCallback(() => {
    loopRef.current?.stop();

    if (driftDistance <= 0) {
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(driftAnim, {
          toValue: -driftDistance,
          duration: DRIFT_DURATION_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(driftAnim, {
          toValue: 0,
          duration: DRIFT_DURATION_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loopRef.current = loop;
    loop.start();
  }, [driftAnim, driftDistance]);

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
    () => `Talk, type, photos, video. Some become illustrated pages. All of it lands in ${journalOwner}'s journal.`,
    [journalOwner],
  );

  return (
    <OnbShell
      footer={
        <OnbButton
          label="I could actually do this"
          onPress={handleContinue}
          style={styles.fullWidthButton}
          testID="onboarding-year-continue"
        />
      }
    >
      <View style={styles.header}>
        <OnbDisplay size={30}>A year of these looks like this.</OnbDisplay>
      </View>

      <View
        onLayout={(event) => setStageHeight(event.nativeEvent.layout.height)}
        style={styles.stage}
        testID="onboarding-year-stage"
      >
        <Animated.View
          onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
          style={[styles.timeline, { transform: [{ translateY: driftAnim }] }]}
        >
          {/* The user's real card, anchored at the start -- same content as
              S10, no animation here (it already had its moment). */}
          <View style={styles.cardBlock}>
            <View style={[styles.card, styles.realCard]} testID="onboarding-year-real-card">
              {capture?.mediaUri ? (
                <>
                  <View style={styles.mediaPreviewWrap}>
                    <PlaceholderMedia color="#ddc9a8" label="Photo" />
                  </View>
                  {capture.text ? (
                    <View style={styles.captionWrap}>
                      <Text style={styles.caption} numberOfLines={2}>{capture.text}</Text>
                    </View>
                  ) : null}
                </>
              ) : (
                <View style={styles.quoteBody}>
                  <Text style={styles.quoteText} numberOfLines={3}>{capture?.text ?? ''}</Text>
                </View>
              )}
              <YearCardFooter day="Tonight" tint="joy" />
            </View>
            <OnbScript color={colors.ink3} size={16} style={styles.annotation}>
              your 20 seconds, tonight
            </OnbScript>
          </View>

          {/* Illustrated example -- no real art yet (decision 5: styled
              placeholders), left without a Caveat annotation (the brief
              gives 4 annotations for 5 cards). */}
          <View style={styles.cardBlock}>
            <View style={styles.card}>
              <ExampleWash tint="mischief" />
              <View style={styles.captionWrap}>
                <Text style={styles.caption}>Declared the hose &ldquo;broken&rdquo; right after soaking the dog on purpose.</Text>
              </View>
              <YearCardFooter day="Sat, Aug 9" tint="mischief" />
            </View>
          </View>

          {/* Photo example */}
          <View style={styles.cardBlock}>
            <View style={styles.card}>
              <PlaceholderMedia color="#d8c39c" label="Photo" />
              <View style={styles.captionWrap}>
                <Text style={styles.caption}>Two hours at the zoo. Favourite animal: a pigeon.</Text>
              </View>
              <YearCardFooter day="Sun, Oct 12" tint="wonder" />
            </View>
            <OnbScript color={colors.ink3} size={16} style={styles.annotation}>
              a blurry zoo photo, still counts
            </OnbScript>
          </View>

          {/* Video example */}
          <View style={styles.cardBlock}>
            <View style={styles.card}>
              <View style={styles.mediaPreviewWrap}>
                <PlaceholderMedia color="#c9d4bd" label="Video" />
                <View style={styles.durationChip}>
                  <Text style={styles.durationChipText}>0:12</Text>
                </View>
              </View>
              <View style={styles.captionWrap}>
                <Text style={styles.caption}>The laugh that only happens when Dad drops something.</Text>
              </View>
              <YearCardFooter day="Thu, Jan 22" tint="calm" />
            </View>
            <OnbScript color={colors.ink3} size={16} style={styles.annotation}>
              12 seconds of the belly laugh
            </OnbScript>
          </View>

          {/* One-line text quote example */}
          <View style={styles.cardBlock}>
            <View style={styles.card}>
              <View style={styles.quoteBody}>
                <Text style={styles.quoteText}>&ldquo;More bastetti please.&rdquo;</Text>
              </View>
              <YearCardFooter day="Tue, Mar 3" tint="tender" />
            </View>
            <OnbScript color={colors.ink3} size={16} style={styles.annotation}>
              the word he invented for spaghetti
            </OnbScript>
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

      <OnbBody muted size={14} style={styles.belowMockCaption}>
        {bodyText}
      </OnbBody>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
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
  timeline: {
    gap: 20,
    paddingHorizontal: 24,
    paddingTop: 4,
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
  realCard: {
    borderColor: colors.primary,
    borderWidth: 1.5,
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
  exampleWash: {
    alignItems: 'center',
    aspectRatio: 4 / 3,
    justifyContent: 'center',
    width: '100%',
  },
  placeholderMediaLabel: {
    color: 'rgba(44,36,24,0.45)',
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
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
  belowMockCaption: {
    paddingBottom: 18,
    paddingHorizontal: 26,
    paddingTop: 8,
    textAlign: 'center',
  },
  fullWidthButton: {
    width: '100%',
  },
});
