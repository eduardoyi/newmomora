import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthErrorMessage, AuthField, AuthInput } from '@/components/auth-screen';
import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { sharingWaitingRouteWithName } from '@/lib/routes';
import { redeemFamilyInvite } from '@/services/invites';
import {
  formatInviteCodeInput,
  isValidInviteCodeShape,
  normalizeInviteCode,
} from '@/utils/invites';
import { clearPendingInviteCode, getPendingInviteCode } from '@/utils/pending-invite-code';

/**
 * Error codes after which the stored pendingInviteCode is spent: the server
 * definitively rejected THIS code, so keeping it around would only re-prefill
 * a dead code. Transient failures (rate limit, network, 500s) keep the code.
 */
const DEFINITIVE_FAILURE_CODES = new Set(['invalid_code', 'already_member']);

export default function RedeemInviteScreen() {
  const [code, setCode] = useState('');
  const [isRedeeming, setIsRedeeming] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Prefill from a universal-link code stored by app/invite.tsx. The stored
  // code is NOT cleared here -- only a redemption attempt consumes it.
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

  const handleRedeem = async () => {
    const normalized = normalizeInviteCode(code);

    if (!isValidInviteCodeShape(normalized)) {
      setErrorMessage('Enter the 3-word code, like sunny-tiger-lake.');
      return;
    }

    setErrorMessage('');
    setIsRedeeming(true);

    try {
      const { data, error } = await redeemFamilyInvite(normalized);

      if (error) {
        if (error.code && DEFINITIVE_FAILURE_CODES.has(error.code)) {
          await clearPendingInviteCode();
        }
        setErrorMessage(error.message);
        return;
      }

      await clearPendingInviteCode();
      router.replace(sharingWaitingRouteWithName(data?.familyName ?? ''));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not redeem the code');
    } finally {
      setIsRedeeming(false);
    }
  };

  return (
    <KeyboardAwareFormScreen>
      <View style={styles.header}>
        {router.canGoBack() ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
            testID="redeem-back"
          >
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
        ) : null}
        <Text style={styles.eyebrow}>Momora</Text>
        <Text style={styles.title}>Join a family journal</Text>
        <Text style={styles.subtitle}>
          Enter the 3-word code you were sent. Whoever invited you will confirm it&apos;s you.
        </Text>
      </View>

      <View style={styles.form}>
        <AuthField label="Invite code">
          <AuthInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={handleChangeCode}
            placeholder="sunny-tiger-lake"
            style={styles.codeInput}
            testID="redeem-code-input"
            value={code}
          />
        </AuthField>

        <AuthErrorMessage message={errorMessage} />

        <Pressable
          accessibilityRole="button"
          disabled={isRedeeming}
          onPress={() => void handleRedeem()}
          style={({ pressed }) => [
            styles.redeemButton,
            isRedeeming && styles.redeemButtonDisabled,
            pressed && !isRedeeming && styles.redeemButtonPressed,
          ]}
          testID="redeem-submit-button"
        >
          {isRedeeming ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.redeemButtonText}>Join family</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAwareFormScreen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.sm,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontFamily: fonts.sansBold,
  },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.primary,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 34,
    color: colors.ink,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink3,
  },
  form: {
    gap: spacing.md,
  },
  codeInput: {
    fontFamily: 'SpaceMono',
    fontSize: 18,
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  redeemButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    paddingVertical: 16,
  },
  redeemButtonDisabled: {
    opacity: 0.7,
  },
  redeemButtonPressed: {
    backgroundColor: colors.primaryDark,
  },
  redeemButtonText: {
    fontFamily: fonts.sansBold,
    color: colors.white,
    fontSize: 16,
  },
});
