// S1-S3 -- recognition story beats (docs/plans/onboarding-design-brief.md,
// WP1). One screen, distinguished by the `beat` search param
// (onboardingStoryRoute in src/lib/onboarding-routes.ts always supplies
// 0|1|2) -- each beat is a commitment + recognition moment with its own
// affirmation CTA, never "Next"/"Continue" (VoC tone rule).
import { router, useLocalSearchParams } from 'expo-router';
import type { Href } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbDots } from '@/components/onboarding/onb-dots';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import type { OnboardingIllustrationSlotId } from '@/constants/onboarding-illustrations';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingFoundersRoute, onboardingStoryRoute } from '@/lib/onboarding-routes';
import type { OnboardingStepId } from '@/utils/onboarding-progress';

interface StoryBeatContent {
  slot: OnboardingIllustrationSlotId;
  headline: string;
  body: string;
  cta: string;
  step: OnboardingStepId;
  nextRoute: Href;
}

// Copy is verbatim from the design brief (S1-S3) -- every headline and CTA
// there is deliberate, including the no-em-dash rule.
const STORY_BEATS: readonly StoryBeatContent[] = [
  {
    slot: 'story-night',
    headline: 'You know the 2 a.m. scroll.',
    body: '"Just checking the monitor," you say, forty minutes deep into photos from March. It\'s fine. No judgment. We do it too.',
    cta: "That's me",
    step: 'story-0',
    nextRoute: onboardingStoryRoute(1),
  },
  {
    slot: 'story-book',
    headline: 'The baby book stops at month six.',
    body: 'Ours stopped at four. Turns out "fill this out nightly" was a big ask during the no-sleep years.',
    cta: 'Who approved that homework',
    step: 'story-1',
    nextRoute: onboardingStoryRoute(2),
  },
  {
    slot: 'story-babble',
    headline: 'The camera caught the first steps.',
    body: "Nobody caught the word she invented for helicopter. That's the stuff that goes, and 20,000 photos won't bring it back.",
    cta: "That's the stuff I want to keep",
    step: 'story-2',
    nextRoute: onboardingFoundersRoute,
  },
];

function resolveBeatIndex(raw: string | string[] | undefined): 0 | 1 | 2 {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (value === '1') {
    return 1;
  }

  if (value === '2') {
    return 2;
  }

  // Missing/unrecognized param never crashes the screen -- it just opens on
  // the first beat.
  return 0;
}

const ILLUSTRATION_HEIGHT_RATIO = 0.44;

export default function StoryScreen() {
  const { beat } = useLocalSearchParams<{ beat?: string }>();
  const { patch } = useOnboardingFlow();
  const { height: windowHeight } = useWindowDimensions();

  const beatIndex = resolveBeatIndex(beat);
  const content = STORY_BEATS[beatIndex];

  useEffect(() => {
    patch({ step: content.step });
  }, [content.step, patch]);

  return (
    <OnbShell
      footer={
        <OnbButton
          label={content.cta}
          onPress={() => router.push(content.nextRoute)}
          style={styles.fullWidthButton}
          testID={`onb-story-${beatIndex}-cta-button`}
        />
      }
      testID="onb-story-screen"
    >
      <View style={[styles.illustrationWrap, { height: windowHeight * ILLUSTRATION_HEIGHT_RATIO }]}>
        <OnbIllustration
          slot={content.slot}
          style={StyleSheet.absoluteFill}
          testID={`onb-story-${beatIndex}-illustration`}
        />
      </View>
      <OnbDots at={beatIndex} n={3} testID="onb-story-dots" />
      <View style={styles.textBlock}>
        <OnbDisplay size={31}>{content.headline}</OnbDisplay>
        <OnbBody muted size={15.5} style={styles.body}>
          {content.body}
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  illustrationWrap: {
    width: '100%',
  },
  textBlock: {
    flex: 1,
    paddingHorizontal: 26,
    paddingTop: 20,
  },
  body: {
    marginTop: 14,
  },
  fullWidthButton: {
    width: '100%',
  },
});
