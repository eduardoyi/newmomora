import { Image } from 'expo-image';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  type ViewToken,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MemoryFab } from '@/components/memory-fab';
import { PendingMemoryUploadsBanner } from '@/components/pending-memory-uploads-banner';
import { colors, fonts, getEmotionColors, radius, spacing } from '@/constants/theme';
import { useCalendarMemoriesInRange, useOldestMemoryDate } from '@/hooks/useCalendarMemories';
import { useFamily } from '@/hooks/use-family';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { useVideoThumbnail } from '@/hooks/useVideoThumbnail';
import { memoryDetailRoute, newMemoryRoute } from '@/lib/routes';
import type { MemoryWithTags } from '@/services/memories';
import { substituteLinkLabels, toLinkPreviewMap } from '@/utils/links';
import { canEditFamilyContent } from '@/utils/roles';
import {
  buildCalendarWeeks,
  getCalendarFetchRange,
  type CalendarDay,
  type CalendarWeek,
  type CalendarVisibleWeekRange,
} from '@/utils/calendar';

const CALENDAR_FETCH_BUFFER_WEEKS = 4;
const INITIAL_VISIBLE_WEEK_RANGE: CalendarVisibleWeekRange = { startIndex: 0, endIndex: 3 };

type RibbonCalendarDay = CalendarDay & {
  memory: MemoryWithTags | undefined;
};

function MemoryStamp({ memory }: { memory: MemoryWithTags }) {
  const emo = getEmotionColors(memory.emotion);
  const isMedia = memory.memory_type === 'media';
  const coverAsset = memory.mediaAssets[0];
  const isVideo = coverAsset ? coverAsset.content_type.startsWith('video/') : isMedia && memory.media_content_type?.startsWith('video/');

  const { url: illustrationUrl } = useMediaUrl(
    memory.memory_type === 'text_illustration' ? (memory.illustration_key ?? null) : null,
    memory.updated_at,
  );
  const { url: mediaUrl } = useMediaUrl(
    isMedia && !isVideo ? (coverAsset?.object_key ?? memory.media_key ?? null) : null,
    memory.updated_at,
  );
  const { url: videoUrl } = useMediaUrl(
    isVideo ? (coverAsset?.object_key ?? memory.media_key ?? null) : null,
    memory.updated_at,
  );
  const videoThumbnail = useVideoThumbnail(videoUrl);

  if (memory.memory_type === 'text_illustration' && illustrationUrl) {
    return (
      <Image
        source={{ uri: illustrationUrl }}
        style={styles.stamp}
        contentFit="cover"
      />
    );
  }

  if (memory.memory_type === 'text_only') {
    return (
      <View style={[styles.stamp, { backgroundColor: emo?.soft ?? colors.surface }]}>
        <Text style={[styles.stampQuote, { color: emo?.ink ?? colors.ink3 }]}>“</Text>
      </View>
    );
  }

  const displayUri = isVideo ? videoThumbnail : mediaUrl;
  if (isMedia && displayUri) {
    return (
      <View style={styles.stamp}>
        <Image source={{ uri: displayUri }} style={styles.stamp} contentFit="cover" />
        {isVideo && (
          <View style={styles.stampPlayOverlay}>
            <SymbolView
              name={{ ios: 'play.fill', android: 'play_arrow' }}
              size={14}
              tintColor={colors.white}
              fallback={<Text style={{ fontSize: 12, color: colors.white }}>▶</Text>}
            />
          </View>
        )}
        {memory.mediaAssets.length > 1 && (
          <View style={styles.stampCountBadge}>
            <Text style={styles.stampCountText}>{memory.mediaAssets.length}</Text>
          </View>
        )}
      </View>
    );
  }

  // fallback: illustration pending or media not yet loaded
  const isTextIllustration = memory.memory_type === 'text_illustration';
  return (
    <View style={[styles.stamp, { backgroundColor: isTextIllustration ? (emo?.soft ?? colors.surface) : '#ddc9a8', alignItems: 'center', justifyContent: 'center' }]}>
      {isTextIllustration ? (
        <Text style={styles.stampIcon}>✦</Text>
      ) : (
        <SymbolView
          name={{ ios: isVideo ? 'video' : 'camera', android: isVideo ? 'videocam' : 'photo_camera' }}
          size={20}
          tintColor={colors.ink3}
          fallback={<Text style={styles.stampIcon}>{isVideo ? '▶' : '📷'}</Text>}
        />
      )}
    </View>
  );
}

