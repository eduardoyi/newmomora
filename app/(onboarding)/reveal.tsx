// S17 -- Portrait reveal + sibling chain (docs/plans/onboarding-design-brief.md
// S17, docs/plans/onboarding-implementation.md WP6). Fires when S16
// (portrait.tsx) detects the target member's real portrait status flip to
// `ready` and hands off here via `onboardingRevealRoute(memberId)`.
//
// Full-screen reveal of the REAL finished portrait -- not an
// `OnbIllustration` placeholder -- loaded the same way
// `src/components/memory-card.tsx`'s `IllustrationVisual` and
// `src/components/portrait-timeline.tsx` do (`useMediaUrl` + `expo-image`).
//
// Animation: same restraint as S10 (aha.tsx) -- the portrait settles in,
// then one heart pop, reusing memory-engagement-bar.tsx's real animation
// composition exactly as aha.tsx does (a previous round corrected a bezier
// approximation to that real composition; this screen starts from the
// corrected version, not the approximation). Respects
// `AccessibilityInfo.isReduceMotionEnabled()`.
//
// Sibling chain: if another kid has never had a photo picked, the primary
// CTA re-enters S16 for them (`onboardingPortraitRouteForMember`); otherwise
// the single CTA goes to the journal. "Later" is an explicit owner decision
// (not the design brief's `CastWaitingState` cast card, deliberately not
// built -- see docs/features/onboarding.md): it goes straight to the family
// roster tab, which already invites the user to add a photo for any
// unpainted kid ("Edit their photo to redraw it").
//
// Birthday ask (2026-10-02): onboarding creates kids name-only (spec decision
// 8, to keep the pre-paywall path light), but birthday films, age-aware
// captions and milestone age bands all need a date of birth. This is the
// first post-paywall moment that's about one specific kid, so it asks here
// -- optional, saved the moment a date is picked, and only for a kid who
// doesn't have one yet. Skipping it costs nothing: the Family tab already
// flags a kid with no birthday as incomplete.
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { Heart } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { DatePickerField } from '@/components/date-picker-field';
import { OnbBody, OnbDisplay } from '@/components/onboarding/onb-typography';
import { colors, fonts, radius } from '@/constants/theme';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { onboardingPortraitRouteForMember } from '@/lib/onboarding-routes';
import { familyRosterRoute, timelineRoute } from '@/lib/routes';
import { hasNoPortraitYet } from '@/utils/family-members';
import { mediaImageSource } from '@/utils/media-image-source';
import { possessive } from '@/utils/onboarding-copy';

const BIRTHDAY_SAVE_ERROR = "Couldn't save that. Try again?";

function defaultBirthdayPickerDate(): Date {
  // Same starting point as the Add person form's date of birth field.
  const date = new Date();
  date.setFullYear(date.getFullYear() - 3);
  return date;
}

interface RevealBirthdayAskProps {
  memberId: string;
  name: string;
  updateMember: ReturnType<typeof useFamilyMembers>['updateMember'];
}

