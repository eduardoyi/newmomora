import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import {
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewabilityConfig,
  type ViewToken,
} from 'react-native';

import { MemoryStamp } from '@/components/memory-stamp';
import { colors, fonts, radius } from '@/constants/theme';
import { useCalendarMemoriesInRange } from '@/hooks/useCalendarMemories';
import { useContentSafety } from '@/hooks/useContentSafety';
import {
  buildGridMonthOffsets,
  getGridDayAccessibilityLabel,
  getGridFetchRange,
  getGridMonthHeight,
  getGridTileSize,
  GRID_GAP,
  GRID_HORIZONTAL_PADDING,
  GRID_MONTH_BOTTOM_PADDING,
  GRID_MONTH_TITLE_HEIGHT,
  summarizeGridDays,
  type GridDay,
  type GridDaySummary,
  type GridMonth,
} from '@/utils/calendar-grid';

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
// The topmost month that's at least this visible names the pinned label.
const MONTH_VIEWABILITY: ViewabilityConfig = { itemVisiblePercentThreshold: 10 };

export interface CalendarMonthGridHandle {
  scrollToMonth: (monthKey: string, animated?: boolean) => void;
}

export interface CalendarMonthGridProps {
  months: GridMonth[];
  initialMonthKey: string | null;
  onDayPress: (iso: string) => void;
  onTopMonthChange: (monthKey: string) => void;
  // Pull-to-refresh: the grid refetches its own range; this refreshes
  // whatever else the screen owns (month counts, the activity dot).
  onRefresh?: () => Promise<unknown> | void;
  ref?: Ref<CalendarMonthGridHandle>;
}

interface GridTileProps {
  day: GridDay;
  month: GridMonth;
  size: number;
  summary: GridDaySummary | undefined;
  isMemoryHidden: boolean;
  isIllustrationHidden: boolean;
  onPress: (iso: string) => void;
}

