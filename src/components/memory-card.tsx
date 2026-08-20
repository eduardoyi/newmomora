import { Image } from 'expo-image';
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { seedFromKey } from '@/components/audio/audio-seed';
import { StubBand } from '@/components/audio/stub-band';
import { StubTear } from '@/components/audio/stub-tear';
import { GeneratingVisualOverlay } from '@/components/generating-visual-overlay';
import { ContentHiddenNotice } from '@/components/content-hidden-notice';
import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { MemoryEngagementBar } from '@/components/memory-engagement-bar';
import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { colors, fonts, getEmotionColors, radius, spacing } from '@/constants/theme';
import { useAudioClipPlayback } from '@/hooks/useAudioClipPlayback';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { MemoryWithTags } from '@/services/memories';
import { toLinkPreviewMap } from '@/utils/links';
import {
  formatDisplayDate,
  formatMemoryExcerpt,
  getIllustrationStatusLabel,
  isIllustrationInProgress,
  isKnownMemoryType,
  UNSUPPORTED_MEMORY_TYPE_NOTICE,
  type IllustrationStatus,
} from '@/utils/memories';
import { aspectRatioFromDimensions, clampMediaAspectRatio } from '@/utils/media-aspect';
import { mediaImageSource } from '@/utils/media-image-source';
import { isVideoContentType } from '@/utils/media-validation';

interface MemoryCardProps {
  memory: MemoryWithTags;
  // Receive the memory id rather than a bound closure (Workstream B1) so
  // parents can pass a single stable callback (e.g. useCallback wrapping
  // router.push) instead of a fresh per-row closure -- required for
  // React.memo below to actually skip re-renders on unrelated list re-renders.
  // `mediaIndex` is the carousel page the user tapped, so the detail screen
  // can open on the asset they were looking at rather than the first one.
  onPress: (memoryId: string, mediaIndex?: number) => void;
  onOpenComments: (memoryId: string) => void;
  isVideoActive?: boolean;
  isIllustrationHidden?: boolean;
  onShowIllustration?: () => void;
}

const MAX_TIMELINE_MEMBER_AVATARS = 6;

// ── Emotion chip ──────────────────────────────────────────────────────────────
function EmotionChip({ emotion }: { emotion: string }) {
  const emo = getEmotionColors(emotion);
  if (!emo) return null;
  return (
    <View style={[styles.emotionChip, { backgroundColor: emo.soft }]}>
      <View style={[styles.emotionDot, { backgroundColor: emo.c }]} />
      <Text style={[styles.emotionLabel, { color: emo.ink }]}>{emotion}</Text>
    </View>
  );
}

