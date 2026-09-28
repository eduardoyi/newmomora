import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { CalendarMonthOption } from '@/utils/calendar';

// `count` is optional: the Timeline passes per-month memory counts (shown on
// each chip, and a month with none is disabled so a pick always lands in the
// chosen month -- docs/plans/timeline-calendar-keepsakes.md A4); the Calendar
// tab passes bare options and keeps its original behavior.
export type MonthPickerOption = CalendarMonthOption & { count?: number };

export interface CalendarMonthPickerSheetProps<T extends MonthPickerOption = MonthPickerOption> {
  visible: boolean;
  options: T[];
  onSelect: (option: T) => void;
  onClose: () => void;
}

interface MonthYearGroup<T extends MonthPickerOption> {
  year: number;
  options: T[];
}

function isOptionDisabled(option: MonthPickerOption): boolean {
  return option.count === 0 && !option.isCurrent;
}

function groupOptionsByYear<T extends MonthPickerOption>(options: T[]): MonthYearGroup<T>[] {
  const groups: MonthYearGroup<T>[] = [];

  for (const option of options) {
    const lastGroup = groups.at(-1);

    if (lastGroup && lastGroup.year === option.year) {
      lastGroup.options.push(option);
      continue;
    }

    groups.push({ year: option.year, options: [option] });
  }

  return groups;
}

/**
 * Bottom-sheet month/year picker for the calendar's "jump to month" trigger.
 * Same Modal + backdrop shape as FamilyRosterSheet/MemberActionSheet, but
 * with no search or text input -- selecting a month closes the sheet
 * immediately, there's nothing to confirm.
 */
export function CalendarMonthPickerSheet<T extends MonthPickerOption>({
  visible,
  options,
  onSelect,
  onClose,
}: CalendarMonthPickerSheetProps<T>) {
  const insets = useSafeAreaInsets();
  const groups = groupOptionsByYear(options);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
          testID="month-picker-sheet"
        >
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.headerTitle}>Jump to month</Text>
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
            testID="month-picker-list"
          >
            {groups.map((group) => (
              <View key={group.year} style={styles.yearGroup}>
                <Text style={styles.yearLabel}>{group.year}</Text>
                <View style={styles.monthGrid}>
                  {group.options.map((option) => {
                    const disabled = isOptionDisabled(option);
                    const hasCount = typeof option.count === 'number';
                    return (
                      <Pressable
                        accessibilityLabel={hasCount
                          ? `${option.label} ${option.year}, ${option.count} ${option.count === 1 ? 'memory' : 'memories'}`
                          : undefined}
                        accessibilityRole="button"
                        accessibilityState={{ disabled }}
                        disabled={disabled}
                        key={option.iso}
                        onPress={() => onSelect(option)}
                        style={({ pressed }) => [
                          styles.monthChip,
                          option.isCurrent && styles.monthChipCurrent,
                          disabled && styles.monthChipDisabled,
                          pressed && styles.monthChipPressed,
                        ]}
                        testID={`month-picker-option-${option.iso}`}
                      >
                        <Text
                          style={[
                            styles.monthChipText,
                            option.isCurrent && styles.monthChipTextCurrent,
                          ]}
                        >
                          {option.label}
                          {hasCount && option.count! > 0 ? (
                            <Text style={styles.monthChipCount}>{`  ${option.count}`}</Text>
                          ) : null}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ))}
          </ScrollView>

          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.cancelBtn, pressed && styles.cancelBtnPressed]}
            testID="month-picker-cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44, 36, 24, 0.4)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '78%',
    overflow: 'hidden',
    paddingTop: spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
    height: 4,
    marginBottom: spacing.md,
    width: 36,
  },
  header: {
    alignItems: 'center',
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  headerTitle: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 17,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  yearGroup: {
    marginBottom: spacing.lg,
  },
  yearLabel: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  monthChip: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  monthChipCurrent: {
    backgroundColor: colors.primaryTint,
  },
  monthChipPressed: {
    opacity: 0.75,
  },
  monthChipDisabled: {
    opacity: 0.4,
  },
  monthChipCount: {
    color: colors.ink3,
    fontFamily: fonts.sansMedium,
    fontSize: 12,
  },
  monthChipText: {
    color: colors.ink2,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
  monthChipTextCurrent: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
  },
  cancelBtn: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: 14,
  },
  cancelBtnPressed: {
    opacity: 0.85,
  },
  cancelText: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 16,
  },
});
