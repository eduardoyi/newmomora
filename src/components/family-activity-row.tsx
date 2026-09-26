import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { seedFromKey } from '@/components/audio/audio-seed';
import { SoundTile } from '@/components/audio/sound-tile';
import { colors, fonts, getEmotionColors, radius, spacing } from '@/constants/theme';
import type { FamilyActivityEvent, FamilyActivityGroup } from '@/services/family-activity';
import { formatEngagementTimestamp } from '@/utils/engagement';
import { buildFamilyActivityCopy, familyActivityCopyPlainText } from '@/utils/family-activity-copy';
import { mediaImageSource } from '@/utils/media-image-source';

const THUMBNAIL_SIZE = 44;
const MAX_THUMBNAILS = 3;

// Illustration first, then the cover's list-sized preview (photo) or poster
// (video), then an image original -- never a video or audio original, which
// expo-image can't render as a still.
function resolveThumbnailKey(event: FamilyActivityEvent): string | null {
  if (event.memoryIllustrationKey) return event.memoryIllustrationKey;
  if (event.memoryMediaPreviewKey) return event.memoryMediaPreviewKey;
  if (!event.memoryMediaContentType?.startsWith('image/')) return null;
  return event.memoryMediaKey ?? null;
}

type ThumbnailFallback = 'quote' | 'sound' | 'blank';

interface ActivityThumbnail {
  memoryId: string;
  key: string | null;
  // What to draw when there is no image key -- the same type-aware tiles the
  // calendar stamp and member-profile thumb use.
  fallback: ThumbnailFallback;
  emotion: string | null;
}

function resolveThumbnailFallback(event: FamilyActivityEvent): ThumbnailFallback {
  if (event.memoryType === 'audio' || event.memoryMediaContentType?.startsWith('audio/')) return 'sound';
  // text_only, or a text_illustration whose illustration hasn't landed.
  if (event.memoryType === 'text_only' || event.memoryType === 'text_illustration') return 'quote';
  // Older server without memory_type: a memory with no media at all is text.
  if (!event.memoryType && !event.memoryMediaKey) return 'quote';
  return 'blank';
}

function collectThumbnails(events: FamilyActivityEvent[]): ActivityThumbnail[] {
  const seenMemoryIds = new Set<string>();
  const thumbnails: ActivityThumbnail[] = [];
  for (const event of events) {
    if (!event.memoryId || seenMemoryIds.has(event.memoryId)) continue;
    seenMemoryIds.add(event.memoryId);
    thumbnails.push({
      memoryId: event.memoryId,
      key: resolveThumbnailKey(event),
      fallback: resolveThumbnailFallback(event),
      emotion: event.memoryEmotion,
    });
    if (thumbnails.length >= MAX_THUMBNAILS) break;
  }
  return thumbnails;
}

export function collectThumbnailKeys(events: FamilyActivityEvent[]): string[] {
  return collectThumbnails(events).flatMap((thumbnail) => (thumbnail.key ? [thumbnail.key] : []));
}

function ThumbnailFallbackTile({ thumbnail }: { thumbnail: ActivityThumbnail }) {
  if (thumbnail.fallback === 'sound') {
    return (
      <SoundTile
        durationSeconds={0}
        emotion={thumbnail.emotion}
        seed={seedFromKey(thumbnail.memoryId)}
        showDuration={false}
        size={THUMBNAIL_SIZE - 3}
        testID={`family-activity-thumbnail-${thumbnail.memoryId}-sound`}
      />
    );
  }
  if (thumbnail.fallback === 'quote') {
    const emo = getEmotionColors(thumbnail.emotion);
    return (
      <View
        style={[styles.fallbackFill, { backgroundColor: emo?.soft ?? colors.surface }]}
        testID={`family-activity-thumbnail-${thumbnail.memoryId}-quote`}
      >
        <Text style={[styles.quoteMark, { color: emo?.ink ?? colors.ink3 }]}>“</Text>
      </View>
    );
  }
  return null;
}

interface FamilyActivityRowProps {
  group: FamilyActivityGroup;
  /** Signed URLs for every row's thumbnails, fetched once by the sheet (see
   * useBatchedMediaUrls) rather than one request per row. */
  mediaUrls: Record<string, string>;
  onPress: () => void;
}

export function FamilyActivityRow({ group, mediaUrls, onPress }: FamilyActivityRowProps) {
  const primaryEvent = group.events[0];
  const copy = buildFamilyActivityCopy(group);
  const label = familyActivityCopyPlainText(copy);
  const thumbnails = collectThumbnails(group.events);
  const mutedLine =
    primaryEvent.kind === 'memory_commented' ? primaryEvent.commentSnippet : primaryEvent.memoryExcerpt;

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`family-activity-row-${group.id}`}
    >
      <View style={styles.textBlock}>
        <Text style={styles.sentence}>
          {copy.segments.map((segment, index) => (
            <Text
              key={index}
              style={segment.bold ? styles.sentenceBold : styles.sentenceRegular}
            >
              {segment.text}
            </Text>
          ))}
        </Text>
        {mutedLine ? (
          <Text numberOfLines={1} style={styles.mutedLine}>
            {mutedLine}
          </Text>
        ) : null}
        <Text style={styles.timestamp}>{formatEngagementTimestamp(group.createdAt)}</Text>
        {group.kind === 'member_pending' ? (
          <View style={styles.reviewPill} testID={`family-activity-row-${group.id}-review`}>
            <Text style={styles.reviewPillText}>Review</Text>
          </View>
        ) : null}
      </View>
      {thumbnails.length > 0 ? (
        <View style={styles.thumbnailStack}>
          {thumbnails.map((thumbnail, index) => {
            const url = thumbnail.key ? mediaUrls[thumbnail.key] : undefined;
            return (
              <View
                key={thumbnail.memoryId}
                style={[
                  styles.thumbnail,
                  index > 0 && styles.thumbnailStacked,
                  { zIndex: thumbnails.length - index },
                ]}
              >
                {thumbnail.key ? (
                  url ? (
                    <Image
                      contentFit="cover"
                      source={mediaImageSource(url, thumbnail.key)}
                      style={StyleSheet.absoluteFill}
                    />
                  ) : null
                ) : (
                  <ThumbnailFallbackTile thumbnail={thumbnail} />
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 11,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  rowPressed: { opacity: 0.82 },
  textBlock: { flex: 1, minWidth: 0 },
  sentence: { color: colors.ink, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  sentenceBold: { fontFamily: fonts.sansBold },
  sentenceRegular: { fontFamily: fonts.sans },
  mutedLine: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12.5, marginTop: 2 },
  timestamp: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 11, marginTop: 4 },
  reviewPill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primaryTint,
    borderRadius: radius.pill,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  reviewPillText: { color: colors.primaryDark, fontFamily: fonts.sansBold, fontSize: 11.5 },
  thumbnailStack: { flexDirection: 'row' },
  thumbnail: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.white,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    height: THUMBNAIL_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: THUMBNAIL_SIZE,
  },
  thumbnailStacked: { marginLeft: -18 },
  fallbackFill: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  // Member-profile thumbQuote (54px thumb), scaled to 44px.
  quoteMark: { fontFamily: fonts.display, fontSize: 26, lineHeight: 26, marginTop: -3, opacity: 0.45 },
});
