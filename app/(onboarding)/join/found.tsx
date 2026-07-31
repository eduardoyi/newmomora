// J2 -- Family found (docs/plans/onboarding-design-brief.md, WP4). The only
// pre-auth screen that needs to know the family's name before the user has
// an account -- ensureAnonymousSession (src/lib/anonymous-session.ts) gets a
// JWT, then previewFamilyInvite (src/services/onboarding-join.ts) looks up
// the family + inviter name through WP-SEC's anonymous-facing carve-out
// endpoint. A confirmation, not a pitch (design brief): zero selling.
//
// Degrades honestly per the plan's risk #1: if the anonymous session or the
// preview lookup fails, this never dead-ends -- it falls back to a generic
// confirm state and lets the user continue anyway. The real confirmation
// happens at J4's redeemFamilyInvite call once they're actually signed in,
// so a bad/expired code still surfaces there instead of silently stranding
// the user here.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, emotionColors, fonts, spacing } from '@/constants/theme';
import { ensureAnonymousSession } from '@/lib/anonymous-session';
import { onboardingJoinCodeRoute, onboardingJoinNameRoute } from '@/lib/onboarding-routes';
import { patchJoinDraft, previewFamilyInvite } from '@/services/onboarding-join';
import { getPendingInviteCode } from '@/utils/pending-invite-code';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'missing-code' }
  | { kind: 'ready'; familyName: string; inviterName: string }
  | { kind: 'degraded' };

export default function JoinFoundScreen() {
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      const code = await getPendingInviteCode();

      if (!code) {
        if (isMounted) {
          setState({ kind: 'missing-code' });
        }
        return;
      }

      const { error: sessionError } = await ensureAnonymousSession();

      if (sessionError) {
        if (isMounted) {
          setState({ kind: 'degraded' });
        }
        return;
      }

      const { data, error } = await previewFamilyInvite(code);

      if (!isMounted) {
        return;
      }

      if (error || !data) {
        setState({ kind: 'degraded' });
        return;
      }

      void patchJoinDraft({ inviterName: data.inviterName });
      setState({ kind: 'ready', familyName: data.familyName, inviterName: data.inviterName });
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleConfirm = () => {
    router.push(onboardingJoinNameRoute);
  };

  const handleReenterCode = () => {
    router.replace(onboardingJoinCodeRoute);
  };

  if (state.kind === 'loading') {
    return (
      <OnbShell testID="onb-join-found-screen">
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} size="large" testID="onb-join-found-loading" />
        </View>
      </OnbShell>
    );
  }

  if (state.kind === 'missing-code') {
    return (
      <OnbShell
        footer={
          <OnbButton
            label="Enter my code"
            onPress={handleReenterCode}
            style={styles.fullWidthButton}
            testID="onb-join-found-enter-code-button"
          />
        }
        testID="onb-join-found-screen"
      >
        <View style={styles.centered}>
          <OnbDisplay size={28} style={styles.centerText}>
            We couldn&apos;t find your invite code.
          </OnbDisplay>
          <OnbBody muted style={styles.centerText}>
            Type it in and we&apos;ll take it from there.
          </OnbBody>
        </View>
      </OnbShell>
    );
  }

  const familyName = state.kind === 'ready' ? state.familyName : null;
  const inviterName = state.kind === 'ready' ? state.inviterName : null;

  return (
    <OnbShell
      footer={
        <>
          <OnbButton
            label={familyName ? "Yes, that's my family" : 'Continue'}
            onPress={handleConfirm}
            style={styles.fullWidthButton}
            testID="onb-join-found-confirm-button"
          />
          <Pressable
            accessibilityRole="button"
            onPress={handleReenterCode}
            style={styles.reenterLink}
            testID="onb-join-found-reenter-link"
          >
            <Text style={styles.reenterText}>
              Wrong family? <Text style={styles.reenterAccent}>Re-enter code</Text>
            </Text>
          </Pressable>
        </>
      }
      testID="onb-join-found-screen"
    >
      <View style={styles.centered}>
        {inviterName ? (
          // Only the inviter's initial -- the contract deliberately doesn't
          // return a membership list, so this never fabricates other
          // "members" the server didn't actually tell us about (see WP4
          // review). No avatar at all in the degraded state below.
          <View style={styles.avatarRow}>
            <View style={[styles.avatarRing, styles.avatarFront]} testID="onb-join-found-avatar">
              <Text style={styles.avatarInitial}>{inviterName.charAt(0).toUpperCase()}</Text>
            </View>
          </View>
        ) : null}

        <OnbDisplay size={34} style={styles.centerText} testID="onb-join-found-headline">
          {familyName ? `Join ${familyName}?` : 'Join this family?'}
        </OnbDisplay>
        <OnbBody muted size={15} style={styles.centerText}>
          {inviterName
            ? `${inviterName} invited you to see and share the family's memories.`
            : "We couldn't confirm the details right now. You can continue, and we'll double check once you're signed in."}
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  centerText: {
    textAlign: 'center',
    marginTop: 12,
  },
  avatarRow: {
    flexDirection: 'row',
    marginBottom: spacing.lg,
  },
  avatarRing: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 3,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFront: {
    backgroundColor: emotionColors.tender.soft,
  },
  avatarInitial: {
    fontFamily: fonts.sansBold,
    fontSize: 22,
    color: emotionColors.tender.ink,
  },
  reenterLink: {
    alignItems: 'center',
    paddingTop: 4,
  },
  reenterText: {
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
    color: colors.ink3,
  },
  reenterAccent: {
    color: colors.primary,
  },
  fullWidthButton: {
    width: '100%',
  },
});
