import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MemoryStamp } from '@/components/memory-stamp';
import { colors, fonts, radius } from '@/constants/theme';
import {
  getGridDayAccessibilityLabel,
  getGridMonthHeight,
  GRID_GAP,
  GRID_HORIZONTAL_PADDING,
  GRID_MONTH_BOTTOM_PADDING,
  GRID_MONTH_TITLE_HEIGHT,
  type GridDay,
  type GridDaySummary,
  type GridMonth,
} from '@/utils/calendar-grid';

interface GridTileProps {
  day: GridDay;
  month: GridMonth;
  size: number;
  summary: GridDaySummary | undefined;
  isMemoryHidden: boolean;
  isIllustrationHidden: boolean;
  /** A Year Film is placed on this day (docs/plans/year-film-p2.md Step 5.4). */
  hasFilm: boolean;
  onPress: (iso: string) => void;
}

// "September 2, 2 memories, film" / "September 30, film" (film-only day).
function getTileLabel(day: GridDay, month: GridMonth, count: number, hasFilm: boolean): string {
  const base = getGridDayAccessibilityLabel(day, month, count);
  if (!hasFilm) return base;
  return `${count === 0 ? base.replace(/, no memories$/, '') : base}, film`;
}

const GridTile = memo(function GridTile({
  day,
  month,
  size,
  summary,
  isMemoryHidden,
  isIllustrationHidden,
  hasFilm,
  onPress,
}: GridTileProps) {
  const sizeStyle = { width: size, height: size };
  const count = summary?.count ?? 0;

  if (!summary && hasFilm) {
    // Recaps often land on a memory-less month-end: still a button, opening
    // the list at that day where the film card sits.
    return (
      <Pressable
        accessibilityLabel={getTileLabel(day, month, 0, true)}
        accessibilityRole="button"
        onPress={() => onPress(day.iso)}
        style={({ pressed }) => [
          styles.tile, styles.tileFilmOnly, sizeStyle, day.isToday && styles.tileToday, pressed && styles.tilePressed,
        ]}
        testID={`calendar-grid-day-${day.iso}`}
      >
        <Text style={[styles.dayNumber, styles.dayNumberFilmOnly, day.isToday && styles.dayNumberToday]}>{day.day}</Text>
        <View style={styles.filmDot} pointerEvents="none" testID={`calendar-grid-day-${day.iso}-film`} />
      </Pressable>
    );
  }

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
      accessibilityLabel={getTileLabel(day, month, count, hasFilm)}
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
      {hasFilm ? (
        <View style={styles.filmDot} pointerEvents="none" testID={`calendar-grid-day-${day.iso}-film`} />
      ) : null}
    </Pressable>
  );
});

export interface CalendarGridMonthProps {
  month: GridMonth;
  tileSize: number;
  summaries: Map<string, GridDaySummary>;
  /** Placement dates ('YYYY-MM-DD') of the family's Year Films; those days get
   * a film dot and are pressable even with no memories. Optional. */
  filmDates?: ReadonlySet<string>;
  isTargetReported: (type: 'memory' | 'memory_illustration', id: string, generationId?: string | null) => boolean;
  onDayPress: (iso: string) => void;
}

/**
 * One month of the Timeline's Calendar view (docs/plans/timeline-calendar-keepsakes.md
 * B2): title + Monday-start 7-column grid of day tiles showing that day's
 * newest memory. Rendered as an item of the Timeline's own list, below its
 * sticky control row (which carries the weekday letters), so the grid
 * scrolls with the page's top content. The height is pinned to
 * getGridMonthHeight so the list's getItemLayout is exact and month jumps
 * are one scroll.
 */
export const CalendarGridMonth = memo(function CalendarGridMonth({
  month,
  tileSize,
  summaries,
  filmDates,
  isTargetReported,
  onDayPress,
}: CalendarGridMonthProps) {
  return (
    <View
      style={[styles.month, { height: getGridMonthHeight(month, tileSize) }]}
      testID={`calendar-grid-month-${month.key}`}
    >
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
                  hasFilm={filmDates?.has(day.iso) ?? false}
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
  );
});

const styles = StyleSheet.create({
  month: {
    paddingBottom: GRID_MONTH_BOTTOM_PADDING,
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
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
  tileFilmOnly: { backgroundColor: colors.primaryTint },
  tileFuture: { opacity: 0.4 },
  filmDot: {
    backgroundColor: colors.primary,
    borderColor: colors.white,
    borderRadius: 5,
    borderWidth: 1.5,
    height: 10,
    position: 'absolute',
    right: 3,
    top: 3,
    width: 10,
  },
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
  dayNumberFilmOnly: { color: colors.ink },
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
