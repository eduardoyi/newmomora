// S14 -- Trust screen B: what's included + the promise (docs/plans/onboarding-design-brief.md,
// WP3). Job: what unlocks + the export-is-always-yours line (spec decisions
// 4 and 13). The promise gets its own visually distinct block -- a bordered,
// slightly rotated card with a Caveat tab breaking the top border, so it
// reads as a signed promise rather than a fifth bullet point.
import { router } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbBody, OnbDisplay, OnbScript, OnbTitle } from '@/components/onboarding/onb-typography';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, radius } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { onboardingPaywallRoute } from '@/lib/onboarding-routes';

const PROMISE_TITLE = 'Your memories are always yours.';
const PROMISE_BODY = "Export everything, free, whenever you want, even if you cancel someday. We've been burned by those apps too.";
const PROMISE_SIGNATURE = 'Eduardo & Adriana';

export default function IncludedScreen() {
  const { patch } = useOnboardingFlow();

  useEffect(() => {
    patch({ step: 'included' });
  }, [patch]);

  // Draft-first, real-server-data-once-cleared: S12B's code.tsx clears the
  // draft before routing into this screen (see
  // src/hooks/use-onboarding-kid-possessive.ts for the full story -- WP6
  // fixed the identical bug on S16's target-member resolution).
  const resolvedPossessive = useOnboardingKidPossessive();

  const items = useMemo(
    () => [
      'Unlimited memories: talk, type, photos, video',
      `${resolvedPossessive} illustrated portrait and storybook pages`,
      'The whole family can join, grandparents included, free',
      'Every memory searchable, finally out of the camera roll',
    ],
    [resolvedPossessive],
  );

  return (
    <OnbShell
      footer={
        <OnbButton
          label="Almost done"
          onPress={() => router.push(onboardingPaywallRoute)}
          style={styles.fullWidthButton}
          testID="onb-included-cta-button"
        />
      }
      testID="onb-included-screen"
    >
      <View style={styles.container}>
        <OnbDisplay size={30}>{`Everything ${resolvedPossessive} journal comes with:`}</OnbDisplay>
        <View style={styles.list}>
          {items.map((item, index) => (
            <View key={item} style={styles.listRow} testID={`onb-included-item-${index}`}>
              <View style={styles.checkBubble}>
                <Check color={colors.primary} size={13} strokeWidth={2.5} />
              </View>
              <OnbBody size={15} style={styles.listText}>
                {item}
              </OnbBody>
            </View>
          ))}
        </View>

        <View style={styles.promiseCard} testID="onb-included-promise">
          <OnbScript size={20} style={styles.promiseTab}>
            our promise
          </OnbScript>
          <OnbTitle size={18}>{PROMISE_TITLE}</OnbTitle>
          <OnbBody muted size={14} style={styles.promiseBody}>
            {PROMISE_BODY}
          </OnbBody>
          <OnbScript color={colors.ink2} size={26} style={styles.promiseSignature}>
            {PROMISE_SIGNATURE}
          </OnbScript>
        </View>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 26,
    paddingTop: 46,
  },
  list: {
    marginTop: 24,
    gap: 14,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  checkBubble: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  listText: {
    flex: 1,
    lineHeight: 22,
  },
  promiseCard: {
    marginTop: 28,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radius.xl,
    padding: 20,
    paddingTop: 22,
    paddingBottom: 16,
    transform: [{ rotate: '-0.6deg' }],
    shadowColor: colors.ink,
    shadowOpacity: 0.08,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  promiseTab: {
    position: 'absolute',
    top: -12,
    left: 18,
    backgroundColor: colors.bg,
    paddingHorizontal: 8,
    transform: [{ rotate: '-2deg' }],
  },
  promiseBody: {
    marginTop: 8,
  },
  promiseSignature: {
    marginTop: 12,
    textAlign: 'right',
  },
  fullWidthButton: {
    width: '100%',
  },
});