function RibbonDay({
  day,
  onPress,
}: {
  day: RibbonCalendarDay;
  onPress: (m: MemoryWithTags) => void;
}) {
  const hasMemory = !!day.memory;
  const emo = getEmotionColors(day.memory?.emotion);

  return (
    <Pressable
      disabled={!hasMemory}
      onPress={() => day.memory && onPress(day.memory)}
      style={[styles.ribbonDay, day.today && styles.ribbonDayToday]}
    >
      {/* Day label */}
      <View style={styles.ribbonDayMeta}>
        <Text style={[styles.ribbonDow, day.today && styles.ribbonDowToday]}>{day.dow}</Text>
        <Text style={[styles.ribbonDate, day.today && styles.ribbonDateToday]}>{day.n}</Text>
      </View>

      {/* Stamp or empty state */}
      {hasMemory && day.memory ? (
        <>
          <MemoryStamp memory={day.memory} />
          <View style={styles.ribbonText}>
            {day.memory.content ? (
              <Text style={styles.ribbonCaption} numberOfLines={1}>
                {substituteLinkLabels(day.memory.content, toLinkPreviewMap(day.memory.link_previews))}
              </Text>
            ) : (
              <View style={styles.ribbonMediaLabel}>
                <Text style={styles.ribbonMediaText}>
                  {day.memory.mediaAssets.length > 1
                    ? 'Media'
                    : day.memory.media_content_type?.startsWith('video/')
                      ? 'Video'
                      : 'Photo'}
                </Text>
              </View>
            )}
            {day.memory.emotion && emo && (
              <View style={[styles.emotionChip, { backgroundColor: emo.soft }]}>
                <View style={[styles.emotionDot, { backgroundColor: emo.c }]} />
                <Text style={[styles.emotionLabel, { color: emo.ink }]}>{day.memory.emotion}</Text>
              </View>
            )}
          </View>
        </>
      ) : (
        <View style={[styles.emptySlot, day.today && styles.emptySlotToday]}>
          {day.today && <Text style={styles.emptySlotText}>+ capture today</Text>}
        </View>
      )}
    </Pressable>
  );
}

