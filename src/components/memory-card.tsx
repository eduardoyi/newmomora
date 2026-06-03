import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { GeneratingVisualOverlay } from '@/components/generating-visual-overlay';
import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { colors, fonts, getEmotionColors, radius, spacing } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import type { MemoryWithTags } from '@/services/memories';
import {
  formatDisplayDate,
  formatMemoryExcerpt,
  getIllustrationStatusLabel,
  isIllustrationInProgress,
  type IllustrationStatus,
} from '@/utils/memories';
import { isVideoContentType } from '@/utils/media-validation';

interface MemoryCardProps {
  memory: MemoryWithTags;
  onPress: () => void;
  isVideoActive?: boolean;
}

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
  return (
    <View style={styles.avatarCluster}>
      {members.slice(0, 3).map((m, i) => (
        <FamilyMemberAvatar
          key={m.id}
          member={m}
          size={22}
          style={[styles.avatarCircle, { marginLeft: i === 0 ? 0 : -7 }]}
        />
      ))}
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
function IllustrationVisual({ memory }: { memory: MemoryWithTags }) {
  const { url } = useMediaUrl(memory.illustration_key, memory.updated_at);
  const emo = getEmotionColors(memory.emotion);
  const status = (memory.illustration_status ?? 'pending') as IllustrationStatus;
  const showGenerating = isIllustrationInProgress(status);
  const showFailed = status === 'failed';

  if (url && !showGenerating && !showFailed) {
    return (
      <Image
        contentFit="cover"
        source={{ uri: url }}
        style={styles.cardImage}
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
            source={{ uri: url }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.failedOverlay}>
            <Text style={styles.failedOverlayText}>Illustration failed</Text>
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
function MediaVisual({ memory, isActive }: { memory: MemoryWithTags; isActive: boolean }) {
  if (memory.mediaAssets.length > 0) {
    return (
      <MemoryMediaCarousel
        assets={memory.mediaAssets}
        cacheVersion={memory.updated_at}
        isActive={isActive}
        style={styles.cardImage}
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
function SpreadCard({ memory, onPress, isVideoActive = false }: MemoryCardProps) {
  const excerpt = memory.content ? formatMemoryExcerpt(memory.content) : null;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      testID={`memory-card-${memory.id}`}
    >
      {memory.memory_type === 'text_illustration' ? (
        <IllustrationVisual memory={memory} />
      ) : (
        <MediaVisual memory={memory} isActive={isVideoActive} />
      )}
      {excerpt ? (
        <View style={styles.captionWrap}>
          <Text style={styles.caption} numberOfLines={3}>{excerpt}</Text>
        </View>
      ) : null}
      <CardFooter memory={memory} />
    </Pressable>
  );
}

// ── Quote card (text_only) ────────────────────────────────────────────────────
function QuoteCard({ memory, onPress }: MemoryCardProps) {
  const emo = getEmotionColors(memory.emotion);
  const excerpt = memory.content ? formatMemoryExcerpt(memory.content, 120) : '';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      testID={`memory-card-${memory.id}`}
    >
      {emo && <View style={[styles.quoteAccent, { backgroundColor: emo.soft }]} />}
      <View style={styles.quoteBody}>
        <Text style={styles.quoteText} numberOfLines={4}>{excerpt}</Text>
      </View>
      <CardFooter memory={memory} />
    </Pressable>
  );
}

export function MemoryCard({ memory, onPress, isVideoActive }: MemoryCardProps) {
  if (memory.memory_type === 'text_only') {
    return <QuoteCard memory={memory} onPress={onPress} />;
  }
  return <SpreadCard memory={memory} onPress={onPress} isVideoActive={isVideoActive} />;
}

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
  // Spread card
  cardImage: {
    width: '100%',
    aspectRatio: 4 / 3,
    overflow: 'hidden',
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
