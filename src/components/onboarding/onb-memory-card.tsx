// The onboarding "first page" card: S10's aha (app/(onboarding)/aha.tsx)
// and S15b's paused screen (app/(onboarding)/paused.tsx) show the same card,
// so the moment the parent saved is what greets them when they step away
// from the price. Same card language as src/components/memory-card.tsx
// (quote treatment for text-only, media treatment when a photo/video was
// attached), but presentational only: no navigation, no engagement writes.
import { Image } from 'expo-image';
import { Heart, Play } from 'lucide-react-native';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { kidTint } from '@/components/onboarding/onb-illustration';
import { OnbBody } from '@/components/onboarding/onb-typography';
import { colors, emotionColors, fonts, radius, spacing } from '@/constants/theme';
import { aspectRatioFromDimensions, clampMediaAspectRatio } from '@/utils/media-aspect';
import { formatVideoDurationLabel } from '@/utils/memories';

export interface OnbMemoryCardProps {
  text: string;
  /** True when the memory has a photo/video (the media treatment), even before a still is ready. */
  hasMedia: boolean;
  /** A still expo-image can draw: the photo, or a video's first frame. Null while one is loading. */
  imageUri: string | null;
  isVideo: boolean;
  mediaAspectRatio: number;
  /** Reports the loaded still's natural (clamped) ratio, for callers that size the frame from it. */
  onMediaAspectRatio?: (ratio: number) => void;
  mediaDurationMs?: number | null;
  taggedNames: string[];
  dayLabel: string;
  liked: boolean;
  /** The like-pop scale from S10; static when omitted. */
  heartScale?: Animated.Value;
  /** e.g. "onboarding-aha" -> "onboarding-aha-card", "onboarding-aha-media-image", ... */
  testIDPrefix: string;
  /** Clamp the memory text, for a card that shares the screen with other copy (S15b). */
  textNumberOfLines?: number;
}

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
  dayLabel,
  names,
  liked,
  heartScale,
}: {
  dayLabel: string;
  names: string[];
  liked: boolean;
  heartScale?: Animated.Value;
}) {
  return (
    <View style={styles.footer}>
      <Text style={styles.footerDay}>{dayLabel}</Text>
      {names.length > 0 ? <TaggedAvatars names={names} /> : null}
      <View style={styles.footerSpacer} />
      {/* No emotion chip here: emotion analysis is a fire-and-forget kicked
          off by commitOnboarding's createMemory, post-auth -- nothing has
          run yet at S10, so there is no real emotion to show (see
          docs/features/onboarding.md decision 10). This mirrors
          src/components/memory-card.tsx's real CardFooter, which likewise
          renders no chip when `memory.emotion` is null. */}
      {/* Same animation composition as the real like button
          (src/components/memory-engagement-bar.tsx): a scale pop
          (1 -> 1.32 -> spring back to 1, friction 4/tension 180) timed to
          the heart's liked/unliked color+fill swap, not a bespoke curve. */}
      <Animated.View style={heartScale ? { transform: [{ scale: heartScale }] } : undefined}>
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

export function OnbMemoryCard({
  text,
  hasMedia,
  imageUri,
  isVideo,
  mediaAspectRatio,
  onMediaAspectRatio,
  mediaDurationMs,
  taggedNames,
  dayLabel,
  liked,
  heartScale,
  testIDPrefix,
  textNumberOfLines,
}: OnbMemoryCardProps) {
  const footer = <CardFooter dayLabel={dayLabel} heartScale={heartScale} liked={liked} names={taggedNames} />;

  if (!hasMedia) {
    return (
      <View style={styles.card} testID={`${testIDPrefix}-card`}>
        <View style={styles.quoteBody}>
          <Text style={styles.quoteMark} testID={`${testIDPrefix}-quote-mark`}>&ldquo;</Text>
          <Text ellipsizeMode="tail" numberOfLines={textNumberOfLines} style={styles.quoteText}>
            {text}
          </Text>
        </View>
        {footer}
      </View>
    );
  }

  return (
    <View style={styles.card} testID={`${testIDPrefix}-card`}>
      <View style={[styles.cardImage, { aspectRatio: mediaAspectRatio }]} testID={`${testIDPrefix}-media-frame`}>
        {imageUri ? (
          <Image
            accessibilityLabel={isVideo ? 'Your captured video' : 'Your captured photo'}
            contentFit="cover"
            onLoad={(event) => {
              const ratio = aspectRatioFromDimensions(event.source.width, event.source.height);
              if (ratio) {
                onMediaAspectRatio?.(clampMediaAspectRatio(ratio));
              }
            }}
            source={{ uri: imageUri }}
            style={StyleSheet.absoluteFill}
            testID={`${testIDPrefix}-media-image`}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.mediaPlaceholder]} testID={`${testIDPrefix}-media-placeholder`} />
        )}
        {isVideo ? (
          <>
            {mediaDurationMs ? (
              <View style={styles.durationChip}>
                <Text style={styles.durationChipText}>{formatVideoDurationLabel(mediaDurationMs)}</Text>
              </View>
            ) : null}
            <View style={styles.playButton} testID={`${testIDPrefix}-video-badge`}>
              <Play color={colors.white} fill={colors.white} size={16} />
            </View>
          </>
        ) : null}
      </View>
      {text ? (
        <View style={styles.captionWrap}>
          <OnbBody ellipsizeMode="tail" numberOfLines={textNumberOfLines} size={14.5} style={styles.caption}>
            {text}
          </OnbBody>
        </View>
      ) : null}
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
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
  mediaPlaceholder: {
    backgroundColor: emotionColors.joy.soft,
  },
  // Same video affordances as the S10b showcase cards (year.tsx).
  playButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(44,36,24,0.5)',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -22,
    marginTop: -22,
    position: 'absolute',
    top: '50%',
    width: 44,
  },
  durationChip: {
    backgroundColor: 'rgba(44,36,24,0.62)',
    borderRadius: 999,
    bottom: 10,
    paddingHorizontal: 9,
    paddingVertical: 3,
    position: 'absolute',
    right: 10,
  },
  durationChipText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 11,
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
});
