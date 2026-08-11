// The review deck's live card -- one suggestion handled like a photograph
// laid on the table (design: gi-review.jsx GIDeckPrint ~124-192 + gi-notes.jsx
// "The swipe"). The card is read-only: right = Keep (opens the composer),
// left = Set aside. The gesture is an accelerator; the labelled buttons in
// the parent action bar are the accessible equivalent, and the card itself
// carries screen-reader custom actions so no gesture is ever the only way.
import { Image } from 'expo-image';
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, fonts, radius } from '@/constants/theme';
import type { GalleryImportCandidate } from '@/services/gallery-import';
import {
  GALLERY_DECK_EXIT_DISTANCE_PX,
  GALLERY_DECK_EXIT_DURATION_MS,
  GALLERY_DECK_MAX_ROTATION_DEG,
  GALLERY_DECK_RETURN_DURATION_MS,
  galleryDeckIntentOpacity,
  galleryDeckRotationDeg,
  galleryDeckSwipeCommit,
  type GalleryDeckSwipeDirection,
} from '@/utils/gallery-import-deck';
import { formatFullDisplayDate, formatMemoryExcerpt } from '@/utils/memories';

const REDUCED_MOTION_FADE_MS = 120;
// Round 4, device-tested finding: after dismissing a card, the next one
// popped in already tilted (it inherited the just-exited card's leftover
// exitDirection-driven rotation for one frame -- fixed at the parent by only
// ever passing `exitDirection` for the candidate that is actually exiting,
// see gallery-import-review.tsx) and then straightened with a visible snap
// once state settled. Promotion is now its own short animation instead of
// an instant reset: `peekProgress` runs 1 (matching the static peek card's
// look, gallery-import-review.tsx's `peekFront` style) down to 0 (the
// resting front transform) over this duration.
const GALLERY_DECK_PROMOTE_DURATION_MS = 200;
const GALLERY_DECK_PEEK_ROTATION_DEG = 1;
const GALLERY_DECK_PEEK_TRANSLATE_Y = 5;
const GALLERY_DECK_PEEK_SCALE_DELTA = 0.04;

