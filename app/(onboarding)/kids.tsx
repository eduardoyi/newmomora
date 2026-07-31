// S6 -- Kid name(s) (docs/plans/onboarding-design-brief.md, WP1). The only
// typing before capture and the highest-value single commitment (spec
// decision 8). Supports multiple kids without adding friction for
// single-kid parents: one field by default, a quiet "+ add another"
// affordance turns the typed name into a deletable chip.
//
// Continue must accept EITHER already-added chips OR a non-empty un-added
// field -- a parent who types one name and never taps "+ Add another
// kiddo" must not be blocked (plan WP1, S6 note).
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { KidChip } from '@/components/onboarding/kid-chip';
import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, fonts } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingFamilyNameRoute } from '@/lib/onboarding-routes';

const HEADLINE = "Who's this journal for?";
const HELPER = 'Nicknames welcome. No favorites here, add them all.';
const ADD_AFFORDANCE_LABEL = '＋ Add another kiddo';
const PLACEHOLDER_FIRST = 'Their first name';
const PLACEHOLDER_NEXT = 'And their name';

export default function KidsScreen() {
  const { draft, patch } = useOnboardingFlow();
  const [chips, setChips] = useState<string[]>(() => draft.kidNames);
  const [name, setName] = useState('');

  useEffect(() => {
    patch({ step: 'kids' });
  }, [patch]);

  const canContinue = chips.length > 0 || name.trim().length > 0;

  const handleAddKid = () => {
    const trimmed = name.trim();

    if (!trimmed) {
      return;
    }

    const next = [...chips, trimmed];
    setChips(next);
    setName('');
    patch({ kidNames: next });
  };

  const handleRemoveKid = (index: number) => {
    const next = chips.filter((_, chipIndex) => chipIndex !== index);
    setChips(next);
    patch({ kidNames: next });
  };

  const handleContinue = () => {
    const trimmed = name.trim();
    const finalNames = trimmed ? [...chips, trimmed] : chips;

    if (finalNames.length === 0) {
      return;
    }

    patch({ kidNames: finalNames });
    router.push(onboardingFamilyNameRoute);
  };

  return (
    <OnbShell
      footer={
        <OnbButton
          disabled={!canContinue}
          label="Continue"
          onPress={handleContinue}
          style={styles.fullWidthButton}
          testID="onb-kids-continue-button"
        />
      }
      testID="onb-kids-screen"
    >
      <View style={styles.container}>
        <View style={styles.doodleWrap}>
          <OnbIllustration slot="kids-doodle" style={styles.doodleImage} testID="onb-kids-doodle-illustration" />
        </View>
        <OnbDisplay size={34}>{HEADLINE}</OnbDisplay>
        {chips.length > 0 ? (
          <View style={styles.chipsRow}>
            {chips.map((kidName, index) => (
              <KidChip
                index={index}
                key={`${kidName}-${index}`}
                name={kidName}
                onRemove={() => handleRemoveKid(index)}
                testID={`onb-kids-chip-${index}`}
              />
            ))}
          </View>
        ) : null}
        <TextInput
          autoFocus
          onChangeText={setName}
          placeholder={chips.length > 0 ? PLACEHOLDER_NEXT : PLACEHOLDER_FIRST}
          placeholderTextColor={colors.ink3}
          style={[
            styles.input,
            { fontSize: chips.length > 0 ? 30 : 38 },
            { borderBottomColor: name.trim() ? colors.primary : colors.borderStrong },
            chips.length > 0 && styles.inputWithChips,
          ]}
          testID="onb-kids-input"
          value={name}
        />
        <Pressable
          accessibilityRole="button"
          onPress={handleAddKid}
          style={styles.addAffordance}
          testID="onb-kids-add-button"
        >
          <Text style={styles.addAffordanceText}>{ADD_AFFORDANCE_LABEL}</Text>
        </Pressable>
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
  doodleWrap: {
    position: 'absolute',
    top: 8,
    right: 4,
    width: 96,
    height: 96,
    opacity: 0.85,
    transform: [{ rotate: '3deg' }],
  },
  doodleImage: {
    width: '100%',
    height: '100%',
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 22,
  },
  input: {
    marginTop: 26,
    width: '100%',
    borderBottomWidth: 2,
    paddingVertical: 4,
    paddingBottom: 10,
    fontFamily: fonts.display,
    color: colors.ink,
  },
  inputWithChips: {
    marginTop: 18,
  },
  addAffordance: {
    marginTop: 14,
    alignSelf: 'flex-start',
  },
  addAffordanceText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.primary,
  },
  helper: {
    marginTop: 12,
  },
  fullWidthButton: {
    width: '100%',
  },
});
