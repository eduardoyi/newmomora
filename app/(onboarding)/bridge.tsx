// S8 -- Bridge to action (docs/plans/onboarding-design-brief.md, WP1). The
// reframe, minimal and airy, setting up the guided first capture (S9). Body
// personalizes on the first-entered kid regardless of how many kids were
// named (design brief S8: "body personalized on the first kid").
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingCaptureRoute } from '@/lib/onboarding-routes';
import { possessive } from '@/utils/onboarding-copy';

const ACCENT = 'no blank pages here';
const HEADLINE = "You're not behind. There is no behind.";
const BODY_SUFFIX = ' journal starts with one little thing from this week. Silly counts. Boring counts double.';

export default function BridgeScreen() {
  const { draft, patch } = useOnboardingFlow();

  useEffect(() => {
    patch({ step: 'bridge' });
  }, [patch]);

  const firstKidName = draft.kidNames[0]?.trim();
  // Defensive fallback only -- S6 requires at least one kid name to reach
  // this screen at all, so the empty case is unreachable in practice.
  const possessiveFirstName = firstKidName ? possessive(firstKidName) : 'Their';

  return (
    <OnbShell
      footer={
        <OnbButton
          label="Start with tonight"
          onPress={() => router.push(onboardingCaptureRoute)}
          style={styles.fullWidthButton}
          testID="onb-bridge-cta-button"
        />
      }
      testID="onb-bridge-screen"
    >
      <View style={styles.container}>
        <OnbScript color={colors.primary} size={27} style={styles.accent}>
          {ACCENT}
        </OnbScript>
        <OnbDisplay size={36}>{HEADLINE}</OnbDisplay>
        <OnbBody muted size={16} style={styles.body}>
          {possessiveFirstName}
          {BODY_SUFFIX}
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  accent: {
    transform: [{ rotate: '-2deg' }],
    marginBottom: 22,
  },
  body: {
    marginTop: 18,
  },
  fullWidthButton: {
    width: '100%',
  },
});
