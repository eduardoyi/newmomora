// S4 -- Founder intro A (docs/plans/onboarding-design-brief.md, WP1). Social
// proof placed after the recognition beats (spec decision 14) so it reads
// as "we live this too," not a credentials slide.
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, radius } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingArtifactRoute } from '@/lib/onboarding-routes';

// Plain string constants (interpolated via {}) rather than raw JSX text --
// sidesteps react/no-unescaped-entities for the apostrophe and keeps the
// design brief's exact copy trivially diffable against this file.
const HEADLINE = "We're Eduardo & Adriana.";
const BODY = 'Two kids. Thousands of photos. A baby book that stops at month four (see above).';
const CAPTION = 'made by tired parents, for tired parents';

export default function FoundersScreen() {
  const { patch } = useOnboardingFlow();

  useEffect(() => {
    patch({ step: 'founders' });
  }, [patch]);

  return (
    <OnbShell
      footer={
        <OnbButton
          label="Sounds familiar"
          onPress={() => router.push(onboardingArtifactRoute)}
          style={styles.fullWidthButton}
          testID="onb-founders-cta-button"
        />
      }
      testID="onb-founders-screen"
    >
      <View style={styles.container}>
        <View style={styles.portraitWrap}>
          <OnbIllustration slot="founders" style={styles.portraitImage} testID="onb-founders-illustration" />
        </View>
        <OnbScript color={colors.ink2} size={24} style={styles.caption}>
          {CAPTION}
        </OnbScript>
        <OnbDisplay size={31} style={styles.headline}>
          {HEADLINE}
        </OnbDisplay>
        <OnbBody muted size={15.5} style={styles.body}>
          {BODY}
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 26,
    paddingTop: 60,
  },
  portraitWrap: {
    width: 210,
    height: 210,
    borderRadius: radius.lg,
    overflow: 'hidden',
    transform: [{ rotate: '-2deg' }],
  },
  portraitImage: {
    width: '100%',
    height: '100%',
  },
  caption: {
    marginTop: 14,
    transform: [{ rotate: '-2deg' }],
  },
  headline: {
    marginTop: 26,
    textAlign: 'center',
  },
  body: {
    marginTop: 12,
    textAlign: 'center',
  },
  fullWidthButton: {
    width: '100%',
  },
});
