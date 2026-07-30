// S0 -- Welcome / fork (docs/plans/onboarding-design-brief.md, WP1). Only
// renders for unauthenticated launches (front-door routing is WP5's job).
// Three actions converge on the same eventual OTP auth; they differ only in
// what runs before it: the story arc, the invite-code path, or nothing.
import { router } from 'expo-router';
import type { Href } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbIllustration } from '@/components/onboarding/onb-illustration';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, fonts, spacing } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingJoinCodeRoute, onboardingStoryRoute } from '@/lib/onboarding-routes';

// (auth)/login has no shared Href constant (src/lib/routes.ts is frozen,
// WP0-owned) -- literal string cast matches that file's own convention for
// routes it doesn't otherwise export.
const LOGIN_ROUTE = '/(auth)/login' as Href;

const ILLUSTRATION_HEIGHT_RATIO = 0.46;

export default function WelcomeScreen() {
  const { patch } = useOnboardingFlow();
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    patch({ step: 'welcome' });
  }, [patch]);

  return (
    <OnbShell
      footer={
        <>
          <OnbButton
            label="Start your family's journal"
            onPress={() => router.push(onboardingStoryRoute(0))}
            style={styles.fullWidthButton}
            testID="onb-welcome-start-button"
          />
          <OnbButton
            label="I have an invite"
            onPress={() => router.push(onboardingJoinCodeRoute)}
            style={styles.fullWidthButton}
            testID="onb-welcome-invite-button"
            variant="secondary"
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(LOGIN_ROUTE)}
            style={styles.loginLink}
            testID="onb-welcome-login-link"
          >
            <Text style={styles.loginLinkText}>
              I already have an account · <Text style={styles.loginLinkAccent}>Log in</Text>
            </Text>
          </Pressable>
        </>
      }
      testID="onb-welcome-screen"
    >
      <View style={[styles.illustrationWrap, { height: windowHeight * ILLUSTRATION_HEIGHT_RATIO }]}>
        <OnbIllustration slot="welcome" style={StyleSheet.absoluteFill} testID="onb-welcome-illustration" />
        <View pointerEvents="none" style={styles.wordmarkWrap}>
          <Text style={styles.wordmark}>
            Momora<Text style={styles.wordmarkDot}>.</Text>
          </Text>
        </View>
      </View>
      <View style={styles.textBlock}>
        <OnbDisplay size={33}>Save the funny little things, before your brain deletes them.</OnbDisplay>
        <OnbBody muted size={15.5} style={styles.subtitle}>
          A journal made by tired parents, for tired parents. No blank pages, no homework.
        </OnbBody>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  illustrationWrap: {
    width: '100%',
  },
  wordmarkWrap: {
    position: 'absolute',
    left: spacing.lg,
    top: 58,
  },
  wordmark: {
    fontFamily: fonts.displayMedium,
    fontSize: 24,
    letterSpacing: -0.24,
    color: colors.white,
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 10,
  },
  wordmarkDot: {
    color: colors.primarySoft,
  },
  textBlock: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: 26,
  },
  subtitle: {
    marginTop: 14,
  },
  fullWidthButton: {
    width: '100%',
  },
  loginLink: {
    alignItems: 'center',
    paddingTop: 6,
  },
  loginLinkText: {
    fontFamily: fonts.sans,
    fontSize: 13.5,
    color: colors.ink2,
  },
  loginLinkAccent: {
    fontFamily: fonts.sansBold,
    color: colors.primary,
  },
});
