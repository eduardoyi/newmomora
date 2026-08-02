// S11 -- Notification question, an embedded permission (docs/plans/
// onboarding-design-brief.md S11, docs/plans/onboarding-implementation.md
// WP2). The first three option cards write `notificationChoice` and
// immediately fire the real OS permission prompt via
// `useNotificationsRegistration().requestRegistration()`, which now reads
// as confirming the choice rather than a cold ask; the fourth skips the
// prompt entirely -- no penalty, no re-ask this session.
//
// Copy is the handoff's verbatim OnbNotify options (src/screens/
// onboarding-capture.jsx in the extracted design bundle), not the design
// brief's -- the brief (dated 2026-07-23) describes "Weekend mornings" and
// "Random. Surprise me now and then", but the frozen `OnboardingNotificationChoice`
// ids ('eve' | 'late' | 'morn' | 'none') and their times (20:00/22:00/08:00,
// applied by commitOnboarding) were specified against the handoff's actual
// four options, which are a daily reminder distinguished only by time of
// day. Using the brief's copy over those ids would promise something untrue
// (a "weekend-only" or "random" reminder that is actually a fixed daily
// time) -- the later, owner-approved handoff wins. The meta time chip on
// the first three options is what makes the promise honest: the user sees
// the exact time they're agreeing to.
import { router } from 'expo-router';
import { Moon, Sun, X } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { colors, emotionColors, fonts, radius, type EmotionName } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useNotificationsRegistration } from '@/hooks/useNotifications';
import { onboardingEmailRoute } from '@/lib/onboarding-routes';
import { trackEvent } from '@/services/analytics';
import type { OnboardingNotificationChoice } from '@/utils/onboarding-progress';

interface NotificationOption {
  id: OnboardingNotificationChoice;
  label: string;
  /** Right-aligned time chip -- absent for 'none' (no reminder to promise a time for). */
  meta?: string;
  tint: EmotionName;
  Icon: typeof Moon;
}

const OPTIONS: NotificationOption[] = [
  { id: 'eve', label: "Evenings, once they're finally asleep", meta: '8:00 pm', tint: 'wonder', Icon: Moon },
  { id: 'late', label: 'Later, when the dishes are done', meta: '10:00 pm', tint: 'mischief', Icon: Moon },
  { id: 'morn', label: 'Mornings, coffee in hand', meta: '8:00 am', tint: 'joy', Icon: Sun },
  { id: 'none', label: "No reminders. I'll show up on my own", tint: 'calm', Icon: X },
];

export default function OnboardingNotificationsScreen() {
  const { patch } = useOnboardingFlow();
  const { requestRegistration } = useNotificationsRegistration(false);
  const [selected, setSelected] = useState<OnboardingNotificationChoice | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSelect = async (option: NotificationOption) => {
    if (isSubmitting) {
      return;
    }

    setSelected(option.id);
    setIsSubmitting(true);
    patch({ notificationChoice: option.id, step: 'email' });

    // os_granted is null-safe for 'none' (no registration attempt to report
    // an OS outcome for) and for a device where notifications aren't
    // available at all (requestRegistration resolves null).
    let osGranted: boolean | null = null;
    if (option.id !== 'none') {
      const result = await requestRegistration();
      osGranted = result?.granted ?? null;
    }
    trackEvent('notification_choice', { choice: option.id, os_granted: osGranted });

    router.push(onboardingEmailRoute);
  };

  return (
    <OnbShell>
      <View style={styles.header}>
        <OnbDisplay size={31}>When do the little moments usually hit you?</OnbDisplay>
      </View>

      <View style={styles.options}>
        {OPTIONS.map((option) => {
          const emo = emotionColors[option.tint];
          const isOn = selected === option.id;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: isOn, disabled: isSubmitting }}
              disabled={isSubmitting}
              key={option.id}
              onPress={() => void handleSelect(option)}
              style={[styles.optionCard, isOn ? styles.optionCardSelected : styles.optionCardDefault]}
              testID={`onboarding-notifications-option-${option.id}`}
            >
              <View style={[styles.glyphTile, { backgroundColor: emo.soft }]}>
                <option.Icon color={emo.ink} size={19} strokeWidth={1.75} />
              </View>
              <OnbBody size={15} style={styles.optionLabel}>{option.label}</OnbBody>
              {option.meta ? (
                <Text style={[styles.optionMeta, isOn && styles.optionMetaSelected]}>{option.meta}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <OnbBody muted size={12.5} style={styles.reassurance}>
        Gentle nudges only. Never a notification that starts with &ldquo;Don&rsquo;t forget&hellip;&rdquo;
      </OnbBody>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  options: {
    gap: 10,
    paddingHorizontal: 24,
    paddingTop: 28,
  },
  optionCard: {
    alignItems: 'center',
    borderRadius: radius.lg,
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  optionCardDefault: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1.5,
  },
  optionCardSelected: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primary,
    borderWidth: 1.5,
  },
  glyphTile: {
    alignItems: 'center',
    borderRadius: radius.md,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  optionLabel: {
    flex: 1,
    fontFamily: fonts.sansMedium,
    lineHeight: 15 * 1.35,
  },
  optionMeta: {
    color: colors.ink3,
    flexShrink: 0,
    fontFamily: fonts.sansBold,
    fontSize: 12.5,
  },
  optionMetaSelected: {
    color: colors.primary,
  },
  reassurance: {
    paddingHorizontal: 24,
    paddingTop: 18,
  },
});