// ── Member avatar cluster ──────────────────────────────────────────────────────
function AvatarCluster({ members }: { members: MemoryWithTags['taggedMembers'] }) {
  const visibleMembers = members.slice(0, MAX_TIMELINE_MEMBER_AVATARS);
  const hiddenMemberCount = members.length - visibleMembers.length;

  return (
    <View style={styles.avatarCluster}>
      {visibleMembers.map((m, i) => (
        <FamilyMemberAvatar
          key={m.id}
          member={m}
          size={22}
          style={[styles.avatarCircle, { marginLeft: i === 0 ? 0 : -7 }]}
          testID={`memory-card-member-${m.id}`}
        />
      ))}
      {hiddenMemberCount > 0 ? (
        <View
          accessibilityLabel={`${hiddenMemberCount} more tagged members`}
          style={[styles.avatarCircle, styles.avatarOverflow, { marginLeft: -7 }]}
          testID="memory-card-member-overflow"
        >
          <Text style={styles.avatarOverflowText}>+{hiddenMemberCount}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Shared card footer ────────────────────────────────────────────────────────
function CardFooter({ memory }: { memory: MemoryWithTags }) {
  const dayLabel = formatDisplayDate(memory.memory_date);
  const isMedia = memory.memory_type === 'media';
  const mediaTypes = memory.mediaAssets.map((asset) => asset.content_type);
  const hasVideo = mediaTypes.some(isVideoContentType);
  const hasPhoto = mediaTypes.some((contentType) => !isVideoContentType(contentType));
  const mediaLabel = hasPhoto && hasVideo
    ? 'Media'
    : hasVideo
      ? 'Video'
      : 'Photo';

  return (
    <View style={styles.footer}>
      <Text style={styles.footerDay}>{dayLabel}</Text>
      {memory.taggedMembers.length > 0 && (
        <AvatarCluster members={memory.taggedMembers} />
      )}
      <View style={styles.footerSpacer} />
      {memory.emotion ? (
        <EmotionChip emotion={memory.emotion} />
      ) : isMedia ? (
        <View style={styles.mediaBadge}>
          <Text style={styles.mediaBadgeText}>{mediaLabel}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Illustration visual ───────────────────────────────────────────────────────
function IllustrationVisual({
  memory,
  isHidden,
}: {
  memory: MemoryWithTags;
  isHidden: boolean;
}) {
  const { url } = useMediaUrl(
    isHidden ? null : memory.illustration_key,
    memory.updated_at,
  );
  const emo = getEmotionColors(memory.emotion);
  const status = (memory.illustration_status ?? 'pending') as IllustrationStatus;
  const showGenerating = isIllustrationInProgress(status);
  const showFailed = status === 'failed';
  // Illustrations are generated square (1024×1024); measure on load so any
  // legacy or future sizes still render uncropped.
  const [illustrationRatio, setIllustrationRatio] = useState(1);

  const handleLoad = (event: { source: { width: number; height: number } }) => {
    const ratio = aspectRatioFromDimensions(event.source.width, event.source.height);
    if (ratio) {
      setIllustrationRatio(clampMediaAspectRatio(ratio));
    }
  };

  if (url && !showGenerating && !showFailed) {
    return (
      <Image
        contentFit="cover"
        onLoad={handleLoad}
        source={mediaImageSource(url, memory.illustration_key)}
        style={[styles.cardImage, { aspectRatio: illustrationRatio }]}
        testID={`memory-card-${memory.id}-illustration`}
      />
    );
  }

  return (
    <View style={[styles.cardImage, styles.placeholderVisual, { backgroundColor: colors.surface }]}>
      {showGenerating ? (
        <GeneratingVisualOverlay
          label={getIllustrationStatusLabel(status)}
          variant="inline"
        />
      ) : showFailed && url ? (
        <>
          <Image
            contentFit="cover"
            source={mediaImageSource(url, memory.illustration_key)}
            style={StyleSheet.absoluteFill}
            testID={`memory-card-${memory.id}-illustration-failed`}
          />
          <View style={styles.failedOverlay}>
            <Text style={styles.failedOverlayText}>Illustration failed — tap to retry</Text>
          </View>
        </>
      ) : (
        <Text style={[styles.placeholderText, { color: emo?.ink ?? colors.ink3 }]}>
          {getIllustrationStatusLabel(status)}
        </Text>
      )}
    </View>
  );
}

// ── Media visual ──────────────────────────────────────────────────────────────
function MediaVisual({
  memory,
  isActive,
  onPress,
  onActiveIndexChange,
}: {
  memory: MemoryWithTags;
  isActive: boolean;
  onPress?: (mediaIndex: number) => void;
  onActiveIndexChange?: (index: number) => void;
}) {
  if (memory.mediaAssets.length > 0) {
    return (
      <MemoryMediaCarousel
        assets={memory.mediaAssets}
        cacheVersion={memory.updated_at}
        isActive={isActive}
        onActiveIndexChange={onActiveIndexChange}
        onPress={onPress}
        preferPreview
        stableLayout
        style={styles.mediaVisual}
      />
    );
  }

  return (
    <View style={[styles.cardImage, styles.placeholderVisual, { backgroundColor: colors.surface }]}>
      <Text style={styles.placeholderText}>Media</Text>
    </View>
  );
}

// ── Spread card (text_illustration + media) ───────────────────────────────────
// KEEP IN SYNC (S3, docs/plans/offline-awareness-and-share-cards.md) with
// supabase/functions/compose-share-card/layout.ts, which replicates this
// card (and QuoteCard/CardFooter/AvatarCluster below) server-side for the
// share-card PNG. That file's own header comment points back here -- if you
// change this card's visual design, check whether layout.ts needs the same
// change, and vice versa.
function SpreadCard({
  memory,
  onPress,
  onOpenComments,
  isVideoActive = false,
  isIllustrationHidden = false,
  onShowIllustration,
}: MemoryCardProps) {
  const excerpt = memory.content
    ? formatMemoryExcerpt(memory.content, 140, toLinkPreviewMap(memory.link_previews))
    : null;
  const handlePress = () => onPress(memory.id);
  const handleOpenComments = () => onOpenComments(memory.id);
  // Tapping the carousel opens the detail screen on that same page; tapping
  // the caption/footer below it has no page context, so it opens on the first.
  const handleMediaPress = (mediaIndex: number) => onPress(memory.id, mediaIndex);
  // Current carousel page (S4) -- lifted so the share affordance can send
  // the page the user is actually looking at, and disable itself on a video
  // page. Only relevant for the 'media' branch below; text_illustration has
  // no carousel, so this stays at its initial value (unused).
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);

  if (memory.memory_type === 'media') {
    const activeAsset = memory.mediaAssets[activeMediaIndex] ?? memory.mediaAssets[0] ?? null;
    return (
      <View
        style={styles.card}
        testID={`memory-card-${memory.id}`}
      >
        <MediaVisual
          memory={memory}
          isActive={isVideoActive}
          onActiveIndexChange={setActiveMediaIndex}
          onPress={handleMediaPress}
        />
        <View style={styles.engagementWrap}>
          <MemoryEngagementBar
            memory={memory}
            onOpenComments={handleOpenComments}
            iconSize={23}
            enableShare
            currentMediaAssetId={activeAsset?.id ?? null}
            isCurrentPageVideo={activeAsset ? isVideoContentType(activeAsset.content_type) : false}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={handlePress}
          style={({ pressed }) => [styles.contentPressArea, pressed && styles.cardPressed]}
          testID={`memory-card-content-${memory.id}`}
        >
          {excerpt ? (
            <View style={styles.captionWrap}>
              <Text style={styles.caption} numberOfLines={3}>{excerpt}</Text>
            </View>
          ) : null}
          <CardFooter memory={memory} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.card} testID={`memory-card-${memory.id}`}>
      {isIllustrationHidden && onShowIllustration ? (
        <ContentHiddenNotice
          label="Reported AI illustration hidden"
          onShow={onShowIllustration}
          style={styles.hiddenIllustration}
          testID={`memory-card-${memory.id}-illustration-hidden`}
        />
      ) : <Pressable accessibilityRole="button" onPress={handlePress}>
        <IllustrationVisual memory={memory} isHidden={isIllustrationHidden} />
      </Pressable>}
      <View style={styles.engagementWrap}>
        <MemoryEngagementBar
          memory={memory}
          onOpenComments={handleOpenComments}
          iconSize={23}
          enableShare
          currentMediaAssetId={null}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={handlePress}
        style={({ pressed }) => pressed && styles.cardPressed}
      >
        {excerpt ? (
          <View style={styles.captionWrap}>
            <Text style={styles.caption} numberOfLines={3}>{excerpt}</Text>
          </View>
        ) : null}
        <CardFooter memory={memory} />
      </Pressable>
    </View>
  );
}

// ── Quote card (text_only) ────────────────────────────────────────────────────
function QuoteCard({ memory, onPress, onOpenComments }: MemoryCardProps) {
  const emo = getEmotionColors(memory.emotion);
  const excerpt = memory.content
    ? formatMemoryExcerpt(memory.content, 120, toLinkPreviewMap(memory.link_previews))
    : '';
  const handlePress = () => onPress(memory.id);
  const handleOpenComments = () => onOpenComments(memory.id);

  return (
    <View style={styles.card} testID={`memory-card-${memory.id}`}>
      {emo && <View style={[styles.quoteAccent, { backgroundColor: emo.soft }]} />}
      <Pressable
        accessibilityRole="button"
        onPress={handlePress}
        style={({ pressed }) => pressed && styles.cardPressed}
      >
        <View style={styles.quoteBody}>
          <Text style={styles.quoteText} numberOfLines={4}>{excerpt}</Text>
        </View>
      </Pressable>
      <View style={styles.engagementWrapQuote}>
        <MemoryEngagementBar
          memory={memory}
          onOpenComments={handleOpenComments}
          iconSize={23}
          enableShare
          currentMediaAssetId={null}
        />
      </View>
      <Pressable accessibilityRole="button" onPress={handlePress}>
        <CardFooter memory={memory} />
      </Pressable>
    </View>
  );
}

// ── Sound card (audio) ─────────────────────────────────────────────────────────
// The ticket-stub/inked-trace/wax-seal keepsake (design handoff: SoundCard,
// audio-kit.jsx's StubBand/StubTear) in place of SpreadCard's 4:3 visual --
// the rest of the shipped chrome (engagement row, caption, CardFooter) is
// unchanged, so this reuses those exact styles rather than duplicating them.
// No AI illustration, no media carousel, no share (server rejects it in v1
// -- docs/features/audio-memories.md).
function SoundCard({ memory, onPress, onOpenComments }: MemoryCardProps) {
  const clipAsset = memory.mediaAssets[0] ?? null;
  const clipKey = clipAsset?.object_key ?? memory.media_key ?? null;
  const { url: clipUrl } = useMediaUrl(clipKey, memory.updated_at);
  const clip = useAudioClipPlayback(clipUrl);
  // Duration comes from the DB row, not the playback hook -- the hook's own
  // `duration` is 0 until the player has actually loaded the clip, but the
  // card must show the real total immediately, before any tap (mirrors
  // ClipChip's `durationSeconds` prop in the composer, which is likewise
  // supplied from known metadata rather than derived from playback state).
  const durationSeconds = (clipAsset?.duration_ms ?? 0) / 1000;
  const excerpt = memory.content
    ? formatMemoryExcerpt(memory.content, 140, toLinkPreviewMap(memory.link_previews))
    : null;
  const handlePress = () => onPress(memory.id);
  const handleOpenComments = () => onOpenComments(memory.id);
  const handleToggle = () => void clip.toggle();
  const handleSeek = (fraction: number) => void clip.seekTo(fraction);

  return (
    <View style={styles.card} testID={`memory-card-${memory.id}`}>
      <StubBand
        durationSeconds={durationSeconds}
        emotion={memory.emotion}
        onPress={handlePress}
        onSeek={handleSeek}
        onToggle={handleToggle}
        playing={clip.playing}
        positionSeconds={clip.position}
        progress={clip.progress}
        seed={seedFromKey(memory.id)}
        testID={`memory-card-${memory.id}-stub`}
      />
      <StubTear cardColor={colors.white} />
      <View style={styles.engagementWrap}>
        <MemoryEngagementBar
          memory={memory}
          onOpenComments={handleOpenComments}
          iconSize={23}
          enableShare={false}
          currentMediaAssetId={null}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={handlePress}
        style={({ pressed }) => pressed && styles.cardPressed}
        testID={`memory-card-content-${memory.id}`}
      >
        {excerpt ? (
          <View style={styles.captionWrap}>
            <Text style={styles.caption} numberOfLines={3}>{excerpt}</Text>
          </View>
        ) : null}
        <CardFooter memory={memory} />
      </Pressable>
    </View>
  );
}

// ── Unknown-type card (forward-compat fallback, P0.1) ─────────────────────────
// Renders any `memory_type` this build doesn't recognize yet (e.g. an old
// installed client fetching a future `'audio'` row before it has updated --
// docs/plans/audio-memories-v1.md). Deliberately built on the text-style
// shell rather than falling through to SpreadCard's illustration/media
// branches, which would otherwise render an empty gray placeholder box with
// no caption and no explanation. No image area, no shimmer, and no
// tap-to-open-viewer affordance beyond the normal card press to detail.
function UnknownTypeCard({ memory, onPress, onOpenComments }: MemoryCardProps) {
  const emo = getEmotionColors(memory.emotion);
  const excerpt = memory.content
    ? formatMemoryExcerpt(memory.content, 120, toLinkPreviewMap(memory.link_previews))
    : '';
  const handlePress = () => onPress(memory.id);
  const handleOpenComments = () => onOpenComments(memory.id);

  return (
    <View style={styles.card} testID={`memory-card-${memory.id}`}>
      {emo && <View style={[styles.quoteAccent, { backgroundColor: emo.soft }]} />}
      <Pressable
        accessibilityRole="button"
        onPress={handlePress}
        style={({ pressed }) => pressed && styles.cardPressed}
        testID={`memory-card-content-${memory.id}`}
      >
        <View style={styles.quoteBody}>
          {excerpt ? (
            <Text style={styles.quoteText} numberOfLines={4}>{excerpt}</Text>
          ) : (
            <Text
              style={styles.unavailableNotice}
              testID={`memory-card-${memory.id}-unavailable`}
            >
              {UNSUPPORTED_MEMORY_TYPE_NOTICE}
            </Text>
          )}
        </View>
      </Pressable>
      <View style={styles.engagementWrapQuote}>
        <MemoryEngagementBar
          memory={memory}
          onOpenComments={handleOpenComments}
          iconSize={23}
          enableShare={false}
          currentMediaAssetId={null}
        />
      </View>
      <Pressable accessibilityRole="button" onPress={handlePress}>
        <CardFooter memory={memory} />
      </Pressable>
    </View>
  );
}

// Memoized (Workstream B1): the timeline list can hold hundreds of loaded
// rows across pages, and without this every unrelated re-render of the
// parent FlatList (e.g. a single card's video-active flag toggling) would
// re-render every other card too. Relies on the parent passing stable
// `onPress`/`onOpenComments` callbacks (id-based, see MemoryCardProps) and a
// stable `memory` object reference (cache patches only replace the changed
// row, not the whole array) for the memo comparison to actually bail out.
export const MemoryCard = memo(function MemoryCard({
  memory,
  onPress,
  onOpenComments,
  isVideoActive,
  isIllustrationHidden,
  onShowIllustration,
}: MemoryCardProps) {
  if (!isKnownMemoryType(memory.memory_type)) {
    return <UnknownTypeCard memory={memory} onPress={onPress} onOpenComments={onOpenComments} />;
  }
  if (memory.memory_type === 'text_only') {
    return <QuoteCard memory={memory} onPress={onPress} onOpenComments={onOpenComments} />;
  }
  if (memory.memory_type === 'audio') {
    return <SoundCard memory={memory} onPress={onPress} onOpenComments={onOpenComments} />;
  }
  return (
    <SpreadCard
      memory={memory}
      onPress={onPress}
      onOpenComments={onOpenComments}
      isVideoActive={isVideoActive}
      isIllustrationHidden={isIllustrationHidden}
      onShowIllustration={onShowIllustration}
    />
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cardPressed: {
    opacity: 0.94,
  },
  contentPressArea: {
    width: '100%',
  },
  engagementWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: 8,
  },
  engagementWrapQuote: {
    paddingHorizontal: 18,
    paddingTop: 4,
  },
  // Spread card
  cardImage: {
    width: '100%',
    aspectRatio: 4 / 3,
    overflow: 'hidden',
  },
  hiddenIllustration: {
    aspectRatio: 4 / 3,
    borderRadius: 0,
    borderWidth: 0,
    width: '100%',
  },
  mediaVisual: {
    width: '100%',
  },
  placeholderVisual: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  failedOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(44, 36, 24, 0.55)',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  failedOverlayText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 12,
    textAlign: 'center',
  },
  placeholderText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  captionWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: 13,
    paddingBottom: 2,
  },
  caption: {
    fontFamily: fonts.sans,
    fontSize: 14.5,
    lineHeight: 22,
    color: colors.ink,
  },
  // Quote card
  quoteAccent: {
    height: 3,
    borderRadius: radius.lg,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  quoteBody: {
    padding: 18,
    paddingBottom: 4,
  },
  quoteText: {
    fontFamily: fonts.displayItalic,
    fontSize: 22,
    lineHeight: 1.28 * 22,
    color: colors.ink,
  },
  unavailableNotice: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    lineHeight: 1.4 * 14,
    color: colors.ink3,
  },
  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingTop: 9,
    paddingBottom: 13,
  },
  footerDay: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  footerSpacer: {
    flex: 1,
  },
  avatarCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 2,
  },
  avatarCircle: {
    borderWidth: 1.5,
    borderColor: colors.white,
  },
  avatarOverflow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 11,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  avatarOverflowText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 8,
  },
  emotionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 3,
    paddingLeft: 7,
    paddingRight: 9,
    borderRadius: 999,
  },
  emotionDot: {
    width: 5,
    height: 5,
    borderRadius: 999,
  },
  emotionLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 0.02 * 10.5,
  },
  mediaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  mediaBadgeText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    color: colors.ink3,
  },
});
