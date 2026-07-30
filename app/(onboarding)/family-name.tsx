// S7 -- Family name (docs/plans/onboarding-design-brief.md, WP1). Light
// commitment, one tap, zero typing by default: the field prefills from
// `defaultFamilyName(kidNames)` (kids are asked first specifically so this
// screen can default without a surname, per spec decision 9) and stays
// editable. If the draft already carries an edited `familyName` (resuming
// after a previous visit), that value wins over recomputing the default.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, fonts, radius } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingBridgeRoute } from '@/lib/onboarding-routes';
import { defaultFamilyName, possessiveHeadline } from '@/utils/onboarding-copy';

const HELPER = 'You can change this any time, e.g. to "The Rivera Family".';
const CTA_LABEL = "That's us";

export default function FamilyNameScreen() {
  const { draft, patch } = useOnboardingFlow();
  const [value, setValue] = useState(() => draft.familyName || defaultFamilyName(draft.kidNames));

  useEffect(() => {
    patch({ step: 'family-name' });
  }, [patch]);

  const headline = possessiveHeadline(draft.kidNames);

  const handleContinue = () => {
    patch({ familyName: value.trim() });
    router.push(onboardingBridgeRoute);
  };

  return (
    <OnbShell
      footer={
        <OnbButton
          label={CTA_LABEL}
          onPress={handleContinue}
          style={styles.fullWidthButton}
          testID="onb-family-name-continue-button"
        />
      }
      testID="onb-family-name-screen"
    >
      <View style={styles.container}>
        <View style={styles.nestWrap}>
          <OnbIllustration slot="family-nest" style={styles.nestImage} testID="onb-family-name-illustration" />
        </View>
        <OnbDisplay size={33}>{headline}</OnbDisplay>
        <View style={styles.inputRow}>
          <TextInput
            onChangeText={setValue}
            style={styles.input}
            testID="onb-family-name-input"
            value={value}
          />
          <Text style={styles.editGlyph}>✎</Text>
        </View>
        <OnbBody muted size={13.5} style={styles.helper}>
          {HELPER}
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 26,
  },
  nestWrap: {
    width: 92,
    height: 92,
    marginBottom: 24,
    transform: [{ rotate: '-3deg' }],
  },
  nestImage: {
    width: '100%',
    height: '100%',
  },
  inputRow: {
    marginTop: 26,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  input: {
    flex: 1,
    fontFamily: fonts.display,
    fontSize: 22,
    color: colors.ink,
    padding: 0,
  },
  editGlyph: {
    fontSize: 17,
    color: colors.ink3,
  },
  helper: {
    marginTop: 12,
  },
  fullWidthButton: {
    width: '100%',
  },
});
