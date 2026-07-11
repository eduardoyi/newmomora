import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { sharingRedeemRoute, signupRoute } from '@/lib/routes';
import { isValidInviteCodeShape, normalizeInviteCode } from '@/utils/invites';
import { setPendingInviteCode } from '@/utils/pending-invite-code';

/**
 * Universal-link entry point: https://usemomora.com/invite?code=sunny-tiger-lake
 * (docs/plans/family-sharing.md §9). Lives OUTSIDE the (auth)/(app) groups so
 * it resolves for signed-in and signed-out users alike. Stores the code in
 * AsyncStorage (`momora.pendingInviteCode`) and routes: with a session ->
 * the redeem screen (prefilled from storage); without -> signup, whose OTP
 * verification then forwards to redeem while the code survives in storage.
 * The code is only consumed by a redemption attempt, never by navigation.
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

      router.replace(session ? sharingRedeemRoute : signupRoute);
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
