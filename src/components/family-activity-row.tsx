import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MemoryFallbackTile } from '@/components/memory-fallback-tile';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { FamilyActivityEvent, FamilyActivityGroup } from '@/services/family-activity';
import { formatEngagementTimestamp } from '@/utils/engagement';
import { buildFamilyActivityCopy, familyActivityCopyPlainText } from '@/utils/family-activity-copy';
import { mediaImageSource } from '@/utils/media-image-source';
import { memoryFallbackKind, type MemoryFallbackKind } from '@/utils/memory-fallback';

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


interface ActivityThumbnail {
  memoryId: string;
  key: string | null;
  // What to draw when there is no image key -- the same type-aware tiles the
  // calendar stamp and member-profile thumb use.
  fallback: MemoryFallbackKind;
  emotion: string | null;
}

function resolveThumbnailFallback(event: FamilyActivityEvent): MemoryFallbackKind {
  // Older server without memory_type: a memory with no media at all is text.
  if (!event.memoryType && !event.memoryMediaKey) return 'quote';
  return memoryFallbackKind(event.memoryType, event.memoryMediaContentType);
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
                  <MemoryFallbackTile
                    emotion={thumbnail.emotion}
                    kind={thumbnail.fallback}
                    memoryId={thumbnail.memoryId}
                    size={THUMBNAIL_SIZE - 3}
                    testID={`family-activity-thumbnail-${thumbnail.memoryId}`}
                  />
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
});
