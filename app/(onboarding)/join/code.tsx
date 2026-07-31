// J1 -- Invite code entry (docs/plans/onboarding-design-brief.md, WP4). The
// join path's own entry point: reached via the welcome fork's "I have an
// invite" (onb-welcome-invite-button) or a deep link that already stored a
// code (getPendingInviteCode -- src/utils/pending-invite-code.ts, the same
// storage app/invite.tsx writes to). Reuses the existing invite-code format
// helpers verbatim (src/utils/invites.ts) -- never re-derive the word-code
// shape.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, fonts, radius } from '@/constants/theme';
import { onboardingJoinFoundRoute } from '@/lib/onboarding-routes';
import {
  formatInviteCodeInput,
  isValidInviteCodeShape,
  normalizeInviteCode,
} from '@/utils/invites';
import { getPendingInviteCode, setPendingInviteCode } from '@/utils/pending-invite-code';

const INVALID_SHAPE_MESSAGE = 'Enter the 3-word code, like sunny-tiger-lake.';

export default function JoinCodeScreen() {
  const [code, setCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Prefill from a deep link's stored code (app/invite.tsx) -- never cleared
  // here, only ever consumed once the code is actually redeemed (J4).
  useEffect(() => {
    let isMounted = true;

    void getPendingInviteCode().then((pending) => {
      if (isMounted && pending) {
        setCode(formatInviteCodeInput(pending));
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const handleChangeCode = (text: string) => {
    setCode(formatInviteCodeInput(text));
    setErrorMessage('');
  };

  const handleSubmit = () => {
    const normalized = normalizeInviteCode(code);

    if (!isValidInviteCodeShape(normalized)) {
      setErrorMessage(INVALID_SHAPE_MESSAGE);
      return;
    }

    setErrorMessage('');
    void setPendingInviteCode(normalized);
    router.push(onboardingJoinFoundRoute);
  };

  return (
    <OnbShell
      footer={
        <OnbButton
          disabled={!code.trim()}
          label="Find my family"
          onPress={handleSubmit}
          style={styles.fullWidthButton}
          testID="onb-join-code-submit-button"
        />
      }
      testID="onb-join-code-screen"
    >
      <View style={styles.container}>
        <OnbDisplay size={33}>Someone saved you a seat.</OnbDisplay>
        <OnbBody muted style={styles.body}>
          Type your invite code. It&apos;s a few words, like{' '}
          <Text style={styles.mono}>sunny-otter-lake</Text>. Whoever invited you has it.
        </OnbBody>

        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onChangeText={handleChangeCode}
          placeholder="your-invite-code"
          placeholderTextColor={colors.ink3}
          style={styles.input}
          testID="onb-join-code-input"
          value={code}
        />

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
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
  body: {
    marginTop: 12,
  },
  mono: {
    fontFamily: 'SpaceMono',
    fontSize: 13.5,
    backgroundColor: colors.surface,
  },
  input: {
    marginTop: 26,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radius.lg,
    padding: 16,
    fontFamily: 'SpaceMono',
    fontSize: 18,
    letterSpacing: 0.5,
    color: colors.ink,
  },
  error: {
    marginTop: 12,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.error,
  },
  fullWidthButton: {
    width: '100%',
  },
});