export default function CalendarScreen() {
  const { role } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const referenceDateRef = useRef(new Date());
  const [visibleWeekRange, setVisibleWeekRange] = useState(INITIAL_VISIBLE_WEEK_RANGE);
  const {
    data: oldestMemoryDate,
    isRefetching: isOldestMemoryDateRefetching,
    refetch: refetchOldestMemoryDate,
  } = useOldestMemoryDate();
  const weeks = useMemo(
    () => buildCalendarWeeks({
      referenceDate: referenceDateRef.current,
      oldestMemoryDate,
      minimumWeeks: 4,
    }),
    [oldestMemoryDate],
  );
  const fetchRange = useMemo(
    () => getCalendarFetchRange(weeks, visibleWeekRange, CALENDAR_FETCH_BUFFER_WEEKS),
    [visibleWeekRange, weeks],
  );
  const {
    data: memories = [],
    isRefetching: isCalendarMemoriesRefetching,
    refetch: refetchCalendarMemories,
  } = useCalendarMemoriesInRange(fetchRange);
  const memoriesByDate = useMemo(() => {
    const map = new Map<string, MemoryWithTags>();

    for (const memory of memories) {
      if (!map.has(memory.memory_date)) {
        map.set(memory.memory_date, memory);
      }
    }

    return map;
  }, [memories]);

  const monthYear = referenceDateRef.current.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  const isRefetching = isOldestMemoryDateRefetching || isCalendarMemoriesRefetching;

  const handleRefresh = useCallback(() => {
    void Promise.all([refetchOldestMemoryDate(), refetchCalendarMemories()]);
  }, [refetchCalendarMemories, refetchOldestMemoryDate]);

  const handleViewableItemsChanged = useRef((info: { viewableItems: ViewToken[] }) => {
    const indices = info.viewableItems
      .map((item) => item.index)
      .filter((index): index is number => typeof index === 'number');

    if (indices.length === 0) {
      return;
    }

    const startIndex = Math.min(...indices);
    const endIndex = Math.max(...indices);

    setVisibleWeekRange((current) => {
      if (current.startIndex === startIndex && current.endIndex === endIndex) {
        return current;
      }

      return { startIndex, endIndex };
    });
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 15 }).current;

  const renderHeader = useCallback(() => (
    <SafeAreaView>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>{monthYear}</Text>
        <Text style={styles.title}>Backwards.</Text>
        <Text style={styles.subtitle}>Each row is a moment. Scroll to walk back in time.</Text>
      </View>
      <PendingMemoryUploadsBanner />
    </SafeAreaView>
  ), [monthYear]);

  const renderWeek = useCallback(({ item: week }: ListRenderItemInfo<CalendarWeek>) => (
    <View style={styles.week}>
      <Text style={styles.weekLabel}>{week.label}</Text>
      <View style={styles.weekDays}>
        {week.days.map((day) => (
          <RibbonDay
            key={day.iso}
            day={{ ...day, memory: memoriesByDate.get(day.iso) }}
            onPress={(memory) => router.push(memoryDetailRoute(memory.id))}
          />
        ))}
      </View>
    </View>
  ), [memoriesByDate]);

  return (
    <View style={styles.container}>
      <FlatList
        data={weeks}
        keyExtractor={(week) => week.startIso}
        renderItem={renderWeek}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.scrollContent}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        onViewableItemsChanged={handleViewableItemsChanged}
        removeClippedSubviews
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
        }
        viewabilityConfig={viewabilityConfig}
        windowSize={7}
      />

      {canEdit && <MemoryFab onPress={() => router.push(newMemoryRoute)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    paddingBottom: 130,
  },
  header: {
    paddingTop: 16,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: 8,
  },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  title: {
    fontFamily: fonts.displayItalic,
    fontSize: 48,
    lineHeight: 48,
    color: colors.ink,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.ink3,
    lineHeight: 21,
  },
  week: {
    marginBottom: 28,
  },
  weekLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
    paddingHorizontal: spacing.lg,
    marginBottom: 12,
  },
  weekDays: {
    paddingHorizontal: spacing.md,
    gap: 6,
  },
  ribbonDay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.lg,
  },
  ribbonDayToday: {
    backgroundColor: colors.primaryTint,
  },
  ribbonDayMeta: {
    width: 44,
    alignItems: 'center',
  },
  ribbonDow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.1 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  ribbonDowToday: {
    color: colors.primary,
  },
  ribbonDate: {
    fontFamily: fonts.displayMedium,
    fontSize: 24,
    lineHeight: 26,
    color: colors.ink2,
    marginTop: 2,
  },
  ribbonDateToday: {
    color: colors.primary,
  },
  stamp: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  stampPlayOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.30)',
  },
  stampCountBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 9,
    height: 18,
    justifyContent: 'center',
    position: 'absolute',
    right: 4,
    top: 4,
    minWidth: 18,
  },
  stampCountText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    paddingHorizontal: 5,
  },
  stampIcon: {
    fontSize: 20,
    color: colors.ink3,
  },
  stampQuote: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 34,
    opacity: 0.45,
  },
  ribbonText: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  ribbonCaption: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    lineHeight: 19,
    color: colors.ink,
  },
  ribbonMediaLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  ribbonMediaText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.ink3,
  },
  emotionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingLeft: 6,
    paddingRight: 8,
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
  },
  emptySlot: {
    flex: 1,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    justifyContent: 'center',
    paddingLeft: 14,
  },
  emptySlotToday: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: colors.primary + '40',
    borderStyle: 'dashed',
  },
  emptySlotText: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    color: colors.primary,
  },
});