/** Caveat is used exactly once per screen -- the date stamp on the hero print. */
function scriptDateStamp(dateValue: string): string {
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateValue;
  return parsed.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function galleryDeckCardAccessibilityLabel(
  candidate: Pick<GalleryImportCandidate, 'caption' | 'memoryDate'>,
  position: number,
  total: number,
): string {
  return `Suggestion ${position} of ${total}. ${formatFullDisplayDate(candidate.memoryDate)}. ${formatMemoryExcerpt(candidate.caption, 90)}`;
}

export function GalleryImportDeckCard({
  candidate,
  position,
  total,
  poolCount,
  exitDirection,
  disabled,
  onCommit,
  onChoosePhotos,
  onShowSetAside,
}: {
  candidate: GalleryImportCandidate;
  position: number;
  total: number;
  /** Size of the day's reconstructed photo pool; null hides the pool line. */
  poolCount: number | null;
  /** Set by the parent while the 240ms exit plays (buttons or gesture). */
  exitDirection: GalleryDeckSwipeDirection | null;
  disabled: boolean;
  onCommit: (direction: GalleryDeckSwipeDirection) => void;
  onChoosePhotos: () => void;
  onShowSetAside: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const dx = useSharedValue(0);
  const fade = useSharedValue(1);
  // 1 = sitting at the peek transform (tilt/scale/offset), 0 = resting at
  // the true front transform. Only ever nonzero while a promotion is
  // animating in; 0 the rest of the time, including for the very first
  // card this component ever renders (it was never "promoted" from a peek).
  const peekProgress = useSharedValue(0);
  const previousCandidateIdRef = useRef(candidate.id);

  // A new candidate.id means this card was just promoted to the front --
  // reset synchronously here during render, not deferred to an effect: a
  // promoted card's very first rendered frame must never carry the previous
  // (now-departed) candidate's leftover drag position. Waiting for an
  // effect left exactly one frame where the freshly promoted card inherited
  // a stale, fully off-screen translateX and its rotation clamped to the
  // exit's max angle (device-tested "next card appears tilted" jank,
  // confirmed by a render-timing test). `dx`/`fade`/`peekProgress` are
  // shared values, not React state, so adjusting them mid-render is the
  // same safe "adjust state while rendering" pattern React documents for
  // refs -- it lands in this exact render's `cardStyle`/stamp calculations
  // below instead of one commit later. `exitDirection` at this exact render
  // may still be set, but it belongs to whichever card just left (the
  // parent only ever passes it for the candidate actually exiting, see
  // gallery-import-review.tsx), never to this fresh one, so it must not
  // drive anything here either. `promotedRef` hands the one part that IS a
  // real animation -- tweening peekProgress back down to rest -- to the
  // effect underneath, which still needs to run after commit.
  const promoted = previousCandidateIdRef.current !== candidate.id;
  if (promoted) {
    previousCandidateIdRef.current = candidate.id;
    dx.set(0);
    fade.set(1);
    peekProgress.set(reducedMotion ? 0 : 1);
  }
  const promotedRef = useRef(false);
  promotedRef.current = promotedRef.current || promoted;

  useEffect(() => {
    if (promotedRef.current) {
      promotedRef.current = false;
      if (!reducedMotion) peekProgress.set(withTiming(0, { duration: GALLERY_DECK_PROMOTE_DURATION_MS }));
      return;
    }

    // Buttons and screen-reader actions commit without a drag; drive the
    // same exit animation the gesture produces. Reduced motion cross-fades
    // in place (gi-notes.jsx "Reduced motion": position never changes).
    if (exitDirection) {
      if (reducedMotion) {
        fade.set(withTiming(0, { duration: REDUCED_MOTION_FADE_MS }));
      } else {
        dx.set(withTiming(
          exitDirection === 'keep' ? GALLERY_DECK_EXIT_DISTANCE_PX : -GALLERY_DECK_EXIT_DISTANCE_PX,
          { duration: GALLERY_DECK_EXIT_DURATION_MS },
        ));
      }
      return;
    }
    dx.set(0);
    fade.set(1);
  }, [candidate.id, dx, exitDirection, fade, peekProgress, reducedMotion]);

  const pan = Gesture.Pan()
    .withTestId('gallery-import-deck-pan')
    .enabled(!disabled && !exitDirection)
    .maxPointers(1)
    .activeOffsetX([-12, 12])
    .onUpdate((event) => {
      // 1:1 follow -- the card is paper under the finger, not an easing curve.
      if (!reducedMotion) dx.set(event.translationX);
    })
    .onEnd((event) => {
      const direction = galleryDeckSwipeCommit(event.translationX, event.velocityX / 1000);
      if (direction) {
        if (!reducedMotion) {
          dx.set(withTiming(
            direction === 'keep' ? GALLERY_DECK_EXIT_DISTANCE_PX : -GALLERY_DECK_EXIT_DISTANCE_PX,
            { duration: GALLERY_DECK_EXIT_DURATION_MS },
          ));
        }
        runOnJS(onCommit)(direction);
        return;
      }
      // Below threshold: return in 260ms, no snap-back overshoot.
      dx.set(withTiming(0, { duration: GALLERY_DECK_RETURN_DURATION_MS }));
    });

  const cardStyle = useAnimatedStyle(() => {
    const peek = peekProgress.get();
    // Mid-promotion (peek > 0), the peek tilt owns rotation -- there is no
    // drag and nothing is exiting yet for a card that just arrived. At rest
    // (peek === 0) this is exactly the previous drag/exit calculation.
    const rotateDeg = exitDirection && !reducedMotion
      ? (exitDirection === 'keep' ? GALLERY_DECK_MAX_ROTATION_DEG : -GALLERY_DECK_MAX_ROTATION_DEG)
      : reducedMotion ? 0 : galleryDeckRotationDeg(dx.get()) + peek * GALLERY_DECK_PEEK_ROTATION_DEG;
    return {
      opacity: fade.get(),
      transform: [
        { translateX: dx.get() },
        { translateY: peek * GALLERY_DECK_PEEK_TRANSLATE_Y },
        { scale: 1 - peek * GALLERY_DECK_PEEK_SCALE_DELTA },
        { rotate: `${rotateDeg}deg` },
      ],
    };
  });
  const keepStampStyle = useAnimatedStyle(() => ({
    opacity: exitDirection === 'keep' ? 1 : exitDirection ? 0 : galleryDeckIntentOpacity(dx.get(), 'keep'),
  }));
  const asideStampStyle = useAnimatedStyle(() => ({
    opacity: exitDirection === 'aside' ? 1 : exitDirection ? 0 : galleryDeckIntentOpacity(dx.get(), 'aside'),
  }));

  const heroUri = candidate.previewUrls?.[0];
  const stripUris = candidate.previewUrls?.slice(1, 4) ?? [];
  const chosenCount = candidate.selectedAssetTokens.length;

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        accessible
        accessibilityActions={[
          { name: 'keep', label: 'Keep this' },
          { name: 'set_aside', label: 'Set aside' },
          { name: 'choose_photos', label: 'Choose photos' },
          { name: 'show_set_aside', label: 'Show set-aside list' },
        ]}
        accessibilityLabel={galleryDeckCardAccessibilityLabel(candidate, position, total)}
        onAccessibilityAction={(event) => {
          switch (event.nativeEvent.actionName) {
            case 'keep': onCommit('keep'); break;
            case 'set_aside': onCommit('aside'); break;
            case 'choose_photos': onChoosePhotos(); break;
            case 'show_set_aside': onShowSetAside(); break;
          }
        }}
        style={[styles.card, cardStyle]}
        testID="gallery-import-deck-card"
      >
        {/* Intent stamps -- a word, never colour alone. */}
        <Animated.View pointerEvents="none" style={[styles.stamp, styles.stampKeep, keepStampStyle]} testID="gallery-import-intent-keep">
          <Text style={styles.stampKeepText}>Keep</Text>
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.stamp, styles.stampAside, asideStampStyle]} testID="gallery-import-intent-aside">
          <Text style={styles.stampAsideText}>Set aside</Text>
        </Animated.View>

        {/* The hero print inside its photo mat, with the one script mark. */}
        <View style={styles.hero}>
          {heroUri ? (
            <Image contentFit="cover" source={{ uri: heroUri }} style={styles.heroImage} testID="gallery-import-hero" />
          ) : (
            <View style={styles.heroFallback} testID="gallery-import-hero-fallback"><Text style={styles.heroFallbackMark}>✦</Text></View>
          )}
          <Text style={styles.heroStamp}>{scriptDateStamp(candidate.memoryDate)}</Text>
        </View>

        {/* The event's other photos -- a preview you can open, not a control. */}
        <Pressable
          accessibilityLabel={poolCount
            ? `${chosenCount} photos chosen, from ${poolCount} photos that day. Opens the day's photos.`
            : `${chosenCount} photos chosen. Opens the day's photos.`}
          accessibilityRole="button"
          disabled={disabled}
          onPress={onChoosePhotos}
          style={styles.strip}
          testID="gallery-import-film-strip"
        >
          <View style={styles.stripThumbs}>
            {stripUris.map((uri) => (
              <Image contentFit="cover" key={uri} source={{ uri }} style={styles.stripThumb} />
            ))}
          </View>
          <View style={styles.stripCopy}>
            <Text style={styles.stripTitle}>{chosenCount} {chosenCount === 1 ? 'photo' : 'photos'} chosen</Text>
            {poolCount ? <Text style={styles.stripSub}>from {poolCount} photos that day</Text> : null}
          </View>
          <Text style={styles.stripChevron}>›</Text>
        </Pressable>

        <View style={styles.divider} />

        <Text style={styles.date}>{formatFullDisplayDate(candidate.memoryDate)}</Text>
        <Text numberOfLines={3} style={styles.caption}>{candidate.caption}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    bottom: 0,
    elevation: 6,
    left: 0,
    padding: 12,
    position: 'absolute',
    right: 0,
    shadowColor: '#281E14',
    shadowOffset: { height: 20, width: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    top: 0,
  },
  stamp: {
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
    position: 'absolute',
    top: 18,
    zIndex: 5,
  },
  stampKeep: { backgroundColor: colors.primary, right: 18, transform: [{ rotate: '-6deg' }] },
  stampKeepText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 12.5, letterSpacing: 0.8, textTransform: 'uppercase' },
  stampAside: { backgroundColor: colors.white, borderColor: colors.borderStrong, borderWidth: 1.5, left: 18, transform: [{ rotate: '6deg' }] },
  stampAsideText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12.5, letterSpacing: 0.8, textTransform: 'uppercase' },
  hero: { borderRadius: 14, flex: 1, minHeight: 160, overflow: 'hidden', position: 'relative' },
  heroImage: { backgroundColor: colors.primaryTint, flex: 1, width: '100%' },
  heroFallback: { alignItems: 'center', backgroundColor: colors.primaryTint, flex: 1, justifyContent: 'center' },
  heroFallbackMark: { color: colors.primary, fontSize: 34 },
  heroStamp: {
    bottom: 8,
    color: 'rgba(60,44,30,0.62)',
    fontFamily: fonts.scriptBold,
    fontSize: 17,
    position: 'absolute',
    right: 10,
    transform: [{ rotate: '-4deg' }],
  },
  strip: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 10, minHeight: 44 },
  stripThumbs: { flexDirection: 'row', gap: 4 },
  stripThumb: { backgroundColor: colors.surface, borderRadius: 6, height: 38, width: 38 },
  stripCopy: { flex: 1, minWidth: 0 },
  stripTitle: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12.5 },
  stripSub: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5 },
  stripChevron: { color: colors.ink3, fontFamily: fonts.display, fontSize: 22, lineHeight: 24 },
  divider: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginBottom: 12, marginTop: 11 },
  date: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  caption: { color: colors.ink, fontFamily: fonts.display, fontSize: 19, lineHeight: 27, marginTop: 8 },
});