function RevealBirthdayAsk({ memberId, name, updateMember }: RevealBirthdayAskProps) {
  const [birthday, setBirthday] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [today] = useState(() => new Date());
  const [defaultPickerDate] = useState(defaultBirthdayPickerDate);

  const save = async (isoDate: string) => {
    setBirthday(isoDate);
    setStatus('saving');
    try {
      await updateMember({ memberId, dateOfBirth: isoDate });
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  return (
    <View style={styles.birthday} testID="onb-reveal-birthday">
      <Text style={styles.birthdayTitle}>{`When's ${possessive(name)} birthday?`}</Text>
      <OnbBody muted size={13}>{`${name} gets a little film every birthday.`}</OnbBody>
      <DatePickerField
        defaultPickerDate={defaultPickerDate}
        maximumDate={today}
        onChange={(isoDate) => void save(isoDate)}
        renderTrigger={({ displayValue, openPicker }) => (
          <Pressable
            accessibilityLabel={displayValue ? `Birthday, ${displayValue}. Change it` : 'Add birthday'}
            accessibilityRole="button"
            disabled={status === 'saving'}
            onPress={openPicker}
            style={styles.birthdayButton}
            testID="onb-reveal-birthday-button"
          >
            <Text style={styles.birthdayButtonText}>{displayValue ?? 'Add birthday'}</Text>
          </Pressable>
        )}
        testID="onb-reveal-birthday-picker"
        value={birthday}
      />
      {status === 'saving' ? (
        <ActivityIndicator color={colors.ink3} size="small" style={styles.birthdayStatus} testID="onb-reveal-birthday-saving" />
      ) : null}
      {status === 'saved' ? (
        <Text style={styles.birthdayStatusText} testID="onb-reveal-birthday-saved">Saved</Text>
      ) : null}
      {status === 'error' ? (
        <Text style={[styles.birthdayStatusText, styles.birthdayErrorText]} testID="onb-reveal-birthday-error">
          {BIRTHDAY_SAVE_ERROR}
        </Text>
      ) : null}
    </View>
  );
}

interface LoadedPortraitImageProps {
  name: string;
  portraitKey: string | null;
  portraitUrl: string;
}

/**
 * Keyed by its signed URL at the call site so each replacement starts in the
 * loading state. Keeping this local avoids a reset-effect on the screen and
 * gives Maestro a selector only after Expo Image has decoded the current
 * portrait.
 */
function LoadedPortraitImage({ name, portraitKey, portraitUrl }: LoadedPortraitImageProps) {
  const [hasLoaded, setHasLoaded] = useState(false);

  return (
    <Image
      accessibilityLabel={`${name}'s finished portrait`}
      contentFit="cover"
      onLoad={() => setHasLoaded(true)}
      source={mediaImageSource(portraitUrl, portraitKey)}
      style={styles.cardImage}
      testID={
        hasLoaded
          ? 'onb-reveal-portrait-image-loaded'
          : 'onb-reveal-portrait-image-loading'
      }
    />
  );
}

export default function OnboardingRevealScreen() {
  const { memberId } = useLocalSearchParams<{ memberId?: string }>();
  const { members, isLoading, updateMember } = useFamilyMembers();

  const member = useMemo(
    () => members.find((candidate) => candidate.id === memberId),
    [members, memberId],
  );
  // Same "unpainted" definition S16 falls back to (src/utils/family-members.ts),
  // in the same tag-count-then-created-at order fetchFamilyMembers returns.
  const nextMember = useMemo(
    () => members.find((candidate) => candidate.id !== memberId && hasNoPortraitYet(candidate)),
    [members, memberId],
  );

  // Latched the first time this kid resolves without a birthday, so the ask
  // stays on screen (showing "Saved") after the save refetches the member
  // with a date of birth. A kid who already had one never sees it.
  const [birthdayAskMemberId, setBirthdayAskMemberId] = useState<string | null>(null);
  if (member && !member.date_of_birth && birthdayAskMemberId !== member.id) {
    setBirthdayAskMemberId(member.id);
  }

  const portraitKey = member?.resolvedPortraitVersion?.illustrated_profile_key ?? null;
  const portraitCacheVersion = member?.avatarUpdatedAt ?? member?.updated_at;
  const { url: portraitUrl } = useMediaUrl(portraitKey, portraitCacheVersion);

  // Defensive escape: a stray deep link or stale nav-stack entry with no/
  // unresolved memberId has nothing to reveal. Never trap the user on a
  // broken screen -- fall back to the journal, same spirit as every other
  // sub-state in this flow.
  useEffect(() => {
    if (!isLoading && (!memberId || !member)) {
      router.replace(timelineRoute);
    }
  }, [isLoading, memberId, member]);

  const [settleAnim] = useState(() => new Animated.Value(0));
  // Mirrors aha.tsx's own local state shape exactly: a scale value that
  // starts at rest (1, not 0) and a previous-value ref gating the pop to
  // the false->true transition.
  const [liked, setLiked] = useState(false);
  const [heartScale] = useState(() => new Animated.Value(1));
  const previousLikedRef = useRef(false);
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false);

  useEffect(() => {
    let isMounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (isMounted) {
        setReduceMotionEnabled(enabled);
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    Animated.timing(settleAnim, {
      toValue: 1,
      duration: reduceMotionEnabled ? 0 : 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    // No "one beat of delight" wait under reduce motion -- the heart just
    // shows filled immediately, no pop. Routed through the same timer (0ms)
    // rather than a synchronous setState in the effect body.
    const timer = setTimeout(() => setLiked(true), reduceMotionEnabled ? 0 : 1200);
    return () => clearTimeout(timer);
  }, [reduceMotionEnabled, settleAnim]);

  // Same effect as memory-engagement-bar.tsx's handleLike pop, exactly as
  // aha.tsx reuses it: scale up to 1.32 over 120ms, then spring back to 1
  // (friction 4, tension 180) -- fired only on the false->true transition.
  useEffect(() => {
    if (liked && !previousLikedRef.current) {
      heartScale.setValue(1);
      if (!reduceMotionEnabled) {
        Animated.sequence([
          Animated.timing(heartScale, { toValue: 1.32, duration: 120, useNativeDriver: true }),
          Animated.spring(heartScale, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
        ]).start();
      }
    }
    previousLikedRef.current = liked;
  }, [liked, heartScale, reduceMotionEnabled]);

  const cardStyle = {
    opacity: settleAnim,
    transform: [
      { translateY: settleAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
    ],
  };

  const handleNextSibling = () => {
    if (!nextMember) {
      return;
    }
    router.replace(onboardingPortraitRouteForMember(nextMember.id));
  };

  const handleLater = () => router.replace(familyRosterRoute);
  const handleDone = () => router.replace(timelineRoute);

  if (isLoading || !member) {
    return (
      <OnbShell testID="onb-reveal-screen">
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} size="large" testID="onb-reveal-loading" />
        </View>
      </OnbShell>
    );
  }

  const name = member.name;

  return (
    <OnbShell
      footer={
        nextMember ? (
          <>
            <OnbButton
              label={`${nextMember.name}'s turn. Pick a photo`}
              onPress={handleNextSibling}
              style={styles.fullWidthButton}
              testID="onb-reveal-next-sibling-button"
            />
            <Pressable
              accessibilityRole="button"
              onPress={handleLater}
              style={styles.laterLink}
              testID="onb-reveal-later-link"
            >
              <Text style={styles.laterText}>Later</Text>
            </Pressable>
          </>
        ) : (
          <OnbButton
            label="Take me to the journal"
            onPress={handleDone}
            style={styles.fullWidthButton}
            testID="onb-reveal-done-button"
          />
        )
      }
      testID="onb-reveal-screen"
    >
      <View style={styles.stage}>
        <Animated.View style={[styles.cardWrap, cardStyle]}>
          <View style={styles.card} testID="onb-reveal-card">
            {portraitUrl ? (
              <LoadedPortraitImage
                key={portraitUrl}
                name={name}
                portraitKey={portraitKey}
                portraitUrl={portraitUrl}
              />
            ) : (
              <View
                style={[styles.cardImage, styles.cardImagePlaceholder]}
                testID="onb-reveal-portrait-image-unavailable"
              >
                <ActivityIndicator color={colors.ink3} size="small" />
              </View>
            )}
          </View>
          <View style={styles.heartBadge} testID="onb-reveal-heart">
            <Animated.View style={{ transform: [{ scale: heartScale }] }}>
              <Heart
                color={liked ? colors.primary : colors.ink2}
                fill={liked ? colors.primary : 'transparent'}
                size={19}
                strokeWidth={1.5}
              />
            </Animated.View>
          </View>
        </Animated.View>

        <View style={styles.copy}>
          <OnbDisplay size={32}>{`Meet ${name}.`}</OnbDisplay>
          <OnbBody muted size={13.5} style={styles.body}>
            {`Painted from the photo you picked. This is how ${name} shows up in the journal from now on.`}
          </OnbBody>
          {birthdayAskMemberId === member.id ? (
            <RevealBirthdayAsk key={member.id} memberId={member.id} name={name} updateMember={updateMember} />
          ) : null}
        </View>
      </View>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  stage: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  cardWrap: {
    position: 'relative',
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    overflow: 'hidden',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.14,
    shadowRadius: 44,
    elevation: 6,
  },
  cardImage: {
    aspectRatio: 1,
    width: '100%',
  },
  cardImagePlaceholder: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  heartBadge: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    bottom: -12,
    height: 40,
    justifyContent: 'center',
    position: 'absolute',
    right: -6,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 4,
    width: 40,
  },
  copy: {
    paddingHorizontal: 6,
    paddingTop: 26,
  },
  body: {
    marginTop: 10,
  },
  fullWidthButton: {
    width: '100%',
  },
  birthday: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 4,
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  birthdayTitle: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 15,
  },
  birthdayButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primaryTint,
    borderRadius: radius.pill,
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  birthdayButtonText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 14,
  },
  birthdayStatus: {
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  birthdayStatusText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 12.5,
    marginTop: 6,
  },
  birthdayErrorText: {
    color: colors.error,
  },
  laterLink: {
    alignItems: 'center',
    paddingTop: 4,
  },
  laterText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
  },
});
