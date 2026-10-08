// The library filter (docs/plans/keepsakes-redesign.md C3): a bottom sheet with
// Type (All / Films / Books / Holiday cards) and Year chips, "Reset" and
// "Show {n} keepsakes". Viewers get the Year section only -- films are their
// only type. House Modal + pan-to-dismiss pattern from create-book-sheet.tsx.
// No text inputs, so no keyboard handling.
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { getBottomSheetBottomPadding, shouldDismissBottomSheet } from '@/utils/bottom-sheet-dismiss';
import {
  applyKeepsakesFilter,
  availableYears,
  DEFAULT_KEEPSAKES_FILTER,
  isUpcomingItem,
  type KeepsakesFilter,
  type KeepsakesTypeFilter,
  type ShelfItem,
} from '@/utils/keepsakes';

const TYPE_OPTIONS: { value: KeepsakesTypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'films', label: 'Films' },
  { value: 'books', label: 'Books' },
  { value: 'cards', label: 'Holiday cards' },
];

/** How many of the SHEET's fields (type + year) are set -- the child chip is not one of them. */
export function keepsakesSheetFilterCount(filter: KeepsakesFilter): number {
  return (filter.type !== 'all' ? 1 : 0) + (filter.year !== null ? 1 : 0);
}

export interface KeepsakesFilterSheetProps {
  visible: boolean;
  /** The applied filter; the sheet edits a draft of it. */
  filter: KeepsakesFilter;
  /** Every shelf item (unfiltered): the Year chips and the "Show {n}" count derive from it. */
  items: readonly ShelfItem[];
  /** Owners and managers see the Type section; viewers do not. */
  canChooseType: boolean;
  onApply: (filter: KeepsakesFilter) => void;
  onClose: () => void;
}

function showLabel(count: number, canChooseType: boolean): string {
  const noun = canChooseType ? 'keepsake' : 'film';
  return `Show ${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function KeepsakesFilterSheet({
  visible,
  filter,
  items,
  canChooseType,
  onApply,
  onClose,
}: KeepsakesFilterSheetProps) {
  const insets = useSafeAreaInsets();
  const drawerTranslateY = useSharedValue(0);
  const [draft, setDraft] = useState<KeepsakesFilter>(filter);

  useEffect(() => {
    if (visible) {
      drawerTranslateY.set(0);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- re-seed the draft each time the sheet opens
      setDraft(filter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only when the sheet opens
  }, [visible]);

  const years = useMemo(() => availableYears(items), [items]);
  const matchCount = useMemo(
    () =>
      applyKeepsakesFilter(items, { ...draft, memberId: filter.memberId }).filter(
        (item) => !isUpcomingItem(item),
      ).length,
    [draft, filter.memberId, items],
  );

  const drawerDrag = Gesture.Pan()
    .withTestId('keepsakes-filter-sheet-dismiss-pan')
    .activeOffsetY(8)
    .failOffsetX([-30, 30])
    .failOffsetY([-4, Number.MAX_SAFE_INTEGER])
    .maxPointers(1)
    .onUpdate((event) => {
      drawerTranslateY.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      if (shouldDismissBottomSheet(event.translationY, event.velocityY)) {
        runOnJS(onClose)();
        return;
      }
      drawerTranslateY.set(withSpring(0));
    })
    .onFinalize((_event, success) => {
      if (!success) {
        drawerTranslateY.set(withSpring(0));
      }
    });

  const animatedSheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drawerTranslateY.get() }],
  }));

  const isDefault = draft.type === DEFAULT_KEEPSAKES_FILTER.type && draft.year === DEFAULT_KEEPSAKES_FILTER.year;

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen" transparent visible={visible}>
      <GestureHandlerRootView style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="keepsakes-filter-sheet-backdrop"
        />
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, animatedSheetStyle, { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) }]}
          testID="keepsakes-filter-sheet"
        >
          <GestureDetector gesture={drawerDrag}>
            <View collapsable={false} style={styles.dragRegion}>
              <View style={styles.handle} />
            </View>
          </GestureDetector>

          <View style={styles.content}>
            <Text style={styles.title}>Filter</Text>

            {canChooseType ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Type</Text>
                <View style={styles.chipRow}>
                  {TYPE_OPTIONS.map((option) => {
                    const selected = draft.type === option.value;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        key={option.value}
                        onPress={() => setDraft((current) => ({ ...current, type: option.value }))}
                        style={[styles.chip, selected && styles.chipSelected]}
                        testID={`keepsakes-filter-type-${option.value}`}
                      >
                        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Year</Text>
              <View style={styles.chipRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: draft.year === null }}
                  onPress={() => setDraft((current) => ({ ...current, year: null }))}
                  style={[styles.chip, draft.year === null && styles.chipSelected]}
                  testID="keepsakes-filter-year-all"
                >
                  <Text style={[styles.chipText, draft.year === null && styles.chipTextSelected]}>All</Text>
                </Pressable>
                {years.map((year) => {
                  const selected = draft.year === year;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={year}
                      onPress={() => setDraft((current) => ({ ...current, year }))}
                      style={[styles.chip, selected && styles.chipSelected]}
                      testID={`keepsakes-filter-year-${year}`}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{year}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={isDefault}
                onPress={() => setDraft((current) => ({ ...current, type: 'all', year: null }))}
                style={[styles.resetButton, isDefault && styles.resetDisabled]}
                testID="keepsakes-filter-reset"
              >
                <Text style={styles.resetText}>Reset</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => onApply(draft)}
                style={({ pressed }) => [styles.applyButton, pressed && styles.pressed]}
                testID="keepsakes-filter-apply"
              >
                <Text style={styles.applyText}>{showLabel(matchCount, canChooseType)}</Text>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(44,36,24,0.34)' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '86%',
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: radius.pill,
    height: 5,
    marginBottom: 6,
    marginTop: 10,
    width: 40,
  },
  dragRegion: { minHeight: 24 },
  content: { gap: 20, paddingBottom: 12, paddingHorizontal: spacing.lg },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 21 },
  section: { gap: 10 },
  sectionTitle: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipSelected: { backgroundColor: colors.primaryTint, borderColor: colors.primarySoft },
  chipText: { color: colors.ink2, fontFamily: fonts.sansMedium, fontSize: 13.5 },
  chipTextSelected: { color: colors.primaryDark, fontFamily: fonts.sansBold },
  actions: { alignItems: 'center', flexDirection: 'row', gap: 12, marginTop: 4 },
  resetButton: { paddingHorizontal: 8, paddingVertical: 12 },
  resetDisabled: { opacity: 0.4 },
  resetText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 14.5 },
  applyButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    flex: 1,
    paddingVertical: 14,
  },
  pressed: { opacity: 0.88 },
  applyText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 },
});
