// S10 -- The aha: their first page (docs/plans/onboarding-design-brief.md
// S10, docs/plans/onboarding-implementation.md WP2). Renders the memory
// captured at S9 straight from the device-local draft -- nothing has been
// saved server-side yet (that's commitOnboarding, post-auth at S12) -- using
// the same card language as src/components/memory-card.tsx (quote treatment
// for text-only, media treatment when a photo was attached) so onboarding
// looks like the app it leads into.
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbMemoryCard } from '@/components/onboarding/onb-memory-card';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbEyebrow, OnbScript } from '@/components/onboarding/onb-typography';
import { colors } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useAttachmentPreviewUri } from '@/hooks/useVideoThumbnail';
import { onboardingYearRoute } from '@/lib/onboarding-routes';
import { clampMediaAspectRatio, DEFAULT_MEDIA_ASPECT_RATIO } from '@/utils/media-aspect';
import { capitalizeFragment, firstPageCaption, journalPossessive, kidsPossessive } from '@/utils/onboarding-copy';

export default function OnboardingAhaScreen() {
  const { draft } = useOnboardingFlow();
  const capture = draft.capture;

  const taggedNames = (capture?.taggedKidIndexes ?? [])
    .map((index) => draft.kidNames[index])
    .filter((name): name is string => Boolean(name));

  const [settleAnim] = useState(() => new Animated.Value(0));
  // Mirrors memory-engagement-bar.tsx's own local state shape exactly: a
  // scale value that starts at rest (1, not 0 -- there's no "pop in from
  // nothing" in the real component, just a liked/unliked swap) and a
  // previous-value ref that gates the pop to the false->true transition.
  const [liked, setLiked] = useState(false);
  const [heartScale] = useState(() => new Animated.Value(1));
  const previousLikedRef = useRef(false);

  // Mirrors app/(app)/memory/[id]/index.tsx's framed-detail illustration
  // measurement (and memory-card.tsx's IllustrationVisual): the real natural
  // ratio isn't known until the image reports its own dimensions on load, so
  // start from the same neutral 4:3 placeholder those screens fall back to
  // and swap in the measured, clamped ratio once it's available. capture.mediaUri
  // is a local device file (not a signed R2 URL), but expo-image's onLoad
  // reports natural width/height for local sources the same way -- no
  // network round trip needed, so this settles essentially immediately and
  // there is no empty/blank frame while waiting.
  // Seeded from the picker's own ratio when the draft has one -- a video's
  // first-frame still is generated asynchronously, so this keeps the card
  // from resizing when it arrives.
  const [mediaAspectRatio, setMediaAspectRatio] = useState(() =>
    capture?.mediaAspectRatio ? clampMediaAspectRatio(capture.mediaAspectRatio) : DEFAULT_MEDIA_ASPECT_RATIO,
  );
  // expo-image can't draw a video file -- a video capture shows its
  // generated first frame instead of an empty card on the one screen whose
  // whole job is the payoff.
  const { isVideo, previewUri } = useAttachmentPreviewUri(capture?.mediaUri, capture?.mediaContentType);

  useEffect(() => {
    Animated.timing(settleAnim, {
      toValue: 1,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    // One beat of delight after the card settles (docs/plans/
    // onboarding-design-brief.md S10's "one beat of delight, not a
    // fireworks show") -- the real like button has no such delay (it pops
    // the instant a real tap flips likedByMe), so this timer is onboarding's
    // own addition; the pop itself below reuses that component's animation
    // untouched.
    const timer = setTimeout(() => setLiked(true), 1200);
    return () => clearTimeout(timer);
  }, [settleAnim]);

  // Same effect as memory-engagement-bar.tsx's handleLike pop: scale up to
  // 1.32 over 120ms, then spring back to 1 (friction 4, tension 180) --
  // fired only on the false->true transition, exactly like the real
  // component's `engagement.likedByMe && !previousLiked.current` guard.
  useEffect(() => {
    if (liked && !previousLikedRef.current) {
      heartScale.setValue(1);
      Animated.sequence([
        Animated.timing(heartScale, { toValue: 1.32, duration: 120, useNativeDriver: true }),
        Animated.spring(heartScale, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
      ]).start();
    }
    previousLikedRef.current = liked;
  }, [liked, heartScale]);

  const cardStyle = {
    opacity: settleAnim,
    transform: [
      {
        translateY: settleAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }),
      },
    ],
  };

  const handleContinue = () => {
    router.push(onboardingYearRoute);
  };

  // Device-reported bug (2026-07-31): several-tagged-kids used to render
  // "saved · Their journal" here -- correct pronoun choice, wrong pronoun
  // *person*. journalPossessive flavors the neutral case "Your" instead
  // (see its doc comment in onboarding-copy.ts for the full reconciliation).
  const journalOwner = capitalizeFragment(journalPossessive(kidsPossessive(taggedNames)));

  return (
    <OnbShell
      footer={
        <OnbButton
          label="Keep it going"
          onPress={handleContinue}
          style={styles.fullWidthButton}
          testID="onboarding-aha-continue"
        />
      }
    >
      <View style={styles.eyebrowWrap}>
        <OnbEyebrow color={colors.ink3}>That cost you about 20 seconds of your evening</OnbEyebrow>
      </View>

      <View style={styles.cardStage}>
        <Animated.View style={[styles.cardWrap, cardStyle]}>
          <OnbMemoryCard
            dayLabel="Tonight"
            hasMedia={Boolean(capture?.mediaUri)}
            heartScale={heartScale}
            imageUri={previewUri}
            isVideo={isVideo}
            liked={liked}
            mediaAspectRatio={mediaAspectRatio}
            mediaDurationMs={capture?.mediaDurationMs}
            onMediaAspectRatio={setMediaAspectRatio}
            taggedNames={taggedNames}
            testIDPrefix="onboarding-aha"
            text={capture?.text ?? ''}
          />

          <OnbScript color={colors.ink3} size={17} style={styles.savedCaption}>
            saved · {journalOwner} journal
          </OnbScript>
        </Animated.View>
      </View>

      <OnbBody size={15.5} style={styles.belowCardCaption}>
        {firstPageCaption(taggedNames)}
      </OnbBody>
    </OnbShell>
  );
}

const styles = StyleSheet.create({
  eyebrowWrap: {
    alignItems: 'center',
    paddingTop: 24,
  },
  cardStage: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  cardWrap: {
    width: '100%',
  },
  savedCaption: {
    marginTop: 8,
    textAlign: 'right',
    transform: [{ rotate: '-1.5deg' }],
  },
  belowCardCaption: {
    paddingBottom: 20,
    paddingHorizontal: 26,
    textAlign: 'center',
  },
  fullWidthButton: {
    width: '100%',
  },
});
