// The redesigned Keepsakes tab (docs/plans/keepsakes-redesign.md D2): the page
// header, a slim "needs you" line, the "Make something" storefront (owners and
// managers) and "Your keepsakes", the library with one shelf per year.
// Viewers get "Family films": films only, no storefront, no banner.
//
// The tab owns every query (members, films, books, the overview and the one
// `useHolidayCard`), the filter, the open-years set, the retry host for failed
// books and the toast, so the viewer's header filter button and the owner's
// section button drive the same state and sheet. Tab screens never unmount:
// the screen passes the real focus state and a fresh `todayIso` on every focus.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { KeepsakesFilterButton } from '@/components/keepsakes/keepsakes-filter-button';
import { KeepsakesFilterSheet, keepsakesSheetFilterCount } from '@/components/keepsakes/keepsakes-filter-sheet';
import { KeepsakesLibrary } from '@/components/keepsakes/keepsakes-library';
import { MakeSomethingRow } from '@/components/keepsakes/make-something-row';
import { NeedsYouBanner } from '@/components/keepsakes/needs-you-banner';
import { BookToast } from '@/components/memory-books/book-toast';
import { MemoryBookFlowHost, type BookFlow } from '@/components/memory-books/memory-books-body';
import { colors, fonts, spacing } from '@/constants/theme';
import { KEEPSAKE_PRODUCTS, type KeepsakeProductId } from '@/constants/keepsake-products';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useHolidayCard } from '@/hooks/useHolidayCard';
import { useFamilyMemoryBooks } from '@/hooks/useMemoryBooks';
import { useKeepsakesOverview } from '@/hooks/useKeepsakesOverview';
import { useFamilyYearFilms } from '@/hooks/useYearFilms';
import { consumePendingKeepsakesToast } from '@/lib/keepsakes-toast';
import { trackEvent } from '@/services/analytics';
import { holidayCardWebUrl } from '@/services/holiday-cards';
import { memoryBookWebUrl } from '@/services/memory-books';
import { openShopUrl } from '@/services/web-handoff';
import { isOwnChild } from '@/utils/family-relationships';
import {
  activeCardFront,
  buildRelevantBookRows,
  buildShelfItems,
  DEFAULT_KEEPSAKES_FILTER,
  isUpcomingItem,
  pickNeedsYou,
  reconcileKeepsakesFilter,
  type BookShelfItem,
  type KeepsakesFilter,
} from '@/utils/keepsakes';
import { canEditFamilyContent } from '@/utils/roles';

// The floating tab bar sits max(28, insets.bottom + 8) above the screen bottom
// on Android (28 on iOS) and is ~50pt tall -- the same geometry MemoryFab clears.
const TAB_BAR_HEIGHT = 50;
const TAB_BAR_GAP = 12;
const CONTENT_BOTTOM_PADDING = 130;

export interface KeepsakesTabProps {
  /** The tab's real focus state (tab screens never unmount). */
  isFocused: boolean;
  /** The screen's local "today" (`YYYY-MM-DD`), recomputed on every focus. */
  todayIso: string;
}

