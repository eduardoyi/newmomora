import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TimelineActivityBell } from '@/components/timeline-activity-bell';
import { TimelineSearchButton } from '@/components/timeline-search-button';
import { colors, fonts, spacing } from '@/constants/theme';

const TODAY_BUTTON_ENTERING = FadeIn.duration(160);

export interface TimelineHeaderBarProps {
  monthLabel: string;
  canJumpToMonth: boolean;
  onPressMonth: () => void;
  showToday: boolean;
  onPressToday: () => void;
  bellUnread: boolean;
  onPressBell: () => void;
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
