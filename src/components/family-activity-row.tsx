import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import type { FamilyActivityEvent, FamilyActivityGroup } from '@/services/family-activity';
import { formatEngagementTimestamp } from '@/utils/engagement';
import { buildFamilyActivityCopy, familyActivityCopyPlainText } from '@/utils/family-activity-copy';
import { mediaImageSource } from '@/utils/media-image-source';

const THUMBNAIL_SIZE = 44;
const MAX_THUMBNAILS = 3;

function resolveThumbnailKey(event: FamilyActivityEvent): string | null {
  return event.memoryIllustrationKey ?? event.memoryMediaKey ?? null;
}

function collectThumbnailKeys(events: FamilyActivityEvent[]): string[] {
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
  onPress: () => void;
}

export function FamilyActivityRow({ group, onPress }: FamilyActivityRowProps) {
  const primaryEvent = group.events[0];
  const copy = buildFamilyActivityCopy(group);
  const label = familyActivityCopyPlainText(copy);
  const hasMemory = Boolean(primaryEvent.memoryId);
  const thumbnailKeys = collectThumbnailKeys(group.events);
  const { data: mediaUrls } = useMediaUrls(thumbnailKeys);
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
              const url = mediaUrls?.[key];
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
