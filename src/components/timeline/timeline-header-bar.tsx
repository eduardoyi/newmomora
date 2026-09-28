import { SymbolView } from 'expo-symbols';
import { CalendarDays, List } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TimelineActivityBell } from '@/components/timeline-activity-bell';
import { TimelineSearchButton } from '@/components/timeline-search-button';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { TimelineView } from '@/utils/timeline-view-preference';

const TODAY_BUTTON_ENTERING = FadeIn.duration(160);

export interface TimelineHeaderBarProps {
  monthLabel: string;
  canJumpToMonth: boolean;
  onPressMonth: () => void;
  showToday: boolean;
  onPressToday: () => void;
  bellUnread: boolean;
  onPressBell: () => void;
  view: TimelineView;
  onChangeView: (view: TimelineView) => void;
}

const VIEW_OPTIONS: { view: TimelineView; label: string; Icon: typeof List }[] = [
  { view: 'list', label: 'List view', Icon: List },
  { view: 'calendar', label: 'Calendar view', Icon: CalendarDays },
];

// Icon-only segmented control (labels are for screen readers): the bar also
// carries the month label, Today, search and the bell, and has to fit a
// 375pt-wide phone.
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

/**
 * The Timeline's pinned bar (docs/plans/timeline-calendar-keepsakes.md A4):
 * a sibling ABOVE the list, never inside it, so "where am I" (the month
 * label, which is also the jump-to-month trigger), "take me home" (Today),
 * search and the activity bell stay reachable however deep the user scrolls
 * -- and in every Timeline state (loading, error, empty, list). Same pattern
 * as the Calendar tab's fixed header, which this replaces.
 */
export function TimelineHeaderBar({
  monthLabel,
  canJumpToMonth,
  onPressMonth,
  showToday,
  onPressToday,
  bellUnread,
  onPressBell,
  view,
  onChangeView,
}: TimelineHeaderBarProps) {
  return (
    <SafeAreaView edges={['top']} style={styles.bar} testID="timeline-header-bar">
      <View style={styles.row}>
        <Pressable
          accessibilityLabel={monthLabel ? `Jump to month, showing ${monthLabel}` : 'Jump to month'}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canJumpToMonth }}
          disabled={!canJumpToMonth}
          hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
          onPress={onPressMonth}
          style={styles.monthButton}
          testID="timeline-month-trigger"
        >
          <Text numberOfLines={1} style={styles.monthLabel}>{monthLabel}</Text>
          {canJumpToMonth ? (
            <SymbolView
              fallback={<Text style={styles.chevron}>⌄</Text>}
              name={{ ios: 'chevron.down', android: 'expand_more' }}
              size={12}
              tintColor={colors.ink3}
            />
          ) : null}
        </Pressable>

        <View style={styles.actions}>
          {showToday ? (
            <Animated.View entering={TODAY_BUTTON_ENTERING}>
              <Pressable
                accessibilityLabel="Back to today"
                accessibilityRole="button"
                hitSlop={{ top: 10, bottom: 10, left: 12, right: 8 }}
                onPress={onPressToday}
                style={styles.todayButton}
                testID="timeline-today-button"
              >
                <Text style={styles.todayText}>Today</Text>
              </Pressable>
            </Animated.View>
          ) : null}
          <ViewSwitcher onChangeView={onChangeView} view={view} />
          <TimelineSearchButton />
          <TimelineActivityBell onPress={onPressBell} unread={bellUnread} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.bg,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    zIndex: 1,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  monthButton: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 4,
    paddingVertical: 4,
  },
  monthLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
  },
  chevron: {
    color: colors.ink3,
    fontSize: 12,
  },
  actions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
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
  todayButton: {
    paddingHorizontal: 2,
    paddingVertical: 4,
  },
  todayText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.14 * 11,
    textTransform: 'uppercase',
  },
});
