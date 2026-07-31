// S10 -- The aha: their first page (docs/plans/onboarding-design-brief.md
// S10, docs/plans/onboarding-implementation.md WP2). Renders the memory
// captured at S9 straight from the device-local draft -- nothing has been
// saved server-side yet (that's commitOnboarding, post-auth at S12) -- using
// the same card language as src/components/memory-card.tsx (quote treatment
// for text-only, media treatment when a photo was attached) so onboarding
// looks like the app it leads into.
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Heart } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { kidTint } from '@/components/onboarding/onb-illustration';
import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { OnbBody, OnbEyebrow, OnbScript } from '@/components/onboarding/onb-typography';
import { colors, emotionColors, fonts, radius, spacing } from '@/constants/theme';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { onboardingYearRoute } from '@/lib/onboarding-routes';
import { aspectRatioFromDimensions, clampMediaAspectRatio, DEFAULT_MEDIA_ASPECT_RATIO } from '@/utils/media-aspect';
import { capitalizeFragment, firstPageCaption, journalPossessive, kidsPossessive } from '@/utils/onboarding-copy';

function TaggedAvatars({ names }: { names: string[] }) {
  return (
    <View style={styles.avatarCluster}>
      {names.map((name, index) => {
        const tint = emotionColors[kidTint(index)];
        return (
          <View
            key={`${name}-${index}`}
            style={[
              styles.avatarCircle,
              { backgroundColor: tint.soft, marginLeft: index === 0 ? 0 : -7 },
            ]}
          >
            <Text style={[styles.avatarInitial, { color: tint.ink }]}>{name.charAt(0).toUpperCase()}</Text>
          </View>
        );
      })}
    </View>
  );
}

function CardFooter({
  names,
  liked,
  heartScale,
}: {
  names: string[];
  liked: boolean;
  heartScale: Animated.Value;
}) {
  return (
    <View style={styles.footer}>
      <Text style={styles.footerDay}>Tonight</Text>
      {names.length > 0 ? <TaggedAvatars names={names} /> : null}
      <View style={styles.footerSpacer} />
      {/* No emotion chip here: emotion analysis is a fire-and-forget kicked
          off by commitOnboarding's createMemory, post-auth -- nothing has
          run yet at this point in the flow, so there is no real emotion to
          show (see docs/features/onboarding.md decision 10). This mirrors
          src/components/memory-card.tsx's real CardFooter, which likewise
          renders no chip when `memory.emotion` is null. */}
      {/* Same animation composition as the real like button
          (src/components/memory-engagement-bar.tsx): a scale pop
          (1 -> 1.32 -> spring back to 1, friction 4/tension 180) timed to
          the heart's liked/unliked color+fill swap, not a bespoke curve. */}
      <Animated.View style={{ transform: [{ scale: heartScale }] }}>
        <Heart
          color={liked ? colors.primary : colors.ink2}
          fill={liked ? colors.primary : 'transparent'}
          size={22}
          strokeWidth={1.9}
        />
      </Animated.View>
    </View>
  );
}

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
  const [mediaAspectRatio, setMediaAspectRatio] = useState(DEFAULT_MEDIA_ASPECT_RATIO);

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
          <View style={styles.card} testID="onboarding-aha-card">
            {capture?.mediaUri ? (
              <>
                <Image
                  accessibilityLabel="Your captured photo"
                  contentFit="cover"
                  onLoad={(event) => {
                    const ratio = aspectRatioFromDimensions(event.source.width, event.source.height);
                    if (ratio) {
                      setMediaAspectRatio(clampMediaAspectRatio(ratio));
                    }
                  }}
                  source={{ uri: capture.mediaUri }}
                  style={[styles.cardImage, { aspectRatio: mediaAspectRatio }]}
                  testID="onboarding-aha-media-image"
                />
                {capture.text ? (
                  <View style={styles.captionWrap}>
                    <OnbBody size={14.5} style={styles.caption}>{capture.text}</OnbBody>
                  </View>
                ) : null}
                <CardFooter heartScale={heartScale} liked={liked} names={taggedNames} />
              </>
            ) : (
              <>
                <View style={styles.quoteBody}>
                  <Text style={styles.quoteMark} testID="onboarding-aha-quote-mark">&ldquo;</Text>
                  <Text style={styles.quoteText}>{capture?.text ?? ''}</Text>
                </View>
                <CardFooter heartScale={heartScale} liked={liked} names={taggedNames} />
              </>
            )}
          </View>

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
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: '#2C2418',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.12,
    shadowRadius: 44,
  },
  quoteBody: {
    padding: 18,
    paddingBottom: 4,
  },
  // Matches app/(app)/memory/[id]/index.tsx's MemoryDetailEditorial
  // treatment (editorialQuote/editorialText): a normal-flow watermark glyph
  // sized and clipped (fixed height, negative marginBottom) to sit above the
  // quote text and pull it in close, not absolutely positioned behind it.
  // src/components/memory-card.tsx's QuoteCard (the timeline card) has no
  // such glyph at all -- this is the one place in the app the mark exists,
  // so it's the treatment to converge on. Color falls back to the same
  // neutral colors.ink3 that screen uses when there's no emotion to tint it.
  quoteMark: {
    color: colors.ink3,
    fontFamily: fonts.display,
    fontSize: 56,
    height: 34,
    lineHeight: 56,
    marginBottom: -6,
    opacity: 0.18,
  },
  quoteText: {
    color: colors.ink,
    fontFamily: fonts.displayItalic,
    fontSize: 22,
    lineHeight: 1.28 * 22,
  },
  cardImage: {
    width: '100%',
  },
  captionWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: 13,
  },
  caption: {
    lineHeight: 22,
  },
  footer: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 16,
    paddingHorizontal: spacing.md,
    paddingTop: 12,
  },
  footerDay: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
  },
  footerSpacer: {
    flex: 1,
  },
  avatarCluster: {
    alignItems: 'center',
    flexDirection: 'row',
    marginLeft: 4,
  },
  avatarCircle: {
    alignItems: 'center',
    borderColor: colors.white,
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  avatarInitial: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
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
