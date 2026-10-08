// "Your keepsakes" (docs/plans/keepsakes-redesign.md C2): the family's
// keepsakes as one shelf per year -- films, books and the holiday card on a
// shared baseline -- with child chips, a filter button and status badges. The
// current year is always open; past years fold into a row that opens in place.
//
// Presentational: the tab (`KeepsakesTab`) owns the data, the filter, the
// open-years set and what a tap does, so the viewer's header filter button and
// the owner's section button drive the same state and sheet.
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { AllRecapsTile } from '@/components/keepsakes/all-recaps-tile';
import { KeepsakesFilterButton } from '@/components/keepsakes/keepsakes-filter-button';
import { keepsakesSheetFilterCount } from '@/components/keepsakes/keepsakes-filter-sheet';
import { ShelfItemView } from '@/components/keepsakes/shelf-item';
import { colors, fonts, radius } from '@/constants/theme';
import type { FamilyMember } from '@/services/family-members';
import type { KeepsakesOverview } from '@/services/keepsakes';
import {
  applyKeepsakesFilter,
  buildChildChips,
  groupShelfByYear,
  isUpcomingItem,
  yearSummaryLabel,
  type BookShelfItem,
  type KeepsakesFilter,
  type ShelfItem,
  type ShelfYear,
} from '@/utils/keepsakes';
import { canEditFamilyContent } from '@/utils/roles';

export const KEEPSAKES_OWNER_EMPTY_LINE = 'Films show up here on their own. Your first one is on its way.';
export const KEEPSAKES_VIEWER_EMPTY_LINE = 'Books and films your family makes will show up here.';
export const KEEPSAKES_PRIVACY_LINE = 'Books and cards are only visible to owners and managers.';

export interface KeepsakesLibraryProps {
  /** Every shelf item, unfiltered (the chips derive from it). */
  items: readonly ShelfItem[];
  members: readonly FamilyMember[];
  role: string | null | undefined;
  overview: KeepsakesOverview | null;
  todayIso: string;
  filter: KeepsakesFilter;
  onSelectChild: (memberId: string | null) => void;
  onOpenFilter: () => void;
  /** "Nothing matches this filter" -> Reset. */
  onResetFilter: () => void;
  /** Past years the user opened; the current year (and a filtered year) is always open. */
  openYears: ReadonlySet<number>;
  onToggleYear: (year: number, nextOpen: boolean) => void;
  onBookPress: (item: BookShelfItem) => void;
}

function Chevron({ direction }: { direction: 'up' | 'down' }) {
  return (
    <SymbolView
      fallback={<Text style={styles.chevronFallback}>{direction === 'down' ? '﹀' : '︿'}</Text>}
      name={{
        ios: direction === 'down' ? 'chevron.down' : 'chevron.up',
        android: direction === 'down' ? 'expand_more' : 'expand_less',
      }}
      size={14}
      tintColor={colors.ink3}
    />
  );
}

function YearShelf({
  year,
  isOpen,
  canToggle,
  members,
  role,
  overview,
  onToggle,
  onBookPress,
}: {
  year: ShelfYear;
  isOpen: boolean;
  canToggle: boolean;
  members: readonly FamilyMember[];
  role: string | null | undefined;
  overview: KeepsakesOverview | null;
  onToggle: () => void;
  onBookPress: (item: BookShelfItem) => void;
}) {
  const hasRealItems = year.items.some((item) => !isUpcomingItem(item));
  const summary = hasRealItems ? yearSummaryLabel(year.items, role) : null;

  if (!isOpen) {
    return (
      <View style={styles.foldedWrap} testID={`keepsakes-year-${year.year}`}>
        <Pressable
          accessibilityLabel={`${year.year}, ${summary ?? 'keepsakes'}, folded`}
          accessibilityRole="button"
          accessibilityState={{ expanded: false }}
          onPress={onToggle}
          style={({ pressed }) => [styles.foldedRow, pressed && styles.pressed]}
          testID={`keepsakes-year-toggle-${year.year}`}
        >
          <Text style={styles.foldedText}>
            <Text style={styles.foldedYear}>{year.year}</Text>
            {summary ? <Text style={styles.foldedSummary}>{` · ${summary}`}</Text> : null}
          </Text>
          <Chevron direction="down" />
        </Pressable>
      </View>
    );
  }

  const header = (
    <>
      <Text accessibilityRole="header" style={styles.yearTitle}>
        {year.year}
      </Text>
      <View style={styles.yearHeaderRight}>
        {summary ? <Text style={styles.yearCount}>{summary}</Text> : null}
        {canToggle ? <Chevron direction="up" /> : null}
      </View>
    </>
  );

  return (
    <View style={styles.yearSection} testID={`keepsakes-year-${year.year}`}>
      {canToggle ? (
        <Pressable
          accessibilityLabel={`${year.year}, ${summary ?? 'keepsakes'}, open`}
          accessibilityRole="button"
          accessibilityState={{ expanded: true }}
          onPress={onToggle}
          style={styles.yearHeader}
          testID={`keepsakes-year-toggle-${year.year}`}
        >
          {header}
        </Pressable>
      ) : (
        <View style={styles.yearHeader}>{header}</View>
      )}
      <ScrollView
        contentContainerStyle={styles.shelfRow}
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
      >
        {year.items.map((item) => (
          <ShelfItemView
            item={item}
            key={item.id}
            members={members}
            onBookPress={onBookPress}
            overview={overview}
          />
        ))}
        {year.showAllRecapsTile ? <AllRecapsTile year={year.year} /> : null}
      </ScrollView>
    </View>
  );
}

