// S8 -- Bridge to action (docs/plans/onboarding-design-brief.md, WP1). The
// reframe, minimal and airy, setting up the guided first capture (S9). Body
// personalizes on the kid's name for a single-kid family; for more than one
// kid it uses the journal-flavored "Your" (see journalPossessive's doc
// comment in onboarding-copy.ts) rather than singling out whichever kid was
// entered first.
//
// Device-reported bug (2026-07-31): this used to read only
// `draft.kidNames[0]`, so a two-kid family's body always named the
// first-entered kid ("Enzo's journal...") regardless of how many kids
// existed -- exactly the "picking a favorite" disparity naming this feature
// exists to avoid (docs/features/onboarding.md decision 8). S8 runs before
// S9's capture/tagging exists, so this resolves off the full kid list, not
// a tagged subset.
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingCaptureRoute } from '@/lib/onboarding-routes';
import { capitalizeFragment, journalPossessive, kidsPossessive } from '@/utils/onboarding-copy';

const ACCENT = 'no blank pages here';
const HEADLINE = "You're not behind. There is no behind.";
const BODY_SUFFIX = ' journal starts with one little thing from this week. Silly counts. Boring counts double.';

export default function BridgeScreen() {
  const { draft, patch } = useOnboardingFlow();

  useEffect(() => {
    patch({ step: 'bridge' });
  }, [patch]);

  const possessiveFirstName = capitalizeFragment(journalPossessive(kidsPossessive(draft.kidNames)));

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
