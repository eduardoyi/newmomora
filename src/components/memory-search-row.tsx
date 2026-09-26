import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MemoryFallbackTile } from '@/components/memory-fallback-tile';
import { colors, fonts, getEmotionColors, radius, spacing } from '@/constants/theme';
import type { MemorySearchMatch, MemoryWithTags } from '@/services/memories';
import { formatIsoDateForDisplay } from '@/utils/dates';
import { mediaImageSource } from '@/utils/media-image-source';
import { highlightSearchMatches, searchResultText, type SearchResultThumbnail } from '@/utils/memory-search';

const THUMBNAIL_SIZE = 52;

// Why a text search matched, when the words people wrote don't show it.
const MATCH_NOTES: Partial<Record<MemorySearchMatch, string>> = {
  voice: 'Matched what was said',
  details: "Matched what's in the picture",
};

interface MemorySearchRowProps {
  memory: MemoryWithTags;
  matchedIn: MemorySearchMatch | null;
  query: string;
  thumbnail: SearchResultThumbnail;
  /** Signed URL for thumbnail.key, from the screen's batched lookup. */
  thumbnailUrl: string | undefined;
  onPress: (memoryId: string) => void;
}

export const MemorySearchRow = memo(function MemorySearchRow({
  memory,
  matchedIn,
  query,
  thumbnail,
  thumbnailUrl,
  onPress,
}: MemorySearchRowProps) {
  const text = searchResultText(memory);
  const segments = highlightSearchMatches(text, query);
  const note = matchedIn ? MATCH_NOTES[matchedIn] : undefined;
  const emo = getEmotionColors(memory.emotion);
  const people = memory.taggedMembers.map((member) => member.name).join(', ');
  const date = formatIsoDateForDisplay(memory.memory_date);

  return (
    <Pressable
      accessibilityLabel={`${date}. ${text}`}
      accessibilityRole="button"
      onPress={() => onPress(memory.id)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`memory-search-row-${memory.id}`}
    >
      <View style={styles.thumbnail}>
        {thumbnail.key ? (
          thumbnailUrl ? (
            <Image
              contentFit="cover"
              source={mediaImageSource(thumbnailUrl, thumbnail.key)}
              style={StyleSheet.absoluteFill}
              testID={`memory-search-row-${memory.id}-image`}
            />
          ) : null
        ) : (
          <MemoryFallbackTile
            emotion={memory.emotion}
            kind={thumbnail.fallback}
            memoryId={memory.id}
            size={THUMBNAIL_SIZE}
            testID={`memory-search-row-${memory.id}-tile`}
          />
        )}
      </View>
      <View style={styles.body}>
        <View style={styles.metaRow}>
          {emo ? <View style={[styles.emotionDot, { backgroundColor: emo.c }]} /> : null}
          <Text numberOfLines={1} style={styles.meta}>
            {date}{people ? ` · ${people}` : ''}
          </Text>
        </View>
        <Text numberOfLines={2} style={styles.text}>
          {segments.map((segment, index) => (
            <Text key={index} style={segment.match ? styles.match : undefined}>{segment.text}</Text>
          ))}
        </Text>
        {note ? <Text style={styles.note} testID={`memory-search-row-${memory.id}-note`}>{note}</Text> : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
  },
  rowPressed: { opacity: 0.82 },
  thumbnail: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    height: THUMBNAIL_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: THUMBNAIL_SIZE,
  },
  body: { flex: 1, minWidth: 0 },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 6, marginBottom: 2 },
  emotionDot: { borderRadius: 3.5, height: 7, width: 7 },
  meta: { color: colors.ink3, flexShrink: 1, fontFamily: fonts.sansMedium, fontSize: 12 },
  text: { color: colors.ink, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 20 },
  match: { backgroundColor: colors.primaryTint, color: colors.primaryDark, fontFamily: fonts.sansBold },
  note: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, fontStyle: 'italic', marginTop: 2 },
});
