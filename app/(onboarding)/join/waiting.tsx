// J5 -- Approval wait state (docs/plans/onboarding-design-brief.md, WP4).
// Reuses app/(app)/sharing/waiting.tsx's approved/rejected/unavailable state
// machine and its refetch-before-active-family race fix rather than
// reimplementing either -- only the copy/illustration and one extra guard
// differ (below). Read that file's comments before changing this one.
//
// Routing note (src/lib/onboarding-routing.ts): resolvePostAuthDestination
// returns `finish-join` for "no family + a stored invite code" without being
// able to tell "never redeemed yet" apart from "redeemed, awaiting
// approval". This screen is where that gets resolved: J4 always clears the
// stored invite code the moment its own redeem call settles (success or a
// definitive failure), so if a code is STILL stored here and the
// redeemed-invite poll comes back with nothing on record, this device
// genuinely never finished redeeming -- bounce to J2 to do that, rather
// than showing the "no longer available" terminal state.
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, fonts, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useRedeemedInviteStatus } from '@/hooks/useRedeemedInviteStatus';
import { userProfileQueryKey } from '@/hooks/useUserProfile';
import { onboardingJoinFoundRoute } from '@/lib/onboarding-routes';
import { noFamilyRoute, timelineRoute } from '@/lib/routes';
import { getJoinDraft } from '@/services/onboarding-join';
import { pickNewlyJoinedFamilyId } from '@/utils/invites';
import { getPendingInviteCode } from '@/utils/pending-invite-code';

export default function JoinWaitingScreen() {
  const { familyId, memberships, refetchMemberships, setActiveFamily } = useFamily();
  const queryClient = useQueryClient();
  const [isFinishing, setIsFinishing] = useState(false);
  const [inviterName, setInviterName] = useState<string | null>(null);
  const [pendingCodeCheck, setPendingCodeCheck] = useState<'checking' | 'has-code' | 'no-code'>(
    'checking',
  );
  const handledApprovalRef = useRef(false);
  // Always-fresh snapshot of memberships for the approved-outcome effect
  // below, without needing `memberships` in its dependency array.
  const membershipsRef = useRef(memberships);
  membershipsRef.current = memberships;

  // Poll while this screen is up; the hook stops polling on a terminal
  // outcome, and the screen unmounts (replace-navigation) once handled.
  const { outcome, isLoading } = useRedeemedInviteStatus();

  useEffect(() => {
    void getJoinDraft().then((draft) => setInviterName(draft.inviterName ?? null));
    void getPendingInviteCode().then((code) => setPendingCodeCheck(code ? 'has-code' : 'no-code'));
  }, []);

  useEffect(() => {
    if (isLoading || pendingCodeCheck !== 'has-code' || outcome.kind !== 'unavailable') {
      return;
    }

    router.replace(onboardingJoinFoundRoute);
  }, [isLoading, pendingCodeCheck, outcome.kind]);

  useEffect(() => {
    if (outcome.kind !== 'approved' || handledApprovalRef.current) {
      return;
    }

    handledApprovalRef.current = true;
    setIsFinishing(true);

    void (async () => {
      // Same race app/(app)/sharing/waiting.tsx guards against: refetch
      // memberships FIRST -- before touching active_family_id at all -- so
      // the newly joined family is already present in the list by the time
      // active_family_id changes; otherwise FamilyProvider's
      // stale-active-family correction effect (use-family.tsx) can race and
      // flip active_family_id straight back to the previous family.
      const previousMemberships = membershipsRef.current;
      const refreshedMemberships = (await refetchMemberships()) ?? previousMemberships;
      const newFamilyId = pickNewlyJoinedFamilyId(
        previousMemberships,
        refreshedMemberships,
        outcome.familyName,
      );

      if (newFamilyId) {
        try {
          await setActiveFamily(newFamilyId);
        } catch {
          // Best-effort -- never block landing in the journal on this.
        }
      }

      await queryClient.invalidateQueries({ queryKey: userProfileQueryKey });
      router.replace(timelineRoute);
      Alert.alert('Welcome!', `You've joined ${outcome.familyName ?? 'the family'}.`);
    })();
  }, [outcome, queryClient, refetchMemberships, setActiveFamily]);

  const handleBack = () => {
    router.replace(familyId ? timelineRoute : noFamilyRoute);
  };

  const isWaiting =
    isLoading ||
    pendingCodeCheck === 'checking' ||
    outcome.kind === 'waiting' ||
    outcome.kind === 'approved' ||
    isFinishing;

  if (isWaiting) {
    return (
      <OnbShell
        footer={
          // TODO(nudge): no re-notify endpoint exists yet, so this cannot be
          // a real tappable action -- a link-styled dead tap target reads as
          // broken on a screen the brief says "may sit for hours" (WP4
          // review). Plain reassurance text instead; wire it back to a
          // Pressable once a real re-notify endpoint exists.
          <Text style={styles.nudgeText} testID="onb-join-waiting-nudge-reassurance">
            No need to check back. We&apos;ll let you know the moment you&apos;re in.
          </Text>
        }
        testID="onb-join-waiting-screen"
      >
        <View style={styles.centered}>
          <View style={styles.illustrationWrap}>
            <OnbIllustration
              slot="join-door"
              style={styles.illustration}
              testID="onb-join-waiting-illustration"
            />
          </View>
          <OnbDisplay size={30} style={styles.centerText} testID="onb-join-waiting-title">
            {inviterName
              ? `One sec. ${inviterName} just needs to wave you in.`
              : 'One sec. They just need to wave you in.'}
          </OnbDisplay>
          <OnbBody muted size={15} style={styles.centerText}>
            We told them you&apos;re here. You&apos;ll get a ping the moment you&apos;re in.
          </OnbBody>
        </View>
      </OnbShell>
    );
  }

  if (outcome.kind === 'rejected') {
    return (
      <OnbShell
        footer={
          <OnbButton
            label="Back"
            onPress={handleBack}
            style={styles.fullWidthButton}
            testID="onb-join-waiting-rejected-button"
          />
        }
        testID="onb-join-waiting-screen"
      >
        <View style={styles.centered}>
          <OnbDisplay size={28} style={styles.centerText} testID="onb-join-waiting-rejected">
            Not this time
          </OnbDisplay>
          <OnbBody muted style={styles.centerText}>
            Your request to join {outcome.familyName ?? 'this family'} wasn&apos;t approved. If
            that seems wrong, ask them for a fresh invite code.
          </OnbBody>
        </View>
      </OnbShell>
    );
  }

  // Terminal: no redeemed invite on record (and no pending code either, so
  // the guard above didn't apply), or the family was soft-deleted while the
  // redemption was pending.
  return (
    <OnbShell
      footer={
        <OnbButton
          label="Continue"
          onPress={handleBack}
          style={styles.fullWidthButton}
          testID="onb-join-waiting-unavailable-button"
        />
      }
      testID="onb-join-waiting-screen"
    >
      <View style={styles.centered}>
        <OnbDisplay size={28} style={styles.centerText} testID="onb-join-waiting-unavailable">
          This family journal is no longer available
        </OnbDisplay>
        <OnbBody muted style={styles.centerText}>
          The family you tried to join can&apos;t be reached anymore. You can start your own
          journal instead.
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
  illustrationWrap: {
    width: 170,
    height: 190,
    marginBottom: spacing.lg,
  },
  illustration: {
    width: '100%',
    height: '100%',
  },
  nudgeText: {
    fontFamily: fonts.sans,
    fontSize: 13.5,
    color: colors.ink3,
    textAlign: 'center',
  },
  fullWidthButton: {
    width: '100%',
  },
});
