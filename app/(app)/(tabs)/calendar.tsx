import { Image } from 'expo-image';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  type ViewToken,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CalendarMonthPickerSheet } from '@/components/calendar-month-picker-sheet';
import { MemoryFab } from '@/components/memory-fab';
import { PendingMemoryUploadsBanner } from '@/components/pending-memory-uploads-banner';
import { colors, fonts, getEmotionColors, radius, spacing } from '@/constants/theme';
import { useCalendarMemoriesInRange, useOldestMemoryDate } from '@/hooks/useCalendarMemories';
import { useFamily } from '@/hooks/use-family';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { useVideoThumbnail } from '@/hooks/useVideoThumbnail';
import { memoryDetailRoute, newMemoryRoute } from '@/lib/routes';
import type { MemoryWithTags } from '@/services/memories';
import { substituteLinkLabels, toLinkPreviewMap } from '@/utils/links';
import { resolvePreferredCoverKey, resolveVideoPosterKey } from '@/utils/media-preview';
import { canEditFamilyContent } from '@/utils/roles';
import {
  buildCalendarWeekOffsets,
  buildCalendarWeeks,
  getCalendarFetchRange,
  getCalendarItemLayout,
  getCalendarMonthOptions,
  getMonthJumpWeekIndex,
  getVisibleMonthLabel,
  measureCalendarWeekOffset,
  resolveCalendarJumpCorrection,
  startCalendarJumpCorrection,
  type CalendarDay,
  type CalendarJumpCorrection,
  type CalendarMonthOption,
  type CalendarWeek,
  type CalendarVisibleWeekRange,
  type MeasurableWeekView,
} from '@/utils/calendar';

const CALENDAR_FETCH_BUFFER_WEEKS = 4;
const INITIAL_VISIBLE_WEEK_RANGE: CalendarVisibleWeekRange = { startIndex: 0, endIndex: 3 };
// Static estimate of the in-list header (title + subtitle block) used for
// getItemLayout offsets until its real height is measured via onLayout:
// paddingTop 4 + title lineHeight 48 + gap 8 + subtitle lineHeight 21 +
// paddingBottom 24.
const ESTIMATED_LIST_HEADER_HEIGHT = 105;
// Fallback settle signal for the post-jump correction pass: corrective
// (non-animated) scrolls never emit onMomentumScrollEnd, and an animated
// scrollToIndex that turns out to be a no-op doesn't either.
const JUMP_SETTLE_TIMEOUT_MS = 700;
// "Away from the current week" for the contextual Today button: the topmost
// visible row is week index 0 ("this week") while browsing the present, so
// any greater index means the user has scrolled into history and the
// shortcut back to today becomes useful.
const TODAY_BUTTON_VISIBLE_THRESHOLD = 0;
const TODAY_BUTTON_ENTERING = FadeIn.duration(160);

type RibbonCalendarDay = CalendarDay & {
  memory: MemoryWithTags | undefined;
};

