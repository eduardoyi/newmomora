// "Create a book" bottom sheet for the Memory Books shelf redesign
// (owner-approved picker-redesign brief, 2026-09-17). House Modal + pan-to-
// dismiss pattern, copied from `family-activity-sheet.tsx` (no new
// dependencies). Two layers: a short SUGGESTIONS list (up to 3 rows, from
// `pickSuggestedScopes`), then an expandable grouped list covering every
// scope option -- "More options"/"Fewer options".
//
// Not enough yet (2026-10-02): when no book exists and no stretch of time
// has the ~30 memories a book needs (a family fresh out of onboarding), the
// list is all dead ends. The sheet instead says how far along they are and,
// where available, offers gallery import as the fast way there; the full
// list stays one quiet tap away.
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { SymbolView } from 'expo-symbols';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { MemoryBookScopeRow } from '@/hooks/useMemoryBooks';
import {
  MEMORY_BOOK_THIN_THRESHOLD,
  memoryBookScopeKey,
  parseDateParts,
  thinPeriodReason,
  type MemoryBookScopeOption,
} from '@/utils/memory-book-scope';
import { getBottomSheetBottomPadding, shouldDismissBottomSheet } from '@/utils/bottom-sheet-dismiss';

export interface CreateBookSheetProps {
  visible: boolean;
  onClose: () => void;
  /** From `pickSuggestedScopes` -- up to 3 options with no existing book. */
  suggestions: MemoryBookScopeOption[];
  /** Every scope option's row (status/eligibleCount/disabledReason), in the
   * picker's natural order (age-years oldest-first, calendar-years
   * newest-first, everything last). */
  rows: MemoryBookScopeRow[];
  todayIso: string;
  /** Called for any tappable row (a fresh scope, or a `failed` retry) --
   * the caller runs `generate(option)`, dismisses the sheet, and shows the
   * toast; this component doesn't do any of that itself. */
  onSelect: (option: MemoryBookScopeOption) => void;
  childFirstName: string;
  /** Offered in the not-enough-yet state when gallery import is available; the caller closes the sheet and navigates. */
  onImportPhotos?: () => void;
}

/**
 * True when nothing can be made yet: no book has ever been requested and
 * every scope's eligibility count has loaded and sits under the threshold.
 * Unknown (still-loading) counts never trigger it.
 */
export function hasNoBookReadyScope(rows: MemoryBookScopeRow[]): boolean {
  return (
    rows.length > 0 &&
    rows.every((row) => row.book === null && row.eligibleCount !== null && row.eligibleCount < MEMORY_BOOK_THIN_THRESHOLD)
  );
}

