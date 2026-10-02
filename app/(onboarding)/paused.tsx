// S15b -- Paused at the paywall. Where S15's close sheet "Leave" lands
// (2026-10-02). It used to sign the owner out, which did keep an unpaid owner
// out of the journal but cost them the whole OTP round trip (and, if they
// tapped "Start" instead of "Log in", the whole story again) just to see the
// price a second time. The session now stays: this screen is the "out", and
// the next cold launch resumes the paywall through the front door's
// paywall marker (resolvePostAuthDestination). Still never the journal.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay, OnbScript } from '@/components/onboarding/onb-typography';
import { colors, fonts } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { onboardingPaywallRouteForMode, onboardingWelcomeRoute } from '@/lib/onboarding-routes';
import { capitalizeFragment, journalPossessive } from '@/utils/onboarding-copy';

export default function PausedScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const paywallMode = mode === 'resubscribe' ? 'resubscribe' : 'new-owner';
  const resolvedPossessive = useOnboardingKidPossessive();
  const { signOut } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const journalOwner = capitalizeFragment(journalPossessive(resolvedPossessive));

  const handleSeePlans = () => {
    router.replace(onboardingPaywallRouteForMode(paywallMode));
  };

  const handleLogOut = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setErrorMessage('');
    try {
      // The paywall marker stays in device storage, so signing back in
      // resumes the purchase step (same as the old Leave behavior).
      await signOut();
      router.replace(onboardingWelcomeRoute);
    } catch {
      setIsLoggingOut(false);
      setErrorMessage('Could not log you out. Please try again.');
    }
  };

  return (
    <OnbShell
      footer={
        <View>
          <OnbButton
            disabled={isLoggingOut}
            label="See plans"
            onPress={handleSeePlans}
            style={styles.fullWidthButton}
            testID="onb-paused-see-plans-button"
          />
          <Pressable
            accessibilityRole="button"
            disabled={isLoggingOut}
            onPress={() => void handleLogOut()}
            style={styles.logOutLink}
            testID="onb-paused-log-out-link"
          >
            <Text style={styles.logOutText}>Log out</Text>
          </Pressable>
          {errorMessage ? (
            <OnbBody size={13} style={styles.errorText} testID="onb-paused-error">
              {errorMessage}
            </OnbBody>
          ) : null}
        </View>
      }
      testID="onb-paused-screen"
    >
      <View style={styles.container}>
        <View style={styles.nestWrap}>
          <OnbIllustration slot="family-nest" style={styles.nestImage} testID="onb-paused-illustration" />
        </View>
        <OnbScript color={colors.primary} size={24} style={styles.accent}>
          no rush
        </OnbScript>
        <OnbDisplay size={32}>{`${journalOwner} journal will be right here.`}</OnbDisplay>
        <OnbBody muted size={15.5} style={styles.body}>
          Come back whenever you&rsquo;re ready. Next time you open Momora, you&rsquo;ll pick up right where you left off.
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  nestWrap: {
    width: 92,
    height: 92,
    marginBottom: 20,
    transform: [{ rotate: '-3deg' }],
  },
  nestImage: {
    width: '100%',
    height: '100%',
  },
  accent: {
    marginBottom: 12,
    transform: [{ rotate: '-2deg' }],
  },
  body: {
    marginTop: 16,
  },
  fullWidthButton: {
    width: '100%',
  },
  logOutLink: {
    alignItems: 'center',
    paddingTop: 12,
  },
  logOutText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
  },
  errorText: {
    color: colors.error,
    marginTop: 10,
    textAlign: 'center',
  },
});