function MemoryStamp({
  memory,
  isIllustrationHidden,
  onShowIllustration,
}: {
  memory: MemoryWithTags;
  isIllustrationHidden: boolean;
  onShowIllustration: () => void;
}) {
  const emo = getEmotionColors(memory.emotion);
  const isMedia = memory.memory_type === 'media';
  const coverAsset = memory.mediaAssets[0];
  const isVideo = coverAsset ? coverAsset.content_type.startsWith('video/') : isMedia && memory.media_content_type?.startsWith('video/');

  const { url: illustrationUrl } = useMediaUrl(
    memory.memory_type === 'text_illustration' && !isIllustrationHidden
      ? (memory.illustration_key ?? null)
      : null,
    memory.updated_at,
  );
  const { url: mediaUrl } = useMediaUrl(
    // Prefers the derived preview key (Workstream C6); falls back to the
    // original when absent (legacy row, no-upscale guard, failed upload).
    isMedia && !isVideo ? resolvePreferredCoverKey(coverAsset, memory.media_key) : null,
    memory.updated_at,
  );
  const posterKey = isVideo ? resolveVideoPosterKey(coverAsset) : null;
  const { url: posterUrl } = useMediaUrl(posterKey, memory.updated_at);
  const { url: videoUrl } = useMediaUrl(
    // Only fetch the actual video file when there's no stored poster --
    // avoids a full ranged fetch + native decode purely to render a
    // paused-state thumbnail.
    isVideo && !posterKey ? (coverAsset?.object_key ?? memory.media_key ?? null) : null,
    memory.updated_at,
  );
  const runtimeVideoThumbnail = useVideoThumbnail(videoUrl);
  const videoThumbnail = posterUrl ?? runtimeVideoThumbnail;

  if (memory.memory_type === 'text_illustration' && isIllustrationHidden) {
    return (
      <Pressable
        accessibilityLabel="Show reported AI illustration"
        accessibilityRole="button"
        onPress={(event) => {
          event.stopPropagation();
          onShowIllustration();
        }}
        style={[styles.stamp, styles.hiddenStamp]}
        testID={`calendar-memory-${memory.id}-illustration-show`}
      >
        <Text style={styles.hiddenStampText}>Show</Text>
      </Pressable>
    );
  }

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
  isMemoryHidden,
  isIllustrationHidden,
  onShowMemory,
  onShowIllustration,
}: {
  day: RibbonCalendarDay;
  onPress: (m: MemoryWithTags) => void;
  isMemoryHidden: boolean;
  isIllustrationHidden: boolean;
  onShowMemory: () => void;
  onShowIllustration: () => void;
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
        isMemoryHidden ? (
          <Pressable
            accessibilityRole="button"
            onPress={(event) => {
              event.stopPropagation();
              onShowMemory();
            }}
            style={styles.hiddenMemoryRow}
            testID={`calendar-memory-${day.memory.id}-hidden`}
          >
            <Text style={styles.hiddenMemoryText}>Reported memory hidden · Show anyway</Text>
          </Pressable>
        ) : (
        <>
          <MemoryStamp
            isIllustrationHidden={isIllustrationHidden}
            memory={day.memory}
            onShowIllustration={onShowIllustration}
          />
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
        )
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
  const contentSafety = useContentSafety();
  const referenceDateRef = useRef(new Date());
  const flatListRef = useRef<FlatList<CalendarWeek>>(null);
  const [visibleWeekRange, setVisibleWeekRange] = useState(INITIAL_VISIBLE_WEEK_RANGE);
  const [isMonthPickerVisible, setIsMonthPickerVisible] = useState(false);
  // Real row heights measured via onLayout, keyed by week startIso. RN skips
  // its own cell measurement when getItemLayout is provided, so these are
  // the only real-pixel data the height model ever gets -- they make
  // getItemLayout (and therefore viewability + the post-jump correction
  // pass) precise for every week that has rendered at least once.
  const measuredWeekHeightsRef = useRef(new Map<string, number>());
  const [measuredHeightsVersion, setMeasuredHeightsVersion] = useState(0);
  const measurementFlushScheduledRef = useRef(false);
  const [listHeaderHeight, setListHeaderHeight] = useState(ESTIMATED_LIST_HEADER_HEIGHT);
  // Rendered week row instances, keyed by startIso -- the correction pass
  // measures the target row's TRUE content position through these.
  const weekViewRefsRef = useRef(new Map<string, MeasurableWeekView>());
  const pendingJumpCorrectionRef = useRef<CalendarJumpCorrection | null>(null);
  const jumpSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // Mirror for callbacks that outlive a render (the settle timer) without
  // re-arming them when `weeks` rebuilds.
  const weeksRef = useRef(weeks);
  useEffect(() => {
    weeksRef.current = weeks;
  }, [weeks]);
  const fetchRange = useMemo(
    () => getCalendarFetchRange(weeks, visibleWeekRange, CALENDAR_FETCH_BUFFER_WEEKS),
    [visibleWeekRange, weeks],
  );
  const {
    data: memories = [],
    isRefetching: isCalendarMemoriesRefetching,
    refetch: refetchCalendarMemories,
  } = useCalendarMemoriesInRange(fetchRange);
  const visibleMemories = useMemo(
    () => memories.filter((memory) =>
      !contentSafety.isUserBlocked(memory.user_id)
    ),
    [contentSafety, memories],
  );
  const memoriesByDate = useMemo(() => {
    const map = new Map<string, MemoryWithTags>();

    for (const memory of visibleMemories) {
      if (!map.has(memory.memory_date)) {
        map.set(memory.memory_date, memory);
      }
    }

    return map;
  }, [visibleMemories]);

  // The topmost visible row drives both the header label and the Today
  // button below -- keyed off only the start index (not the whole range) so
  // neither recomputes as the bottom of the visible window shifts without
  // the top row changing, which is what keeps the label from flickering.
  const topVisibleWeekIndex = Math.max(
    0,
    Math.min(visibleWeekRange.startIndex, visibleWeekRange.endIndex),
  );
  const visibleMonthLabel = useMemo(
    () => getVisibleMonthLabel(weeks, { startIndex: topVisibleWeekIndex, endIndex: topVisibleWeekIndex }),
    [weeks, topVisibleWeekIndex],
  );
  const showTodayButton = topVisibleWeekIndex > TODAY_BUTTON_VISIBLE_THRESHOLD;
  const isRefetching = isOldestMemoryDateRefetching || isCalendarMemoriesRefetching;

  const monthOptions = useMemo(
    () => getCalendarMonthOptions(referenceDateRef.current, oldestMemoryDate),
    [oldestMemoryDate],
  );
  // With no memories yet, getCalendarMonthOptions returns only the current
  // month -- nothing to jump to, so the trigger is disabled instead of
  // opening an empty-feeling picker.
  const canJumpToMonth = monthOptions.length > 1;
  const weekOffsets = useMemo(
    () => buildCalendarWeekOffsets(weeks, listHeaderHeight, measuredWeekHeightsRef.current),
    // measuredHeightsVersion is the change signal for the (mutable) measured
    // heights map -- bumped once per frame at most as rows report layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weeks, listHeaderHeight, measuredHeightsVersion],
  );
  const lastWeekIndex = Math.max(weeks.length - 1, 0);

  const handleRefresh = useCallback(() => {
    void Promise.all([refetchOldestMemoryDate(), refetchCalendarMemories()]);
  }, [refetchCalendarMemories, refetchOldestMemoryDate]);

  const clearJumpSettleTimer = useCallback(() => {
    if (jumpSettleTimerRef.current != null) {
      clearTimeout(jumpSettleTimerRef.current);
      jumpSettleTimerRef.current = null;
    }
  }, []);

  // A manual drag always wins: the user grabbing the list cancels any
  // pending post-jump correction outright.
  const cancelPendingJumpCorrection = useCallback(() => {
    pendingJumpCorrectionRef.current = null;
    clearJumpSettleTimer();
  }, [clearJumpSettleTimer]);

  // Post-jump settle-and-correct (see resolveCalendarJumpCorrection in
  // utils/calendar.ts): once the jump's scroll settles -- onMomentumScrollEnd,
  // or the bounded timeout for scrolls that emit no momentum events -- the
  // target row has rendered, so its TRUE position in content coordinates is
  // measured (measureLayout against the list's inner container) and one
  // non-animated scrollToOffset snaps to exactly that. Index-based
  // re-scrolls can't do this: RN trusts our getItemLayout model for every
  // scrollToIndex, so they'd replay the model's error, and index-level
  // comparisons can't even see a sub-row landing error. Bounded to
  // MAX_JUMP_CORRECTION_PASSES by the pure resolver.
  const settlePendingJumpCorrection = useCallback(function settle() {
    clearJumpSettleTimer();

    const pending = pendingJumpCorrectionRef.current;

    if (!pending) {
      return;
    }

    const targetWeek = weeksRef.current[pending.targetIndex];
    const weekView = targetWeek ? weekViewRefsRef.current.get(targetWeek.startIso) : null;
    // Fabric requires an actual host-component REF for measureLayout's
    // relativeTo argument -- getInnerViewRef() returns the ScrollView's
    // inner content view instance. (getInnerViewNode() returns a numeric
    // node handle, which Fabric rejects; measureCalendarWeekOffset guards
    // against that shape regardless.)
    const scrollResponder = flatListRef.current?.getScrollResponder?.() as
      | { getInnerViewRef?: () => unknown }
      | null
      | undefined;
    const innerViewRef = scrollResponder?.getInnerViewRef?.() ?? null;

    measureCalendarWeekOffset(weekView, innerViewRef, (measuredTargetOffset) => {
      // Re-read pending: a drag may have cancelled while measuring.
      const { scrollToOffset, retryIndex, next } = resolveCalendarJumpCorrection(
        pendingJumpCorrectionRef.current,
        measuredTargetOffset,
      );

      pendingJumpCorrectionRef.current = next;

      if (scrollToOffset != null) {
        // Pixel-true snap to the measured row position.
        flatListRef.current?.scrollToOffset({ animated: false, offset: scrollToOffset });
      } else if (retryIndex != null) {
        // Target row not rendered (landing was far off): estimated re-scroll
        // to bring it into the render window, then measure again.
        flatListRef.current?.scrollToIndex({ animated: false, index: retryIndex, viewPosition: 0 });
      }

      if (next != null) {
        // Non-animated scrolls emit no momentum events; re-verify via the
        // bounded timer.
        jumpSettleTimerRef.current = setTimeout(settle, JUMP_SETTLE_TIMEOUT_MS);
      }
    });
  }, [clearJumpSettleTimer]);

  const armJumpCorrection = useCallback(
    (targetIndex: number, commandedOffset: number | null) => {
      pendingJumpCorrectionRef.current = startCalendarJumpCorrection(targetIndex, commandedOffset);
      clearJumpSettleTimer();
      jumpSettleTimerRef.current = setTimeout(settlePendingJumpCorrection, JUMP_SETTLE_TIMEOUT_MS);
    },
    [clearJumpSettleTimer, settlePendingJumpCorrection],
  );

  useEffect(() => clearJumpSettleTimer, [clearJumpSettleTimer]);

  const handleSelectMonth = useCallback(
    (option: CalendarMonthOption) => {
      const targetIndex = Math.min(
        getMonthJumpWeekIndex(referenceDateRef.current, option.year, option.month),
        lastWeekIndex,
      );

      setIsMonthPickerVisible(false);
      // Proactively widen the visible-week window to the jump target so the
      // range fetch (useCalendarMemoriesInRange) kicks off for that month
      // right away, instead of waiting for onViewableItemsChanged to catch
      // up once the scroll settles.
      setVisibleWeekRange({
        startIndex: targetIndex,
        endIndex: Math.min(targetIndex + 3, lastWeekIndex),
      });
      // The initial scrollToIndex will land on the model's ESTIMATED offset
      // for the target; recording it lets the settle pass confirm the
      // landing against measured geometry (or correct it).
      armJumpCorrection(targetIndex, weekOffsets[targetIndex] ?? null);

      requestAnimationFrame(() => {
        flatListRef.current?.scrollToIndex({ animated: true, index: targetIndex, viewPosition: 0 });
      });
    },
    [armJumpCorrection, lastWeekIndex, weekOffsets],
  );

  const handleScrollToToday = useCallback(() => {
    // Mirrors handleSelectMonth's jump: widen the visible-week window to the
    // top of the list first so the range fetch kicks off immediately, then
    // scroll -- instead of waiting for onViewableItemsChanged to catch up
    // once the scroll settles.
    setVisibleWeekRange({
      startIndex: 0,
      endIndex: Math.min(3, lastWeekIndex),
    });
    // scrollToOffset(0) is the exact top of the content by definition -- no
    // height model involved -- so unlike month jumps it needs (and gets) no
    // settle-and-correct pass. Any correction pending from an earlier month
    // jump is cancelled so it can't fight this scroll.
    cancelPendingJumpCorrection();

    requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset({ animated: true, offset: 0 });
    });
  }, [cancelPendingJumpCorrection, lastWeekIndex, setVisibleWeekRange]);

  const handleScrollToIndexFailed = useCallback(
    (info: { averageItemLength: number; index: number }) => {
      // getItemLayout should make scrollToIndex succeed directly, but this
      // is a safety net against approximate row-height drift (see
      // getCalendarWeekItemHeight in utils/calendar.ts) -- jump close via
      // offset, then retry the precise index once the list has settled.
      flatListRef.current?.scrollToOffset({
        animated: false,
        offset: info.averageItemLength * info.index,
      });

      requestAnimationFrame(() => {
        flatListRef.current?.scrollToIndex({ animated: true, index: info.index, viewPosition: 0 });
      });
    },
    [],
  );

  const getItemLayout = useCallback(
    (_data: ArrayLike<CalendarWeek> | null | undefined, index: number) =>
      getCalendarItemLayout(weeks, weekOffsets, index, measuredWeekHeightsRef.current),
    [weeks, weekOffsets],
  );

  // Fold each rendered week row's real height into the height model. Bumps
  // the offsets memo at most once per frame no matter how many rows report
  // in a burst.
  const handleWeekLayout = useCallback((week: CalendarWeek, event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    const current = measuredWeekHeightsRef.current.get(week.startIso);

    if (current != null && Math.abs(current - height) < 1) {
      return;
    }

    measuredWeekHeightsRef.current.set(week.startIso, height);

    if (!measurementFlushScheduledRef.current) {
      measurementFlushScheduledRef.current = true;
      requestAnimationFrame(() => {
        measurementFlushScheduledRef.current = false;
        setMeasuredHeightsVersion((version) => version + 1);
      });
    }
  }, []);

  const handleListHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height);
    setListHeaderHeight((current) => (current === height ? current : height));
  }, []);

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

  // The large title/subtitle scroll away with the list; the compact
  // month-label + Today bar above (see the fixed header in the JSX below)
  // is what stays pinned. Only static content lives here.
  const renderHeader = useCallback(() => (
    // Measured so getItemLayout offsets can include the real header height
    // (offsets are in content coordinates, which span the list header).
    <View onLayout={handleListHeaderLayout}>
      <View style={styles.header}>
        <Text style={styles.title}>Backwards.</Text>
        <Text style={styles.subtitle}>Each row is a moment. Scroll to walk back in time.</Text>
      </View>
      <PendingMemoryUploadsBanner />
    </View>
  ), [handleListHeaderLayout]);

  const renderWeek = useCallback(({ item: week }: ListRenderItemInfo<CalendarWeek>) => (
    <View
      onLayout={(event) => handleWeekLayout(week, event)}
      ref={(node) => {
        if (node) {
          weekViewRefsRef.current.set(week.startIso, node as MeasurableWeekView);
        } else {
          weekViewRefsRef.current.delete(week.startIso);
        }
      }}
      style={styles.week}
      testID={`calendar-week-${week.startIso}`}
    >
      {week.monthBreak && (
        <View style={styles.monthBreak}>
          <View style={styles.monthBreakLine} />
          <Text style={styles.monthBreakText}>{week.monthBreak}</Text>
          <View style={styles.monthBreakLine} />
        </View>
      )}
      <View style={styles.weekLabelRow}>
        <Text style={styles.weekLabel}>{week.label}</Text>
        <Text style={styles.weekRange}>{week.rangeLabel}</Text>
      </View>
      <View style={styles.weekDays}>
        {week.days.map((day) => (
          <RibbonDay
            key={day.iso}
            day={{ ...day, memory: memoriesByDate.get(day.iso) }}
            isIllustrationHidden={contentSafety.isTargetReported(
              'memory_illustration',
              memoriesByDate.get(day.iso)?.id,
              memoriesByDate.get(day.iso)?.illustration_generation_id,
            )}
            isMemoryHidden={contentSafety.isTargetReported('memory', memoriesByDate.get(day.iso)?.id)}
            onPress={(memory) => router.push(memoryDetailRoute(memory.id))}
            onShowIllustration={() => {
              const memoryId = memoriesByDate.get(day.iso)?.id;
              const generationId = memoriesByDate.get(day.iso)?.illustration_generation_id;
              if (memoryId) {
                contentSafety.revealTarget('memory_illustration', memoryId, generationId);
              }
            }}
            onShowMemory={() => {
              const memoryId = memoriesByDate.get(day.iso)?.id;
              if (memoryId) contentSafety.revealTarget('memory', memoryId);
            }}
          />
        ))}
      </View>
    </View>
  ), [contentSafety, handleWeekLayout, memoriesByDate]);

  if (contentSafety.isLoading) {
    return (
      <View style={styles.centered} testID="calendar-safety-loading">
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (contentSafety.isError) {
    return (
      <View style={styles.centered} testID="calendar-safety-error">
        <Text style={styles.errorText}>Couldn’t load memories</Text>
        <Pressable onPress={() => void contentSafety.refetch()}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Fixed header bar: stays pinned above the list at all times so the
          "where am I" month label and the "take me home" Today button never
          scroll away with the weeks (design decision -- the large title
          below scrolls, this compact bar does not). */}
      <SafeAreaView edges={['top']} style={styles.fixedHeader} testID="calendar-fixed-header">
        <View style={styles.headerTopRow}>
          <Pressable
            accessibilityLabel="Jump to month"
            accessibilityRole="button"
            disabled={!canJumpToMonth}
            hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
            onPress={() => setIsMonthPickerVisible(true)}
            style={styles.eyebrowButton}
            testID="calendar-month-trigger"
          >
            <Text style={styles.eyebrow}>{visibleMonthLabel}</Text>
            {canJumpToMonth && (
              <SymbolView
                fallback={<Text style={styles.eyebrowChevron}>⌄</Text>}
                name={{ ios: 'chevron.down', android: 'expand_more' }}
                size={12}
                tintColor={colors.ink3}
              />
            )}
          </Pressable>
          {showTodayButton && (
            <Animated.View entering={TODAY_BUTTON_ENTERING}>
              <Pressable
                accessibilityLabel="Back to today"
                accessibilityRole="button"
                hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
                onPress={handleScrollToToday}
                style={styles.todayButton}
                testID="calendar-today-button"
              >
                <Text style={styles.todayButtonText}>Today</Text>
              </Pressable>
            </Animated.View>
          )}
        </View>
      </SafeAreaView>

      <FlatList
        ref={flatListRef}
        data={weeks}
        keyExtractor={(week) => week.startIso}
        renderItem={renderWeek}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.scrollContent}
        getItemLayout={getItemLayout}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        onMomentumScrollEnd={settlePendingJumpCorrection}
        onScrollBeginDrag={cancelPendingJumpCorrection}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        onViewableItemsChanged={handleViewableItemsChanged}
        removeClippedSubviews
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
        }
        testID="calendar-week-list"
        viewabilityConfig={viewabilityConfig}
        windowSize={7}
      />

      <CalendarMonthPickerSheet
        onClose={() => setIsMonthPickerVisible(false)}
        onSelect={handleSelectMonth}
        options={monthOptions}
        visible={isMonthPickerVisible}
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
  centered: { alignItems: 'center', backgroundColor: colors.bg, flex: 1, gap: spacing.sm, justifyContent: 'center' },
  errorText: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 15 },
  retryText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  scrollContent: {
    paddingBottom: 130,
  },
  header: {
    paddingTop: 4,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: 8,
  },
  fixedHeader: {
    backgroundColor: colors.bg,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: 8,
    paddingBottom: 6,
    zIndex: 1,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 24,
  },
  eyebrowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingVertical: 4,
  },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  eyebrowChevron: {
    fontSize: 12,
    color: colors.ink3,
  },
  todayButton: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  todayButtonText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
    color: colors.primary,
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
    // Padding (not margin) so the row's onLayout height includes it -- the
    // measured heights feed getItemLayout (see handleWeekLayout), and
    // margins are excluded from a view's own layout box.
    paddingBottom: 28,
  },
  monthBreak: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: spacing.lg,
    marginTop: 6,
    marginBottom: 26,
  },
  monthBreakLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderStrong,
  },
  monthBreakText: {
    fontFamily: fonts.displayItalic,
    fontSize: 22,
    lineHeight: 28,
    color: colors.ink2,
  },
  weekLabelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: 12,
  },
  weekLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  weekRange: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.08 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
    opacity: 0.75,
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
  hiddenStamp: { backgroundColor: colors.surface },
  hiddenStampText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 10 },
  hiddenMemoryRow: { flex: 1, justifyContent: 'center', minHeight: 56 },
  hiddenMemoryText: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 13 },
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
