import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { FamilyActivityEvent, FamilyActivityGroup } from '@/services/family-activity';
import { formatEngagementTimestamp } from '@/utils/engagement';
import { buildFamilyActivityCopy, familyActivityCopyPlainText } from '@/utils/family-activity-copy';
import { mediaImageSource } from '@/utils/media-image-source';

const THUMBNAIL_SIZE = 44;
const MAX_THUMBNAILS = 3;

// Illustration first, then the cover's list-sized preview (photo) or poster
// (video), then the original -- but never a video original, which
// expo-image can't render as a still.
function resolveThumbnailKey(event: FamilyActivityEvent): string | null {
  if (event.memoryIllustrationKey) return event.memoryIllustrationKey;
  if (event.memoryMediaPreviewKey) return event.memoryMediaPreviewKey;
  if (event.memoryMediaContentType?.startsWith('video/')) return null;
  return event.memoryMediaKey ?? null;
}

export function collectThumbnailKeys(events: FamilyActivityEvent[]): string[] {
  const seenMemoryIds = new Set<string>();
  const keys: string[] = [];
  for (const event of events) {
    if (!event.memoryId || seenMemoryIds.has(event.memoryId)) continue;
    seenMemoryIds.add(event.memoryId);
    const key = resolveThumbnailKey(event);
    if (key) keys.push(key);
    if (keys.length >= MAX_THUMBNAILS) break;
  }
  return keys;
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
  const hasMemory = Boolean(primaryEvent.memoryId);
  const thumbnailKeys = collectThumbnailKeys(group.events);
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
      {hasMemory ? (
        <View style={styles.thumbnailStack}>
          {thumbnailKeys.length > 0 ? (
            thumbnailKeys.map((key, index) => {
              const url = mediaUrls[key];
              return url ? (
                <Image
                  key={key}
                  contentFit="cover"
                  source={mediaImageSource(url, key)}
                  style={[
                    styles.thumbnail,
                    index > 0 && styles.thumbnailStacked,
                    { zIndex: thumbnailKeys.length - index },
                  ]}
                />
              ) : (
                <View
                  key={key}
                  style={[
                    styles.thumbnail,
                    styles.thumbnailPlaceholder,
                    index > 0 && styles.thumbnailStacked,
                    { zIndex: thumbnailKeys.length - index },
                  ]}
                />
              );
            })
          ) : (
            <View style={[styles.thumbnail, styles.thumbnailPlaceholder]} />
          )}
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
    backgroundColor: colors.surface,
    borderColor: colors.white,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    height: THUMBNAIL_SIZE,
    width: THUMBNAIL_SIZE,
  },
  thumbnailStacked: { marginLeft: -18 },
  thumbnailPlaceholder: { backgroundColor: colors.surface },
});