const GridTile = memo(function GridTile({
  day,
  month,
  size,
  summary,
  isMemoryHidden,
  isIllustrationHidden,
  onPress,
}: GridTileProps) {
  const sizeStyle = { width: size, height: size };
  const count = summary?.count ?? 0;

  if (!summary) {
    // Empty days aren't buttons -- there's nothing to open.
    return (
      <View
        accessibilityLabel={getGridDayAccessibilityLabel(day, month, 0)}
        style={[styles.tile, sizeStyle, day.isToday && styles.tileToday, day.isFuture && styles.tileFuture]}
        testID={`calendar-grid-day-${day.iso}`}
      >
        <Text style={[styles.dayNumber, day.isToday && styles.dayNumberToday]}>{day.day}</Text>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={getGridDayAccessibilityLabel(day, month, count)}
      accessibilityRole="button"
      onPress={() => onPress(day.iso)}
      style={({ pressed }) => [styles.tile, sizeStyle, day.isToday && styles.tileToday, pressed && styles.tilePressed]}
      testID={`calendar-grid-day-${day.iso}`}
    >
      {isMemoryHidden ? (
        // A reported memory never shows its stamp here; the list it opens
        // has the "Show anyway" reveal.
        <View style={[styles.hiddenTile, sizeStyle]} testID={`calendar-grid-day-${day.iso}-hidden`} />
      ) : (
        <MemoryStamp
          isIllustrationHidden={isIllustrationHidden}
          memory={summary.memory}
          showMediaCount={false}
          size={size}
          testIDPrefix="calendar-grid-memory"
        />
      )}
      <View style={styles.dayChip} pointerEvents="none">
        <Text style={styles.dayChipText}>{day.day}</Text>
      </View>
      {count > 1 ? (
        <View style={styles.countBadge} pointerEvents="none" testID={`calendar-grid-day-${day.iso}-count`}>
          <Text style={styles.countBadgeText}>+{count - 1}</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

/**
 * The Timeline's Calendar view (docs/plans/timeline-calendar-keepsakes.md
 * B2): months newest-first, each a Monday-start 7-column grid of day tiles
 * showing that day's newest memory. Month heights follow from date math, so
 * getItemLayout is exact and jumping to a month is one scrollToIndex -- no
 * measurement or correction pass. Memories load for the visible months ± 1
 * through the Calendar tab's range query (same cache, patching and polling).
 */
export function CalendarMonthGrid({
  months,
  initialMonthKey,
  onDayPress,
  onTopMonthChange,
  onRefresh,
  ref,
}: CalendarMonthGridProps) {
  const { width } = useWindowDimensions();
  const tileSize = getGridTileSize(width);
  const contentSafety = useContentSafety();
  const listRef = useRef<FlatList<GridMonth>>(null);

  const [initialIndex] = useState(() => {
    const index = initialMonthKey ? months.findIndex((month) => month.key === initialMonthKey) : -1;
    return Math.max(0, index);
  });
  const [visibleRange, setVisibleRange] = useState({ first: initialIndex, last: initialIndex });

  const offsets = useMemo(() => buildGridMonthOffsets(months, tileSize), [months, tileSize]);
  const getItemLayout = useCallback(
    (_data: ArrayLike<GridMonth> | null | undefined, index: number) => ({
      index,
      length: months[index] ? getGridMonthHeight(months[index]!, tileSize) : 0,
      offset: offsets[index] ?? 0,
    }),
    [months, offsets, tileSize],
  );

  const fetchRange = useMemo(
    () => getGridFetchRange(months, visibleRange.first, visibleRange.last),
    [months, visibleRange.first, visibleRange.last],
  );
  const { data: memories = [], refetch } = useCalendarMemoriesInRange(fetchRange);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void Promise.all([refetch(), onRefresh?.()]).finally(() => setIsRefreshing(false));
  }, [onRefresh, refetch]);
  const { isUserBlocked, isTargetReported } = contentSafety;
  const summaries = useMemo(() => summarizeGridDays(memories, isUserBlocked), [isUserBlocked, memories]);

  useImperativeHandle(ref, () => ({
    scrollToMonth: (monthKey, animated = true) => {
      const index = months.findIndex((month) => month.key === monthKey);
      if (index < 0) return;
      setVisibleRange({ first: index, last: index });
      listRef.current?.scrollToIndex({ animated, index, viewPosition: 0 });
    },
  }), [months]);

  // RN forbids swapping onViewableItemsChanged on a mounted list, so the
  // stable handler below reads the latest months/callback through refs.
  const monthsRef = useRef(months);
  const onTopMonthChangeRef = useRef(onTopMonthChange);
  useEffect(() => {
    monthsRef.current = months;
    onTopMonthChangeRef.current = onTopMonthChange;
  }, [months, onTopMonthChange]);
  const handleViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const indexes = viewableItems
      .filter((token) => token.isViewable && token.index !== null)
      .map((token) => token.index as number);
    if (indexes.length === 0) return;
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    setVisibleRange((previous) => (previous.first === first && previous.last === last ? previous : { first, last }));
    const top = monthsRef.current[first];
    if (top) onTopMonthChangeRef.current(top.key);
  }, []);

  const renderMonth = useCallback(
    ({ item: month }: ListRenderItemInfo<GridMonth>) => (
      <View style={styles.month} testID={`calendar-grid-month-${month.key}`}>
        <Text style={styles.monthTitle}>{month.title}</Text>
        <View style={styles.weeks}>
          {month.weeks.map((week, weekIndex) => (
            <View key={weekIndex} style={styles.week}>
              {week.map((day, dayIndex) => {
                if (!day) {
                  return <View key={`blank-${dayIndex}`} style={{ width: tileSize, height: tileSize }} />;
                }
                const summary = summaries.get(day.iso);
                const memory = summary?.memory;
                return (
                  <GridTile
                    day={day}
                    isIllustrationHidden={memory
                      ? isTargetReported('memory_illustration', memory.id, memory.illustration_generation_id)
                      : false}
                    isMemoryHidden={memory ? isTargetReported('memory', memory.id) : false}
                    key={day.iso}
                    month={month}
                    onPress={onDayPress}
                    size={tileSize}
                    summary={summary}
                  />
                );
              })}
            </View>
          ))}
        </View>
      </View>
    ),
    [isTargetReported, onDayPress, summaries, tileSize],
  );

  return (
    <View style={styles.container}>
      <View style={styles.weekdayRow} testID="calendar-grid-weekdays">
        {WEEKDAY_LABELS.map((label, index) => (
          <Text key={index} style={[styles.weekdayLabel, { width: tileSize }]}>{label}</Text>
        ))}
      </View>
      <FlatList
        contentContainerStyle={styles.content}
        data={months}
        extraData={summaries}
        getItemLayout={getItemLayout}
        initialNumToRender={3}
        initialScrollIndex={initialIndex}
        keyExtractor={(month) => month.key}
        maxToRenderPerBatch={2}
        onViewableItemsChanged={handleViewableItemsChanged}
        ref={listRef}
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={isRefreshing} tintColor={colors.primary} />}
        renderItem={renderMonth}
        testID="calendar-grid"
        viewabilityConfig={MONTH_VIEWABILITY}
        windowSize={5}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  weekdayRow: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: GRID_GAP,
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
    paddingVertical: 6,
  },
  weekdayLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 0.6,
    textAlign: 'center',
  },
  content: {
    paddingBottom: 130,
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
  },
  month: {
    paddingBottom: GRID_MONTH_BOTTOM_PADDING,
  },
  monthTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 22,
    height: GRID_MONTH_TITLE_HEIGHT,
    lineHeight: GRID_MONTH_TITLE_HEIGHT,
  },
  weeks: { gap: GRID_GAP },
  week: { flexDirection: 'row', gap: GRID_GAP },
  tile: {
    alignItems: 'center',
    borderRadius: radius.md,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tileToday: {
    borderColor: colors.primary,
    borderWidth: 1.5,
  },
  tileFuture: { opacity: 0.4 },
  tilePressed: { opacity: 0.75 },
  hiddenTile: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },
  dayNumber: {
    color: colors.ink3,
    fontFamily: fonts.sansMedium,
    fontSize: 13,
  },
  dayNumberToday: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
  },
  dayChip: {
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: 6,
    left: 3,
    minWidth: 16,
    paddingHorizontal: 3,
    position: 'absolute',
    top: 3,
  },
  dayChipText: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    textAlign: 'center',
  },
  countBadge: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 7,
    bottom: 3,
    paddingHorizontal: 4,
    position: 'absolute',
    right: 3,
  },
  countBadgeText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 9.5,
  },
});