export function KeepsakesLibrary({
  items,
  members,
  role,
  overview,
  todayIso,
  filter,
  onSelectChild,
  onOpenFilter,
  onResetFilter,
  openYears,
  onToggleYear,
  onBookPress,
}: KeepsakesLibraryProps) {
  const canEdit = canEditFamilyContent(role);
  const hasRealItems = items.some((item) => !isUpcomingItem(item));

  if (items.length === 0) {
    if (!canEdit) {
      return (
        <View style={styles.emptyWrap} testID="keepsakes-viewer-empty">
          <Text style={styles.emptyText}>{KEEPSAKES_VIEWER_EMPTY_LINE}</Text>
        </View>
      );
    }
    return (
      <View style={styles.section} testID="keepsakes-library-empty">
        <Text accessibilityRole="header" style={styles.eyebrow}>
          Your keepsakes
        </Text>
        <Text style={styles.emptyText}>{KEEPSAKES_OWNER_EMPTY_LINE}</Text>
      </View>
    );
  }

  const chips = buildChildChips(items, members);
  const years = groupShelfByYear(applyKeepsakesFilter(items, filter), todayIso);

  return (
    <View style={styles.section} testID="keepsakes-library">
      {canEdit ? (
        <View style={styles.headerRow}>
          <Text accessibilityRole="header" style={styles.eyebrow}>
            Your keepsakes
          </Text>
          {hasRealItems ? (
            <KeepsakesFilterButton activeCount={keepsakesSheetFilterCount(filter)} onPress={onOpenFilter} />
          ) : null}
        </View>
      ) : null}

      {canEdit && overview?.has_viewers ? (
        <View style={styles.privacyRow} testID="keepsakes-privacy">
          <SymbolView
            fallback={<Text style={styles.lockFallback}>🔒</Text>}
            name={{ ios: 'lock.fill', android: 'lock' }}
            size={11}
            tintColor={colors.ink3}
          />
          <Text style={styles.privacyText}>{KEEPSAKES_PRIVACY_LINE}</Text>
        </View>
      ) : null}

      {chips.length > 0 ? (
        <ScrollView
          contentContainerStyle={styles.chipRow}
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: filter.memberId === null }}
            onPress={() => onSelectChild(null)}
            style={[styles.chip, filter.memberId === null && styles.chipActive]}
            testID="keepsakes-chip-all"
          >
            <Text style={[styles.chipText, filter.memberId === null && styles.chipTextActive]}>All</Text>
          </Pressable>
          {chips.map((member) => {
            const active = filter.memberId === member.id;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={member.id}
                onPress={() => onSelectChild(member.id)}
                style={[styles.chip, styles.chipWithAvatar, active && styles.chipActive]}
                testID={`keepsakes-chip-${member.id}`}
              >
                <FamilyMemberAvatar member={member} size={26} />
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {member.name.trim().split(/\s+/)[0]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {years.length === 0 ? (
        <View style={styles.noMatch} testID="keepsakes-filter-empty">
          <Text style={styles.emptyText}>Nothing matches this filter</Text>
          <Pressable accessibilityRole="button" onPress={onResetFilter} testID="keepsakes-filter-empty-reset">
            <Text style={styles.resetLink}>Reset</Text>
          </Pressable>
        </View>
      ) : (
        years.map((year) => {
          const forcedOpen = year.isAlwaysOpen || filter.year === year.year;
          const isOpen = forcedOpen || openYears.has(year.year);
          return (
            <YearShelf
              canToggle={!forcedOpen}
              isOpen={isOpen}
              key={year.year}
              members={members}
              onBookPress={onBookPress}
              onToggle={() => onToggleYear(year.year, !isOpen)}
              overview={overview}
              role={role}
              year={year}
            />
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 16, paddingTop: 28 },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  eyebrow: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 0.8,
    paddingHorizontal: 20,
    textTransform: 'uppercase',
  },
  privacyRow: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: -6, paddingHorizontal: 20 },
  lockFallback: { fontSize: 10 },
  privacyText: { color: colors.ink3, flex: 1, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  chipRow: { gap: 8, paddingHorizontal: 20 },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    height: 36,
    paddingHorizontal: 14,
  },
  chipWithAvatar: { paddingLeft: 5 },
  chipActive: { backgroundColor: colors.primaryTint, borderColor: colors.primarySoft },
  chipText: { color: colors.ink2, fontFamily: fonts.sansMedium, fontSize: 13.5 },
  chipTextActive: { color: colors.primaryDark, fontFamily: fonts.sansBold },
  yearSection: { gap: 12 },
  yearHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  yearTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 24, lineHeight: 30 },
  yearHeaderRight: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  yearCount: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12 },
  shelfRow: { alignItems: 'flex-start', gap: 16, paddingHorizontal: 20 },
  foldedWrap: { paddingHorizontal: 20 },
  foldedRow: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  foldedText: { flex: 1 },
  foldedYear: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14 },
  foldedSummary: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 14 },
  pressed: { opacity: 0.85 },
  chevronFallback: { color: colors.ink3, fontSize: 14 },
  emptyWrap: { paddingTop: 16 },
  emptyText: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 22, paddingHorizontal: 20 },
  noMatch: { alignItems: 'flex-start', gap: 6 },
  resetLink: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13.5, paddingHorizontal: 20 },
});
