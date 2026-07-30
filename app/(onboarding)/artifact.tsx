// S5 -- Founder intro B, the artifact demo (docs/plans/onboarding-design-brief.md,
// WP1). Social proof + product demo: shows the illustration style without
// generating anything. Three REAL illustrated memory pages of the founders'
// own kids (src/constants/onboarding-memories.ts's artifactMemories), fanned
// like pages of a book. S15's paywall backdrop reuses the SAME data module
// (paywallBackdropMemories, a subset of S10b's yearMemories) rather than
// sharing assets with this screen -- the generic "paywall-page-1/3/4"
// illustration slots this screen used to originate before real art landed
// are gone; onboarding-illustrations.ts no longer defines them.
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, emotionColors, fonts, radius } from '@/constants/theme';
import { artifactMemories, formatMemoryDayLabel, type OnboardingSampleMemory } from '@/constants/onboarding-memories';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingKidsRoute } from '@/lib/onboarding-routes';

const HEADLINE = 'So we built this for our own kids.';
const BODY = 'Things we mumbled into our phones at 9 p.m., turned into pages like these.';
const ANNOTATION = 'jotted in 20 seconds, kept forever';

interface CardLayout {
  rotateDeg: number;
  left: number;
  top: number;
  zIndex: number;
}

// Rotations (-8/9/-5) and offsets match the handoff's OnbFounderB card
// layout (src/screens/onboarding-story.jsx) exactly -- one fixed layout slot
// per artifactMemories entry, in the same order.
const CARD_LAYOUTS: readonly CardLayout[] = [
  { rotateDeg: -8, left: 0, top: 0, zIndex: 3 },
  { rotateDeg: 9, left: 106, top: 150, zIndex: 2 },
  { rotateDeg: -5, left: 4, top: 306, zIndex: 1 },
];

const CARD_WIDTH = 212;
const CARD_STACK_WIDTH = 318;
const CARD_STACK_HEIGHT = 530;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function SampleMemoryCard({ layout, memory }: { layout: CardLayout; memory: OnboardingSampleMemory }) {
  const emotion = memory.emotion ? emotionColors[memory.emotion] : null;
  const day = formatMemoryDayLabel(memory.isoDate);

  return (
    <View
      style={[
        styles.card,
        { left: layout.left, top: layout.top, zIndex: layout.zIndex, transform: [{ rotate: `${layout.rotateDeg}deg` }] },
      ]}
      testID={`onb-artifact-card-${memory.key}`}
    >
      <Image
        accessibilityLabel={memory.text}
        contentFit="cover"
        source={memory.asset}
        style={styles.cardIllustration}
        testID={`onb-artifact-card-${memory.key}-illustration`}
      />
      <View style={styles.cardCaptionWrap}>
        <OnbBody ellipsizeMode="tail" numberOfLines={3} size={12} style={styles.cardCaptionText}>
          {memory.text}
        </OnbBody>
      </View>
      <View style={styles.cardFooter}>
        <Text style={styles.cardFooterDay}>{day}</Text>
        <View style={styles.cardFooterSpacer} />
        {emotion ? (
          <View style={[styles.emotionChip, { backgroundColor: emotion.soft }]}>
            <View style={[styles.emotionDot, { backgroundColor: emotion.c }]} />
            <Text style={[styles.emotionChipLabel, { color: emotion.ink }]}>{capitalize(memory.emotion as string)}</Text>
          </View>
        ) : null}
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
          {artifactMemories.map((memory, index) => (
            <SampleMemoryCard key={memory.key} layout={CARD_LAYOUTS[index]} memory={memory} />
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