function NotEnoughYet({
  childFirstName,
  memoryCount,
  onImportPhotos,
  onShowOptions,
}: {
  childFirstName: string;
  memoryCount: number;
  onImportPhotos?: () => void;
  onShowOptions: () => void;
}) {
  const noun = memoryCount === 1 ? 'memory' : 'memories';
  const progress = Math.min(1, memoryCount / MEMORY_BOOK_THIN_THRESHOLD);

  return (
    <View style={styles.notEnough} testID="create-book-not-enough">
      <Text style={styles.notEnoughHeadline}>{`${childFirstName}’s first book needs a few more memories.`}</Text>
      <Text style={styles.notEnoughBody}>
        {`A book gathers about ${MEMORY_BOOK_THIN_THRESHOLD} memories from a stretch of time. You have ${memoryCount} ${noun} so far. No rush, every one you add gets it closer.`}
      </Text>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.max(progress, 0.04) * 100}%` }]} />
      </View>
      <Text style={styles.progressLabel} testID="create-book-not-enough-count">
        {`${memoryCount} of ~${MEMORY_BOOK_THIN_THRESHOLD}`}
      </Text>

      {onImportPhotos ? (
        <View style={styles.importCard}>
          <Text style={styles.importTitle}>The quick way there</Text>
          <Text style={styles.importBody}>
            Your camera roll is full of them already. Momora can turn the photos on your phone into memories.
            Nothing in your camera roll changes.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onImportPhotos}
            style={({ pressed }) => [styles.importButton, pressed && styles.rowPressed]}
            testID="create-book-import-photos"
          >
            <Text style={styles.importButtonText}>Look through my photos</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable accessibilityRole="button" onPress={onShowOptions} style={styles.moreToggle} testID="create-book-show-options">
        <Text style={styles.moreToggleText}>See all options anyway</Text>
      </Pressable>
    </View>
  );
}

function rangeAndCountMeta(row: MemoryBookScopeRow): string | null {
  const range = row.option.eraLine;
  if (row.eligibleCount === null) return range;
  const noun = row.eligibleCount === 1 ? 'memory' : 'memories';
  const countText = `${row.eligibleCount} ${noun}`;
  return range ? `${range} · ${countText}` : countText;
}

function groupedStatus(row: MemoryBookScopeRow): { text: string; color: string } | null {
  if (row.status === 'ready') return { text: 'Created ✓', color: colors.success };
  if (row.status === 'in_progress') return { text: 'Making it now', color: colors.ink3 };
  if (row.status === 'failed') return { text: 'Didn’t finish', color: colors.sunInk };
  return null;
}

function isRowTappable(row: MemoryBookScopeRow): boolean {
  return row.status === 'available' || row.status === 'thin' || row.status === 'failed';
}

function SuggestionRow({ row, onPress }: { row: MemoryBookScopeRow; onPress: () => void }) {
  const meta = rangeAndCountMeta(row);
  const thinReason = row.eligibleCount !== null ? thinPeriodReason(row.eligibleCount) : null;

  return (
    <Pressable
      accessibilityLabel={`Create the ${row.option.label} book`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.suggestionRow, pressed && styles.rowPressed]}
      testID={`create-book-suggestion-${row.key}`}
    >
      <View style={styles.suggestionTextBlock}>
        <Text style={styles.suggestionLabel}>{row.option.label}</Text>
        {meta ? <Text style={styles.suggestionMeta}>{meta}</Text> : null}
        {thinReason ? (
          <View style={styles.thinChip}>
            <Text style={styles.thinChipText}>{thinReason}</Text>
          </View>
        ) : null}
      </View>
      <SymbolView
        fallback={<Text style={styles.chevronFallback}>›</Text>}
        name={{ ios: 'chevron.right', android: 'chevron_right' }}
        size={16}
        tintColor={colors.ink3}
      />
    </Pressable>
  );
}

function GroupedRow({
  row,
  displayLabel,
  onPress,
}: {
  row: MemoryBookScopeRow;
  displayLabel: string;
  onPress: () => void;
}) {
  const tappable = isRowTappable(row);
  const status = groupedStatus(row);
  const meta = rangeAndCountMeta(row);

  return (
    <Pressable
      accessibilityLabel={`${displayLabel} book`}
      accessibilityRole="button"
      disabled={!tappable}
      onPress={onPress}
      style={({ pressed }) => [styles.groupedRow, pressed && tappable && styles.rowPressed]}
      testID={`create-book-row-${row.key}`}
    >
      <View style={styles.suggestionTextBlock}>
        <Text style={[styles.groupedLabel, !tappable && styles.groupedLabelMuted]}>{displayLabel}</Text>
        {meta ? <Text style={styles.suggestionMeta}>{meta}</Text> : null}
      </View>
      {status ? <Text style={[styles.groupedStatusText, { color: status.color }]}>{status.text}</Text> : null}
    </Pressable>
  );
}

function CreateBookSheetBody({
  suggestions,
  rows,
  todayIso,
  onSelect,
  childFirstName,
  onImportPhotos,
}: {
  suggestions: MemoryBookScopeOption[];
  rows: MemoryBookScopeRow[];
  todayIso: string;
  onSelect: (option: MemoryBookScopeOption) => void;
  childFirstName: string;
  onImportPhotos?: () => void;
}) {
  const [expanded, setExpanded] = useState(suggestions.length === 0);
  const [showOptionsAnyway, setShowOptionsAnyway] = useState(false);
  const currentYear = parseDateParts(todayIso).year;

  const ageYearRows = rows.filter((row) => row.option.kind === 'age_year');
  const calendarYearRows = rows.filter((row) => row.option.kind === 'calendar_year');
  const everythingRow = rows.find((row) => row.option.kind === 'everything');

  if (!showOptionsAnyway && hasNoBookReadyScope(rows)) {
    const memoryCount = Math.max(...rows.map((row) => row.eligibleCount ?? 0));
    return (
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Create a book</Text>
        <NotEnoughYet
          childFirstName={childFirstName}
          memoryCount={memoryCount}
          onImportPhotos={onImportPhotos}
          onShowOptions={() => {
            setShowOptionsAnyway(true);
            setExpanded(true);
          }}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.title}>Create a book</Text>
      <Text style={styles.subtitle}>
        Pick a stretch of time. We gather the memories from it, and you can change anything afterwards.
      </Text>

      {suggestions.length > 0 ? (
        <View style={styles.suggestionsList}>
          {suggestions.map((option) => {
            const row = rows.find((candidate) => candidate.key === memoryBookScopeKey(option));
            if (!row) return null;
            return <SuggestionRow key={row.key} onPress={() => onSelect(option)} row={row} />;
          })}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded((prev) => !prev)}
        style={styles.moreToggle}
        testID="create-book-more-toggle"
      >
        <Text style={styles.moreToggleText}>{expanded ? 'Fewer options' : 'More options'}</Text>
        <SymbolView
          fallback={<Text style={styles.chevronFallback}>{expanded ? '︿' : '﹀'}</Text>}
          name={{ ios: expanded ? 'chevron.up' : 'chevron.down', android: expanded ? 'expand_less' : 'expand_more' }}
          size={13}
          tintColor={colors.primary}
        />
      </Pressable>

      {expanded ? (
        <View style={styles.groupedList}>
          {ageYearRows.length > 0 ? (
            <View style={styles.groupedSection}>
              <Text style={styles.groupedSectionTitle}>Years of life</Text>
              {ageYearRows.map((row) => (
                <GroupedRow displayLabel={row.option.label} key={row.key} onPress={() => onSelect(row.option)} row={row} />
              ))}
            </View>
          ) : null}

          {calendarYearRows.length > 0 ? (
            <View style={styles.groupedSection}>
              <Text style={styles.groupedSectionTitle}>Calendar years</Text>
              {calendarYearRows.map((row) => {
                const isCurrentYear = row.option.calendarYear === currentYear;
                const displayLabel = isCurrentYear ? `${row.option.label} so far` : row.option.label;
                return <GroupedRow displayLabel={displayLabel} key={row.key} onPress={() => onSelect(row.option)} row={row} />;
              })}
            </View>
          ) : null}

          {everythingRow ? (
            <View style={styles.groupedSection}>
              <Text style={styles.groupedSectionTitle}>Everything</Text>
              <GroupedRow displayLabel={everythingRow.option.label} onPress={() => onSelect(everythingRow.option)} row={everythingRow} />
            </View>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

export function CreateBookSheet({
  visible,
  onClose,
  suggestions,
  rows,
  todayIso,
  onSelect,
  childFirstName,
  onImportPhotos,
}: CreateBookSheetProps) {
  const insets = useSafeAreaInsets();
  const drawerTranslateY = useSharedValue(0);

  useEffect(() => {
    if (visible) drawerTranslateY.set(0);
  }, [drawerTranslateY, visible]);

  const drawerDrag = Gesture.Pan()
    .withTestId('create-book-sheet-dismiss-pan')
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

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen" transparent visible={visible}>
      <GestureHandlerRootView style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="create-book-sheet-backdrop"
        />
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, animatedSheetStyle, { paddingBottom: getBottomSheetBottomPadding(insets.bottom, false) }]}
          testID="create-book-sheet"
        >
          <GestureDetector gesture={drawerDrag}>
            <View collapsable={false} style={styles.dragRegion}>
              <View style={styles.handle} />
            </View>
          </GestureDetector>

          {visible ? (
            <CreateBookSheetBody
              childFirstName={childFirstName}
              onImportPhotos={onImportPhotos}
              onSelect={(option) => onSelect(option)}
              rows={rows}
              suggestions={suggestions}
              todayIso={todayIso}
            />
          ) : null}
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
    marginTop: 10,
    marginBottom: 6,
    width: 40,
  },
  dragRegion: { minHeight: 24 },
  scrollContent: { paddingBottom: 24, paddingHorizontal: spacing.lg },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 21, marginBottom: 6 },
  subtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginBottom: 16 },
  suggestionsList: { gap: 10 },
  suggestionRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 16,
    flexDirection: 'row',
    gap: 10,
    padding: 14,
  },
  rowPressed: { opacity: 0.85 },
  suggestionTextBlock: { flex: 1, gap: 3 },
  suggestionLabel: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 17 },
  suggestionMeta: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5 },
  thinChip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.sunSoft,
    borderRadius: radius.pill,
    marginTop: 2,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  thinChipText: { color: colors.sunInk, fontFamily: fonts.sansMedium, fontSize: 10.5 },
  chevronFallback: { color: colors.ink3, fontSize: 16 },
  moreToggle: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 4,
    marginTop: 18,
    paddingVertical: 6,
  },
  moreToggleText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13.5 },
  notEnough: { gap: 10 },
  notEnoughHeadline: { color: colors.ink, fontFamily: fonts.display, fontSize: 19, lineHeight: 25 },
  notEnoughBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  progressTrack: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    height: 8,
    marginTop: 4,
    overflow: 'hidden',
  },
  progressFill: { backgroundColor: colors.primary, borderRadius: radius.pill, height: '100%' },
  progressLabel: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 11.5 },
  importCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    gap: 6,
    marginTop: 8,
    padding: 16,
  },
  importTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14 },
  importBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18 },
  importButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    marginTop: 8,
    paddingVertical: 12,
  },
  importButtonText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 14.5 },
  groupedList: { gap: 20, marginTop: 14 },
  groupedSection: { gap: 8 },
  groupedSectionTitle: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  groupedRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 12,
  },
  groupedLabel: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 16 },
  groupedLabelMuted: { color: colors.ink3 },
  groupedStatusText: { fontFamily: fonts.sansMedium, fontSize: 12 },
});
