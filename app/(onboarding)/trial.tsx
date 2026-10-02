// S13 -- Trust screen A: the trial timeline (docs/plans/onboarding-design-brief.md,
// WP3). Job: kill bill-shock fear before the paywall (spec decision 13). No
// prices anywhere on this screen -- that's the paywall's job (S15).
//
// Order (2026-10-02): S14 ("what's included") now comes BEFORE this screen,
// so this is the last beat before the price: S12B -> S14 -> S13 -> S15. An
// owner who can't get the store trial skips straight from here to S15.
// Same date also gave the screen more than a bare timeline: a "you're here"
// Today node personalized on the kid, and a closing no-risk note.
import { router } from 'expo-router';
import { Check, Clock, Send } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbBody, OnbDisplay, OnbScript, OnbTitle } from '@/components/onboarding/onb-typography';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { BillingStatusGate } from '@/components/billing-status-gate';
import { colors, emotionColors, fonts, radius, type EmotionName } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { onboardingPaywallRouteForMode } from '@/lib/onboarding-routes';
import { resolveOwnerPaywallMode } from '@/lib/onboarding-routing';
import { timelineRoute } from '@/lib/routes';

const ACCENT = 'how the free week works';
const HEADLINE = 'Try everything free for 7 days.';
const SUBHEAD = 'Nothing to pay today, and a heads-up before anything changes.';
const NO_RISK_NOTE = "Not for you? Cancel before day 7 and you pay nothing. Everything you saved stays yours to export, either way.";

interface TrialNode {
  key: string;
  icon: typeof Check;
  tint: EmotionName;
  title: string;
  description: string;
  /** The current step: filled primary node + "You're here" tag. */
  isCurrent?: boolean;
}

/** "Lila's portrait" / "their portraits" -- one kid is named, several are not singled out. */
function portraitPhrase(resolvedPossessive: string): string {
  return resolvedPossessive === 'their' ? 'their portraits' : `${resolvedPossessive} portrait`;
}

// Icons/tints match the handoff (src/screens/onboarding-trust.jsx OnbTrial)
// exactly: check/calm for "today", send/joy for the day-5 reminder, clock/
// wonder for day 7.
function buildTrialNodes(resolvedPossessive: string): readonly TrialNode[] {
  return [
  {
    key: 'today',
    icon: Check,
    tint: 'calm',
    title: 'Today',
    description: `Full access, $0.00 today. We start with ${portraitPhrase(resolvedPossessive)}, right after this.`,
    isCurrent: true,
  },
  {
    key: 'day-5',
    icon: Send,
    tint: 'joy',
    title: 'Day 5',
    description: 'We remind you the trial is ending. Email and notification. No surprises.',
  },
  {
    key: 'day-7',
    icon: Clock,
    tint: 'wonder',
    title: 'Day 7',
    description: 'Only then does the subscription start. Cancelling takes about 10 seconds, we timed it.',
  },
  ];
}

