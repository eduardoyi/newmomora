// S13 -- Trust screen A: the trial timeline (docs/plans/onboarding-design-brief.md,
// WP3). Job: kill bill-shock fear before the paywall (spec decision 13). No
// prices anywhere on this screen -- that's the paywall's job (S15).
import { router } from 'expo-router';
import { Check, Clock, Send } from 'lucide-react-native';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbBody, OnbDisplay, OnbTitle } from '@/components/onboarding/onb-typography';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, emotionColors, type EmotionName } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingIncludedRoute } from '@/lib/onboarding-routes';

const HEADLINE = 'Try everything free for 7 days.';

interface TrialNode {
  key: string;
  icon: typeof Check;
  tint: EmotionName;
  title: string;
  description: string;
}

// Icons/tints match the handoff (src/screens/onboarding-trust.jsx OnbTrial)
// exactly: check/calm for "today", send/joy for the day-5 reminder, clock/
// wonder for day 7.
const TRIAL_NODES: readonly TrialNode[] = [
  {
    key: 'today',
    icon: Check,
    tint: 'calm',
    title: 'Today',
    description: 'Full access. You pay $0.00 today.',
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

export default function TrialScreen() {
  const { patch } = useOnboardingFlow();

  useEffect(() => {
    patch({ step: 'trial' });
  }, [patch]);

  return (
    <OnbShell
      footer={
        <OnbButton
          label="Sounds fair"
          onPress={() => router.push(onboardingIncludedRoute)}
          style={styles.fullWidthButton}
          testID="onb-trial-cta-button"
        />
      }
      testID="onb-trial-screen"
    >
      <View style={styles.container}>
        <OnbDisplay size={33}>{HEADLINE}</OnbDisplay>
        <View style={styles.timeline}>
          <View style={styles.timelineRule} />
          {TRIAL_NODES.map((node) => {
            const emo = emotionColors[node.tint];
            const Icon = node.icon;
            return (
              <View key={node.key} style={styles.node} testID={`onb-trial-node-${node.key}`}>
                <View style={[styles.nodeIcon, { backgroundColor: emo.soft }]}>
                  <Icon color={emo.ink} size={20} strokeWidth={2} />
                </View>
                <View style={styles.nodeText}>
                  <OnbTitle size={19}>{node.title}</OnbTitle>
                  <OnbBody muted size={14} style={styles.nodeDescription}>
                    {node.description}
                  </OnbBody>
                </View>
              </View>
            );
          })}
        </View>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 26,
    paddingTop: 50,
  },
  timeline: {
    marginTop: 34,
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
