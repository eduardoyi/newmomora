import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useRedeemedInviteStatus } from '@/hooks/useRedeemedInviteStatus';
import { userProfileQueryKey } from '@/hooks/useUserProfile';
import { noFamilyRoute, timelineRoute } from '@/lib/routes';
import { pickNewlyJoinedFamilyId } from '@/utils/invites';

export default function WaitingForApprovalScreen() {
  const params = useLocalSearchParams<{ familyName?: string }>();
  const { familyId, memberships, refetchMemberships, setActiveFamily } = useFamily();
  const queryClient = useQueryClient();
  const [isFinishing, setIsFinishing] = useState(false);
  const handledApprovalRef = useRef(false);
  // Always-fresh snapshot of memberships for the approved-outcome effect
  // below, without needing `memberships` in its dependency array (the ref
  // only needs to be read once, at the moment approval is handled).
  const membershipsRef = useRef(memberships);
  membershipsRef.current = memberships;

  // Poll while this screen is up; the hook stops polling on a terminal
  // outcome, and the screen unmounts (replace-navigation) once handled.
  const { outcome, isLoading } = useRedeemedInviteStatus();

  const familyName = outcome.kind !== 'unavailable' && outcome.familyName
    ? outcome.familyName
    : params.familyName || 'Your family';

  useEffect(() => {
    if (outcome.kind !== 'approved' || handledApprovalRef.current) {
      return;
    }

    handledApprovalRef.current = true;
    setIsFinishing(true);

    void (async () => {
      // resolve-family-invite already pointed active_family_id at the new
      // family server-side, but the client's cached memberships and profile
      // are both still stale. Refetch memberships FIRST -- before touching
      // active_family_id at all -- so the newly joined family is already
      // present in the list by the time active_family_id changes;
      // otherwise FamilyProvider's stale-active-family correction effect
      // (use-family.tsx) can race and flip active_family_id straight back
      // to the previous family because the new one isn't in the (still
      // stale) memberships list yet.
      const previousMemberships = membershipsRef.current;
      const refreshedMemberships = (await refetchMemberships()) ?? previousMemberships;
      const newFamilyId = pickNewlyJoinedFamilyId(previousMemberships, refreshedMemberships, familyName);

      if (newFamilyId) {
        try {
          await setActiveFamily(newFamilyId);
        } catch {
          // Best-effort -- never block navigation on the active-family
          // switch; worst case the user lands on whichever family was
          // already active and can switch manually from settings.
        }
      }

      // setActiveFamily (when it ran) already invalidates the profile query
      // as part of its own update; this covers the fallback path where no
      // newFamilyId was found but the server-side update should still be
      // picked up.
      await queryClient.invalidateQueries({ queryKey: userProfileQueryKey });
      router.replace(timelineRoute);
      Alert.alert('Welcome!', `You've joined ${familyName}.`);
    })();
  }, [outcome.kind, familyName, queryClient, refetchMemberships, setActiveFamily]);

  const handleLeave = () => {
    router.replace(familyId ? timelineRoute : noFamilyRoute);
  };

  if (isLoading || outcome.kind === 'waiting' || outcome.kind === 'approved' || isFinishing) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.content}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={styles.title} testID="waiting-title">
            Almost there
          </Text>
          <Text style={styles.body}>
            {familyName} will confirm it&apos;s you shortly. We&apos;ll bring you right in once
            they do.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (outcome.kind === 'rejected') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.content}>
          <Text style={styles.title} testID="waiting-rejected">
            Not this time
          </Text>
          <Text style={styles.body}>
            Your request to join {familyName} wasn&apos;t approved. If that seems wrong, ask them
            for a fresh invite code.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={handleLeave}
            style={styles.primaryButton}
            testID="waiting-back-button"
          >
            <Text style={styles.primaryButtonText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // Terminal: no redeemed invite on record, or the family was soft-deleted
  // while the redemption was pending.
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Text style={styles.title} testID="waiting-unavailable">
          This family journal is no longer available
        </Text>
        <Text style={styles.body}>
          The family you tried to join can&apos;t be reached anymore. You can start your own
          journal instead.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={handleLeave}
          style={styles.primaryButton}
          testID="waiting-unavailable-button"
        >
          <Text style={styles.primaryButtonText}>Continue</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 28,
    lineHeight: 32,
    color: colors.ink,
    textAlign: 'center',
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink3,
    textAlign: 'center',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: 14,
  },
  primaryButtonText: {
    fontFamily: fonts.sansBold,
    color: colors.white,
    fontSize: 16,
  },
});
