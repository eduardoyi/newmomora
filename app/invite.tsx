import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { onboardingJoinFoundRoute } from '@/lib/onboarding-routes';
import { sharingRedeemRoute } from '@/lib/routes';
import { isValidInviteCodeShape, normalizeInviteCode } from '@/utils/invites';
import { setPendingInviteCode } from '@/utils/pending-invite-code';

/**
 * Universal-link entry point: https://usemomora.com/invite?code=sunny-tiger-lake
 * (docs/plans/family-sharing.md §9). Lives OUTSIDE the (auth)/(app)/(onboarding)
 * groups so it resolves for signed-in and signed-out users alike. Stores the
 * code in AsyncStorage (`momora.pendingInviteCode`) and routes: with a
 * permanent session -> the redeem screen (prefilled from storage -- an
 * already-authenticated deep link is the "adding a second family" case, not
 * onboarding); without a permanent session, including an anonymous session,
 * -> J2
 * (docs/plans/onboarding-implementation.md WP5, spec decision 2: the
 * unauthenticated invited path is now J1-J5, not the old signup screen). J2
 * reads the same stored code (getPendingInviteCode) and handles a
 * missing/invalid one gracefully on its own. The code is only consumed by a
 * redemption attempt, never by navigation.
 */
export default function InviteLinkScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const { session, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) {
      return;
    }

    let isMounted = true;

    void (async () => {
      const normalized = normalizeInviteCode(typeof code === 'string' ? code : '');

      if (isValidInviteCodeShape(normalized)) {
        await setPendingInviteCode(normalized);
      }

      if (!isMounted) {
        return;
      }

      const hasPermanentSession = Boolean(session && !session.user.is_anonymous);
      router.replace(hasPermanentSession ? sharingRedeemRoute : onboardingJoinFoundRoute);
    })();

    return () => {
      isMounted = false;
    };
  }, [code, session, isLoading]);

  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.primary} size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
});
