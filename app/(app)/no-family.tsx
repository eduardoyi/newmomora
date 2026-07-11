import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthErrorMessage, AuthField, AuthInput } from '@/components/auth-screen';
import { KeyboardAwareFormScreen } from '@/components/keyboard-aware-form-screen';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { sharingRedeemRoute, timelineRoute } from '@/lib/routes';
import { createFamily } from '@/services/family';
import { getPendingInviteCode } from '@/utils/pending-invite-code';

function friendlyCreateFamilyError(message: string, code?: string): string {
  if (code === 'P0001' && /maximum 5 owned families/i.test(message)) {
    return "You've reached the limit of 5 family journals for one account.";
  }
  return message;
}

export default function NoFamilyScreen() {
  const { familyId, justLostAccess, refetchMemberships } = useFamily();
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Backstop: if the user already has (or just got) a family while sitting
  // on this route, move on rather than leaving them stranded here.
  useEffect(() => {
    if (familyId) {
      router.replace(timelineRoute);
    }
  }, [familyId]);

  // Guard precedence (plan §9): a stored pendingInviteCode wins. If a
  // universal-link code got the user redirected here (FamilyProvider's
  // no-membership guard), forward to the redeem screen prefilled -- the code
  // itself stays in storage until a redemption attempt consumes it.
  useEffect(() => {
    let isMounted = true;

    void getPendingInviteCode().then((pendingCode) => {
      if (isMounted && pendingCode) {
        router.replace(sharingRedeemRoute);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const handleCreate = async () => {
    const trimmed = name.trim();

    if (!trimmed) {
      setErrorMessage('Give your family journal a name');
      return;
    }

    setErrorMessage('');
    setIsCreating(true);

    try {
      const { data, error } = await createFamily(trimmed);

      if (error || !data) {
        throw new Error(friendlyCreateFamilyError(error?.message ?? 'Could not create your family', error?.code));
      }

      await refetchMemberships();
      router.replace(timelineRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not create your family');
    } finally {
      setIsCreating(false);
    }
  };

  const handleInviteCodePress = () => {
    router.push(sharingRedeemRoute);
  };

  return (
    <KeyboardAwareFormScreen>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>Momora</Text>
        <Text style={styles.title}>
          {justLostAccess ? 'You no longer have access' : 'Start your family journal'}
        </Text>
        <Text style={styles.subtitle}>
          {justLostAccess
            ? 'You left or were removed from your family journal. Start a new one, or ask for a fresh invite.'
            : 'Give it a name — you can invite the rest of the family once you are set up.'}
        </Text>
      </View>

      <View style={styles.form}>
        <AuthField label="Family name">
          <AuthInput
            autoCapitalize="words"
            onChangeText={setName}
            placeholder="e.g. The Rivera family"
            testID="no-family-name-input"
            value={name}
          />
        </AuthField>

        <AuthErrorMessage message={errorMessage} />

        <Pressable
          accessibilityRole="button"
          disabled={isCreating}
          onPress={() => void handleCreate()}
          style={({ pressed }) => [
            styles.createButton,
            isCreating && styles.createButtonDisabled,
            pressed && !isCreating && styles.createButtonPressed,
          ]}
          testID="no-family-create-button"
        >
          {isCreating ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.createButtonText}>Create family journal</Text>
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={handleInviteCodePress}
          style={styles.inviteCodeButton}
          testID="no-family-invite-code-button"
        >
          <Text style={styles.inviteCodeButtonText}>Have an invite code?</Text>
        </Pressable>
      </View>
    </KeyboardAwareFormScreen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.sm,
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
  createButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    paddingVertical: 16,
  },
  createButtonDisabled: {
    opacity: 0.7,
  },
  createButtonPressed: {
    backgroundColor: colors.primaryDark,
  },
  createButtonText: {
    fontFamily: fonts.sansBold,
    color: colors.white,
    fontSize: 16,
  },
  inviteCodeButton: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  inviteCodeButtonText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.ink3,
  },
});
