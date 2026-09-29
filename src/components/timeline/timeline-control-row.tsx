import { SymbolView } from 'expo-symbols';
import { CalendarDays, List } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { GRID_GAP, GRID_HORIZONTAL_PADDING } from '@/utils/calendar-grid';
import type { TimelineView } from '@/utils/timeline-view-preference';

const TODAY_BUTTON_ENTERING = FadeIn.duration(160);
const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// Fixed heights: the row is the sticky first item of the Timeline's list,
// and in Calendar view the month grid's getItemLayout offsets are computed
// from them (so they must match what renders, exactly).
export const CONTROL_ROW_HEIGHT = 52;
export const CONTROL_ROW_WEEKDAYS_HEIGHT = 24;

export function getControlRowHeight(view: TimelineView): number {
  return view === 'calendar' ? CONTROL_ROW_HEIGHT + CONTROL_ROW_WEEKDAYS_HEIGHT : CONTROL_ROW_HEIGHT;
}

const VIEW_OPTIONS: { view: TimelineView; label: string; Icon: typeof List }[] = [
  { view: 'list', label: 'List view', Icon: List },
  { view: 'calendar', label: 'Calendar view', Icon: CalendarDays },
];

function ViewSwitcher({ view, onChangeView }: { view: TimelineView; onChangeView: (view: TimelineView) => void }) {
  return (
    <View accessibilityRole="tablist" style={styles.switcher} testID="timeline-view-switcher">
      {VIEW_OPTIONS.map(({ view: option, label, Icon }) => {
        const selected = option === view;
        return (
          <Pressable
            accessibilityLabel={label}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            hitSlop={{ top: 8, bottom: 8 }}
            key={option}
            onPress={() => {
              if (!selected) onChangeView(option);
            }}
            style={[styles.switcherOption, selected && styles.switcherOptionSelected]}
            testID={`timeline-view-${option}`}
          >
            <Icon color={selected ? colors.primary : colors.ink3} size={16} strokeWidth={selected ? 2.2 : 1.8} />
          </Pressable>
        );
      })}
    </View>
  );
}

export interface TimelineControlRowProps {
  monthLabel: string;
  canJumpToMonth: boolean;
  onPressMonth: () => void;
  showToday: boolean;
  onPressToday: () => void;
  view: TimelineView;
  onChangeView: (view: TimelineView) => void;
  // Calendar view: grid tile width, to line the weekday letters up with it.
  tileSize: number;
}

/**
 * The Timeline's one sticky row, where the "Recently" separator used to be:
 * the month being shown (also the jump-to-month trigger), a contextual Today
 * button, and the List/Calendar switcher. Everything above it (title,
 * search, bell, This week, Looking Back) scrolls away; it pins when it
 * reaches the top. In Calendar view it also carries the M–S weekday
 * letters so they stay over the grid.
 */
export function TimelineControlRow({
  monthLabel,
  canJumpToMonth,
  onPressMonth,
  showToday,
  onPressToday,
  view,
  onChangeView,
  tileSize,
}: TimelineControlRowProps) {
  return (
    <View style={[styles.container, { height: getControlRowHeight(view) }]} testID="timeline-control-row">
      <View style={styles.row}>
        <Pressable
          accessibilityLabel={monthLabel ? `Jump to month, showing ${monthLabel}` : 'Jump to month'}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canJumpToMonth }}
          disabled={!canJumpToMonth}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          onPress={onPressMonth}
          style={styles.monthButton}
          testID="timeline-month-trigger"
        >
          <Text numberOfLines={1} style={styles.monthLabel}>{monthLabel}</Text>
          {canJumpToMonth ? (
            <SymbolView
              fallback={<Text style={styles.chevron}>⌄</Text>}
              name={{ ios: 'chevron.down', android: 'expand_more' }}
              size={11}
              tintColor={colors.ink3}
            />
          ) : null}
        </Pressable>
        <View style={styles.rule} />
        {showToday ? (
          <Animated.View entering={TODAY_BUTTON_ENTERING}>
            <Pressable
              accessibilityLabel="Back to today"
              accessibilityRole="button"
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              onPress={onPressToday}
              style={styles.todayButton}
              testID="timeline-today-button"
            >
              <Text style={styles.todayText}>Today</Text>
            </Pressable>
          </Animated.View>
        ) : null}
        <ViewSwitcher onChangeView={onChangeView} view={view} />
      </View>
      {view === 'calendar' ? (
        <View style={styles.weekdayRow} testID="calendar-grid-weekdays">
          {WEEKDAY_LABELS.map((label, index) => (
            <Text key={index} style={[styles.weekdayLabel, { width: tileSize }]}>{label}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    height: CONTROL_ROW_HEIGHT,
    paddingHorizontal: spacing.lg,
  },
  monthButton: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 4,
  },
  monthLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  chevron: {
    color: colors.ink3,
    fontSize: 11,
  },
  rule: {
    backgroundColor: colors.border,
    flex: 1,
    height: 1,
  },
  todayButton: {
    paddingHorizontal: 2,
    paddingVertical: 4,
  },
  todayText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  switcher: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    flexDirection: 'row',
    padding: 2,
  },
  switcherOption: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 28,
    justifyContent: 'center',
    width: 32,
  },
  switcherOptionSelected: {
    backgroundColor: colors.white,
  },
  weekdayRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: GRID_GAP,
    height: CONTROL_ROW_WEEKDAYS_HEIGHT,
    paddingHorizontal: GRID_HORIZONTAL_PADDING,
  },
  weekdayLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 0.6,
    textAlign: 'center',
  },
});
