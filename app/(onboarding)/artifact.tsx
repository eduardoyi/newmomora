// S5 -- Founder intro B, the artifact demo (docs/plans/onboarding-design-brief.md,
// WP1). Social proof + product demo: shows the illustration style without
// generating anything. Three sample memory cards, fanned like pages of a
// book. There is no dedicated illustration slot for these three cards in
// src/constants/onboarding-illustrations.ts -- the S15 paywall explicitly
// "reuse[s] S5 assets" as its backdrop (design brief S15), which is why the
// three generic "Illustrated page" slots WP0 provided are named
// `paywall-page-1/3/4` rather than an `artifact-*` id: this screen is their
// origin, the paywall is their reuse.
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, emotionColors, fonts, radius, type EmotionName } from '@/constants/theme';
import type { OnboardingIllustrationSlotId } from '@/constants/onboarding-illustrations';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingKidsRoute } from '@/lib/onboarding-routes';

const HEADLINE = 'So we built this for our own kids.';
const BODY = 'Things we mumbled into our phones at 9 p.m., turned into pages like these.';
const ANNOTATION = 'jotted in 20 seconds, kept forever';

interface SampleCard {
  key: string;
  slot: OnboardingIllustrationSlotId;
  emotion: EmotionName;
  emotionLabel: string;
  day: string;
  caption: string;
  rotateDeg: number;
  left: number;
  top: number;
  zIndex: number;
}

// Rotations (-8/9/-5) and offsets match the handoff's OnbFounderB card
// layout (src/screens/onboarding-story.jsx) exactly -- the captions/day
// stamps are this screen's own sample content (the design brief doesn't
// dictate literal per-card copy, only the headline/body/CTA above).
const SAMPLE_CARDS: readonly SampleCard[] = [
  {
    key: 'a',
    slot: 'paywall-page-1',
    emotion: 'joy',
    emotionLabel: 'Joy',
    day: 'Sat, Aug 9',
    caption: 'Declared the hose "broken" right after soaking the dog.',
    rotateDeg: -8,
    left: 0,
    top: 0,
    zIndex: 3,
  },
  {
    key: 'b',
    slot: 'paywall-page-3',
    emotion: 'wonder',
    emotionLabel: 'Wonder',
    day: 'Sun, Oct 12',
    caption: 'Two hours at the zoo. Favourite animal: a pigeon.',
    rotateDeg: 9,
    left: 106,
    top: 150,
    zIndex: 2,
  },
  {
    key: 'c',
    slot: 'paywall-page-4',
    emotion: 'tender',
    emotionLabel: 'Tender',
    day: 'Tue, Mar 3',
    caption: 'Fell asleep mid-sentence about dinosaurs.',
    rotateDeg: -5,
    left: 4,
    top: 306,
    zIndex: 1,
  },
];

const CARD_WIDTH = 212;
const CARD_STACK_WIDTH = 318;
const CARD_STACK_HEIGHT = 530;

function SampleMemoryCard({ card }: { card: SampleCard }) {
  const emotion = emotionColors[card.emotion];

  return (
    <View
      style={[
        styles.card,
        { left: card.left, top: card.top, zIndex: card.zIndex, transform: [{ rotate: `${card.rotateDeg}deg` }] },
      ]}
      testID={`onb-artifact-card-${card.key}`}
    >
      <OnbIllustration
        slot={card.slot}
        style={styles.cardIllustration}
        testID={`onb-artifact-card-${card.key}-illustration`}
      />
      <View style={styles.cardCaptionWrap}>
        <OnbBody size={12} style={styles.cardCaptionText}>
          {card.caption}
        </OnbBody>
      </View>
      <View style={styles.cardFooter}>
        <Text style={styles.cardFooterDay}>{card.day}</Text>
        <View style={styles.cardFooterSpacer} />
        <View style={[styles.emotionChip, { backgroundColor: emotion.soft }]}>
          <View style={[styles.emotionDot, { backgroundColor: emotion.c }]} />
          <Text style={[styles.emotionChipLabel, { color: emotion.ink }]}>{card.emotionLabel}</Text>
        </View>
      </View>
    </View>
  );
}

export default function ArtifactScreen() {
  const { patch } = useOnboardingFlow();

  useEffect(() => {
    patch({ step: 'artifact' });
  }, [patch]);

  return (
    <OnbShell
      footer={
        <OnbButton
          label="Show me how it works"
          onPress={() => router.push(onboardingKidsRoute)}
          style={styles.fullWidthButton}
          testID="onb-artifact-cta-button"
        />
      }
      testID="onb-artifact-screen"
    >
      <View style={styles.intro}>
        <OnbDisplay size={29}>{HEADLINE}</OnbDisplay>
        <OnbBody muted size={14.5} style={styles.introBody}>
          {BODY}
        </OnbBody>
      </View>
      <View style={styles.cardsArea}>
        <View style={styles.cardsStack}>
          {SAMPLE_CARDS.map((card) => (
            <SampleMemoryCard card={card} key={card.key} />
          ))}
          <OnbScript color={colors.primary} size={18} style={styles.annotation}>
            {ANNOTATION}
          </OnbScript>
        </View>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: 26,
    paddingTop: 58,
  },
  introBody: {
    marginTop: 9,
  },
  cardsArea: {
    marginTop: 34,
    alignItems: 'center',
  },
  cardsStack: {
    width: CARD_STACK_WIDTH,
    height: CARD_STACK_HEIGHT,
  },
  card: {
    position: 'absolute',
    width: CARD_WIDTH,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    overflow: 'hidden',
    shadowColor: colors.ink,
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  cardIllustration: {
    width: '100%',
    aspectRatio: 4 / 3,
  },
  cardCaptionWrap: {
    paddingHorizontal: 10,
    paddingTop: 9,
  },
  cardCaptionText: {
    lineHeight: 16,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 7,
    paddingBottom: 8,
  },
  cardFooterDay: {
    fontFamily: fonts.sansBold,
    fontSize: 9,
    letterSpacing: 9 * 0.06,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  cardFooterSpacer: {
    flex: 1,
  },
  emotionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  emotionDot: {
    width: 4.5,
    height: 4.5,
    borderRadius: 2.25,
  },
  emotionChipLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 8.5,
    letterSpacing: 8.5 * 0.03,
  },
  annotation: {
    position: 'absolute',
    left: 220,
    top: 30,
    width: 96,
    transform: [{ rotate: '-4deg' }],
  },
  fullWidthButton: {
    width: '100%',
  },
});
