import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { CalendarMonthOption } from '@/utils/calendar';

export interface CalendarMonthPickerSheetProps {
  visible: boolean;
  options: CalendarMonthOption[];
  onSelect: (option: CalendarMonthOption) => void;
  onClose: () => void;
}

interface MonthYearGroup {
  year: number;
  options: CalendarMonthOption[];
}

function groupOptionsByYear(options: CalendarMonthOption[]): MonthYearGroup[] {
  const groups: MonthYearGroup[] = [];

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
export function CalendarMonthPickerSheet({
  visible,
  options,
  onSelect,
  onClose,
}: CalendarMonthPickerSheetProps) {
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
                  {group.options.map((option) => (
                    <Pressable
                      accessibilityRole="button"
                      key={option.iso}
                      onPress={() => onSelect(option)}
                      style={({ pressed }) => [
                        styles.monthChip,
                        option.isCurrent && styles.monthChipCurrent,
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
                      </Text>
                    </Pressable>
                  ))}
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