export function KeepsakesTab({ isFocused, todayIso }: KeepsakesTabProps) {
  const { familyId, role } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const insets = useSafeAreaInsets();
  const { members, isLoading: isLoadingMembers } = useFamilyMembers();

  // Viewers never see books or cards (owner decision 2026-09-15): they are not even fetched.
  const books = useFamilyMemoryBooks({ familyId: canEdit ? familyId : null, isFocused });
  // Films arrive by push, the drawer or this focus refetch; only while one is
  // remaking/updating does the hook poll (every 20 s, only while focused).
  const films = useFamilyYearFilms(familyId, { isFocused });
  const { overview } = useKeepsakesOverview(familyId, { isFocused });
  const holiday = useHolidayCard(familyId, { enabled: canEdit, isFocused });

  const { refetch: refetchFilms } = films;
  useEffect(() => {
    if (isFocused) void refetchFilms({ cancelRefetch: false });
  }, [isFocused, refetchFilms]);
  const { refetch: refetchHoliday } = holiday;
  useEffect(() => {
    if (canEdit && isFocused && familyId) void refetchHoliday({ cancelRefetch: false });
  }, [canEdit, familyId, isFocused, refetchHoliday]);

  const [rawFilter, setFilter] = useState<KeepsakesFilter>(DEFAULT_KEEPSAKES_FILTER);
  const [openYears, setOpenYears] = useState<ReadonlySet<number>>(() => new Set());
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [flow, setFlow] = useState<BookFlow | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // The tab never unmounts, and switching families is real: start clean
  // (adjusting state while rendering, the documented reset-on-prop-change pattern).
  const [stateFamilyId, setStateFamilyId] = useState(familyId);
  if (stateFamilyId !== familyId) {
    setStateFamilyId(familyId);
    setFilter(DEFAULT_KEEPSAKES_FILTER);
    setOpenYears(new Set());
    setFlow(null);
  }

  // A product page leaves a one-shot toast for the tab to show.
  useEffect(() => {
    if (!isFocused) return;
    const pending = consumePendingKeepsakesToast();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hand-off from a module store the product pages write to
    if (pending) setToastMessage(pending);
  }, [isFocused]);

  const cardSummary = canEdit ? holiday.summary : null;
  const bookRows = useMemo(
    () => (canEdit ? buildRelevantBookRows({ booksByChild: books.booksByChild, members, todayIso }) : []),
    [books.booksByChild, canEdit, members, todayIso],
  );
  const items = useMemo(
    () => buildShelfItems({ films: films.films, bookRows, cardSummary, overview, members, role, todayIso }),
    [bookRows, cardSummary, films.films, members, overview, role, todayIso],
  );
  const needsYou = useMemo(
    () => pickNeedsYou({ cardSummary, bookRows, members, role, todayIso }),
    [bookRows, cardSummary, members, role, todayIso],
  );
  const ownChildren = useMemo(() => {
    const today = new Date(`${todayIso}T12:00:00`);
    return members.filter((member) => isOwnChild(member, today));
  }, [members, todayIso]);

  const isLoading =
    isLoadingMembers || films.isLoading || (canEdit && (books.isLoading || holiday.isLoading));
  const hasError = films.isError || books.isError;

  // A selection whose child or year no longer exists in the items is dropped
  // (derived, not synced: it comes back if the item does).
  const filter = useMemo(
    () => (isLoading ? rawFilter : reconcileKeepsakesFilter(rawFilter, items)),
    [isLoading, items, rawFilter],
  );

  const hasRealItems = items.some((item) => !isUpcomingItem(item));

  const handleBookPress = useCallback(
    (item: BookShelfItem) => {
      const { row } = item;
      if (row.status === 'ready') {
        void openShopUrl(memoryBookWebUrl(row.book.id));
        return;
      }
      if (row.status === 'failed' && canEdit && row.book.child_id) {
        setFlow({ memberId: row.book.child_id, mode: 'retry', option: row.option, visible: true });
      }
      // 'in_progress' -- no-op, the tile Pressable is disabled for it anyway.
    },
    [canEdit],
  );

  const handleNeedsYouPress = () => {
    if (!needsYou) return;
    if (needsYou.target.type === 'card') {
      void openShopUrl(holidayCardWebUrl(needsYou.target.cardId));
      return;
    }
    setFlow({ memberId: needsYou.target.memberId, mode: 'retry', option: needsYou.target.option, visible: true });
  };

  const handleOpenProduct = (productId: KeepsakeProductId) => {
    const product = KEEPSAKE_PRODUCTS.find((candidate) => candidate.id === productId);
    if (!product) return;
    trackEvent('keepsakes_product_opened', { product: productId });
    router.push(product.route());
  };

  const handleToggleYear = (year: number, nextOpen: boolean) => {
    setOpenYears((current) => {
      const next = new Set(current);
      if (nextOpen) next.add(year);
      else next.delete(year);
      return next;
    });
    trackEvent('keepsakes_year_toggled', { year, open: nextOpen });
  };

  const handleApplyFilter = (applied: KeepsakesFilter) => {
    setFilter(applied);
    setIsFilterOpen(false);
    trackEvent('keepsakes_filter_applied', {
      type: applied.type,
      has_year: applied.year !== null,
      has_child: applied.memberId !== null,
    });
  };

  const flowMember = flow ? members.find((member) => member.id === flow.memberId) ?? null : null;
  const tabBarBottom = Platform.OS === 'android' ? Math.max(28, insets.bottom + 8) : 28;
  const toastBottom = tabBarBottom + TAB_BAR_HEIGHT + TAB_BAR_GAP;
  // The storefront shows the family's real card once one exists for this season.
  const cardFront = useMemo(
    () => activeCardFront(overview, cardSummary, todayIso),
    [cardSummary, overview, todayIso],
  );
  const firstChild = ownChildren[0] ? { id: ownChildren[0].id, name: ownChildren[0].name } : null;

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']}>
        <View style={styles.header} testID="keepsakes-header">
          <Text accessibilityRole="header" style={styles.title}>
            {canEdit ? 'Keepsakes' : 'Family films'}
          </Text>
          {!canEdit && hasRealItems ? (
            <KeepsakesFilterButton
              activeCount={keepsakesSheetFilterCount(filter)}
              onPress={() => setIsFilterOpen(true)}
            />
          ) : null}
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {hasError ? (
          <View style={styles.errorState} testID="keepsakes-error">
            <Text style={styles.errorText}>Couldn’t load your keepsakes.</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void films.refetch();
                void books.refetch();
              }}
              testID="keepsakes-retry-load"
            >
              <Text style={styles.errorRetry}>Try again</Text>
            </Pressable>
          </View>
        ) : isLoading ? (
          <ActivityIndicator color={colors.primary} style={styles.loading} testID="keepsakes-loading" />
        ) : (
          <>
            {canEdit && needsYou ? <NeedsYouBanner label={needsYou.label} onPress={handleNeedsYouPress} /> : null}
            {canEdit ? (
              <MakeSomethingRow
                canEdit={canEdit}
                cardFront={cardFront}
                firstChild={firstChild}
                holidayCardEnabled={cardSummary?.enabled === true}
                language={cardSummary?.language ?? 'en'}
                onOpenProduct={handleOpenProduct}
                overview={overview}
                year={Number(todayIso.slice(0, 4))}
              />
            ) : null}
            <KeepsakesLibrary
              filter={filter}
              items={items}
              members={members}
              onBookPress={handleBookPress}
              onOpenFilter={() => setIsFilterOpen(true)}
              onResetFilter={() => setFilter(DEFAULT_KEEPSAKES_FILTER)}
              onSelectChild={(memberId) => setFilter((current) => ({ ...current, memberId }))}
              onToggleYear={handleToggleYear}
              openYears={openYears}
              overview={overview}
              role={role}
              todayIso={todayIso}
            />
          </>
        )}
      </ScrollView>

      <KeepsakesFilterSheet
        canChooseType={canEdit}
        filter={filter}
        items={items}
        onApply={handleApplyFilter}
        onClose={() => setIsFilterOpen(false)}
        visible={isFilterOpen}
      />

      <BookToast bottomOffset={toastBottom} message={toastMessage} onDismiss={() => setToastMessage(null)} />

      {flow && flowMember ? (
        <MemoryBookFlowHost
          flow={flow}
          key={flowMember.id}
          member={flowMember}
          onClose={() => setFlow((current) => (current ? { ...current, visible: false } : current))}
          onToast={setToastMessage}
          todayIso={todayIso}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bg, flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 4,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 32, lineHeight: 38 },
  content: { paddingBottom: CONTENT_BOTTOM_PADDING },
  loading: { marginTop: 48 },
  errorState: { alignItems: 'flex-start', gap: 8, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  errorText: { color: colors.error, fontFamily: fonts.sans, fontSize: 14 },
  errorRetry: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13.5 },
});