export default function TrialScreen() {
  const { patch } = useOnboardingFlow();
  const resolvedPossessive = useOnboardingKidPossessive();
  const trialNodes = useMemo(() => buildTrialNodes(resolvedPossessive), [resolvedPossessive]);
  const { user } = useAuth();
  const { familyId, isLoading: isFamilyLoading, role } = useFamily();
  const {
    offerings,
    status,
    billingStatusError,
    isLoading: isBillingLoading,
    refresh,
  } = useBilling();

  const billingDecision = useMemo<'loading' | 'eligible' | 'paywall' | 'access' | 'error'>(() => {
    if (isFamilyLoading || isBillingLoading) {
      return 'loading';
    }
    if (
      billingStatusError ||
      !user ||
      !familyId ||
      role !== 'owner' ||
      !status ||
      status.family_id !== familyId ||
      status.owner_user_id !== user.id
    ) {
      return 'error';
    }
    if (status.has_write_access) {
      return 'access';
    }
    const mode = resolveOwnerPaywallMode({
      hasEverHadAccess: status.has_ever_had_access,
      trialEligible: status.trial_eligible,
    });
    return mode === 'new-owner' && offerings?.annualTrialEligibility === 'eligible' ? 'eligible' : 'paywall';
  }, [billingStatusError, familyId, isBillingLoading, isFamilyLoading, offerings, role, status, user]);

  const paywallMode = useMemo(
    () =>
      status
        ? resolveOwnerPaywallMode({
            hasEverHadAccess: status.has_ever_had_access,
            trialEligible: status.trial_eligible,
          })
        : 'new-owner',
    [status],
  );

  useEffect(() => {
    patch({ step: 'trial' });
  }, [patch]);

  useEffect(() => {
    if (billingDecision === 'paywall') {
      // No free week to explain: S14 already ran before this screen, so go
      // straight to the price (the no-trial or resubscribe variant).
      router.replace(onboardingPaywallRouteForMode(paywallMode));
    } else if (billingDecision === 'access') {
      router.replace(timelineRoute);
    }
  }, [billingDecision, paywallMode]);

  if (billingDecision === 'loading' || billingDecision === 'paywall' || billingDecision === 'access') {
    return (
      <View style={styles.loading} testID="onb-trial-billing-loading">
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (billingDecision === 'error') {
    return <BillingStatusGate onRetry={refresh} />;
  }

  return (
    <OnbShell
      footer={
        <OnbButton
          label="Sounds fair"
          onPress={() => router.push(onboardingPaywallRouteForMode(paywallMode))}
          style={styles.fullWidthButton}
          testID="onb-trial-cta-button"
        />
      }
      testID="onb-trial-screen"
    >
      <View style={styles.container}>
        <OnbScript size={22} style={styles.accent}>
          {ACCENT}
        </OnbScript>
        <OnbDisplay size={33}>{HEADLINE}</OnbDisplay>
        <OnbBody muted size={15} style={styles.subhead}>
          {SUBHEAD}
        </OnbBody>
        <View style={styles.timeline}>
          <View style={styles.timelineRule} />
          {trialNodes.map((node) => {
            const emo = emotionColors[node.tint];
            const Icon = node.icon;
            return (
              <View key={node.key} style={styles.node} testID={`onb-trial-node-${node.key}`}>
                <View
                  style={[
                    styles.nodeIcon,
                    node.isCurrent ? styles.nodeIconCurrent : { backgroundColor: emo.soft },
                  ]}
                >
                  <Icon color={node.isCurrent ? colors.white : emo.ink} size={20} strokeWidth={node.isCurrent ? 2.5 : 2} />
                </View>
                <View style={styles.nodeText}>
                  <View style={styles.nodeTitleRow}>
                    <OnbTitle size={19}>{node.title}</OnbTitle>
                    {node.isCurrent ? (
                      <View style={styles.hereTag} testID="onb-trial-here-tag">
                        <OnbBody size={11.5} style={styles.hereTagText}>
                          You&rsquo;re here
                        </OnbBody>
                      </View>
                    ) : null}
                  </View>
                  <OnbBody muted size={14} style={styles.nodeDescription}>
                    {node.description}
                  </OnbBody>
                </View>
              </View>
            );
          })}
        </View>
        <View style={styles.noRiskCard} testID="onb-trial-no-risk">
          <OnbBody size={13.5} style={styles.noRiskText}>
            {NO_RISK_NOTE}
          </OnbBody>
        </View>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
  container: {
    paddingHorizontal: 26,
    paddingTop: 40,
  },
  accent: {
    marginBottom: 10,
    transform: [{ rotate: '-2deg' }],
  },
  subhead: {
    marginTop: 12,
  },
  timeline: {
    marginTop: 30,
    position: 'relative',
    gap: 30,
  },
  timelineRule: {
    position: 'absolute',
    left: 23,
    top: 24,
    bottom: 24,
    width: 2,
    backgroundColor: colors.border,
  },
  nodeIconCurrent: {
    backgroundColor: colors.primary,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  nodeTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  hereTag: {
    backgroundColor: colors.primaryTint,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  hereTagText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
  },
  noRiskCard: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginTop: 30,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  noRiskText: {
    color: colors.ink2,
    lineHeight: 20,
  },
  node: {
    flexDirection: 'row',
    gap: 16,
  },
  nodeIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeText: {
    flex: 1,
    paddingTop: 3,
  },
  nodeDescription: {
    marginTop: 4,
  },
  fullWidthButton: {
    width: '100%',
  },
});
