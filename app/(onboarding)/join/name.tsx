// J3 -- Display name (docs/plans/onboarding-design-brief.md, WP4). The last
// bit of typing before the OTP round trip -- held device-locally (join
// draft, src/services/onboarding-join.ts) so it survives the trip through
// the mail app, then applied to user_profiles.name post-auth by J4.
//
// Known, accepted divergence from the brief (plan decision 6): the brief
// describes a per-family display name, but the schema only has the global
// user_profiles.name. This screen writes that global field -- for someone
// who already belongs to another family, applying it here also renames
// their display name there. Recorded in docs/features/onboarding.md.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, fonts } from '@/constants/theme';
import { onboardingJoinEmailRoute } from '@/lib/onboarding-routes';
import { getJoinDraft, patchJoinDraft } from '@/services/onboarding-join';

export default function JoinNameScreen() {
  const [name, setName] = useState('');

  useEffect(() => {
    let isMounted = true;

    void getJoinDraft().then((draft) => {
      if (isMounted && draft.displayName) {
        setName(draft.displayName);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const handleSubmit = () => {
    const trimmed = name.trim();

    if (!trimmed) {
      return;
    }

    void patchJoinDraft({ displayName: trimmed });
    router.push(onboardingJoinEmailRoute);
  };

  return (
    <OnbShell
      footer={
        <OnbButton
          disabled={!name.trim()}
          label="That's me"
          onPress={handleSubmit}
          style={styles.fullWidthButton}
          testID="onb-join-name-submit-button"
        />
      }
      testID="onb-join-name-screen"
    >
      <View style={styles.container}>
        <OnbDisplay size={34}>What should the family call you?</OnbDisplay>

        <TextInput
          autoCapitalize="words"
          autoFocus
          onChangeText={setName}
          placeholder="Grandma Ana, Uncle Rob, Dad…"
          placeholderTextColor={colors.ink3}
          style={styles.input}
          testID="onb-join-name-input"
          value={name}
        />

        <OnbBody muted size={13.5} style={styles.helper}>
          This shows up next to your comments and memories.
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
  input: {
    marginTop: 26,
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
    fontFamily: fonts.displayMedium,
    fontSize: 32,
    color: colors.ink,
    paddingVertical: 8,
  },
  helper: {
    marginTop: 12,
  },
  fullWidthButton: {
    width: '100%',
  },
});
