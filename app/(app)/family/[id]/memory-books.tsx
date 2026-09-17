// Memory Books shelf (owner-approved picker-redesign brief, 2026-09-17;
// supersedes the original in-app scope picker shipped under
// docs/plans/memory-book.md §"5a.5"). Entry point: the "Memory Books" row
// on the child profile screen (app/(app)/family/[id]/index.tsx), near the
// portrait timeline. See docs/features/memory-book-generation.md's picker
// section for the full contract this screen drives.
import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BookCoverTile, type BookCoverTileStatus } from '@/components/memory-books/book-cover-tile';
import { BookToast } from '@/components/memory-books/book-toast';
import { CreateBookSheet } from '@/components/memory-books/create-book-sheet';
import { RetryBookSheet } from '@/components/memory-books/retry-book-sheet';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useMemoryBooks, type MemoryBookScopeRow } from '@/hooks/useMemoryBooks';
import { memoryBookWebUrl } from '@/services/memory-books';
import {
  formatYearRange,
  parseDateParts,
  pickSuggestedScopes,
  type MemoryBookScopeOption,
} from '@/utils/memory-book-scope';
import { getLocalTodayIso } from '@/utils/portrait-versions';
import { canEditFamilyContent } from '@/utils/roles';

const CTA_HEIGHT = 54;
const CTA_BOTTOM_CLEARANCE = 118;

function calendarYearRangeLabel(year: number): string {
  return `Jan – Dec ${year}`;
}

/** Below-tile secondary "range line" (outside the tile itself) -- age-years
 * reuse the option's own era line, calendar-years get a short "Jan – Dec
 * YYYY" line, and `everything` is omitted (this app has no live
 * "earliest memory date" query to build a "Since ..." line from yet -- the
 * brief's own documented fallback for that case). */
function rangeLineForRow(row: MemoryBookScopeRow): string | null {
  if (row.option.kind === 'age_year') return row.option.eraLine;
  if (row.option.kind === 'calendar_year' && row.option.calendarYear) {
    return calendarYearRangeLabel(row.option.calendarYear);
  }
  return null;
}

function tileDisplayStatus(row: MemoryBookScopeRow): BookCoverTileStatus {
  if (row.status === 'ready') return 'ready';
  if (row.status === 'failed') return 'failed';
  return 'generating';
}

function tileYearRangeLabel(book: { scope_start_date: string | null; scope_end_date: string | null }): string | null {
  if (!book.scope_start_date || !book.scope_end_date) return null;
  return formatYearRange(book.scope_start_date, book.scope_end_date);
}

function ShelfTile({
  row,
  childFirstName,
  onPress,
}: {
  row: MemoryBookScopeRow;
  childFirstName: string;
  onPress: () => void;
}) {
  const book = row.book!;
  const status = tileDisplayStatus(row);
  const rangeLine = rangeLineForRow(row);

  return (
    <Pressable
      accessibilityLabel={`${row.option.label} book`}
      accessibilityRole="button"
      disabled={status === 'generating'}
      onPress={onPress}
      style={styles.gridItem}
      testID={`memory-book-tile-${row.key}`}
    >
      <BookCoverTile
        cacheVersion={book.updated_at}
        childFirstName={childFirstName}
        coverAssetKey={book.cover_asset_key}
        scopeLabel={row.option.label}
        status={status}
        washId={book.id}
        yearRangeLabel={tileYearRangeLabel(book)}
      />
      <Text style={styles.shelfTileLabel}>{row.option.label}</Text>
      {rangeLine ? <Text style={styles.shelfTileRange}>{rangeLine}</Text> : null}
      {status === 'failed' ? <Text style={styles.shelfTileRetry}>Tap to try again</Text> : null}
    </Pressable>
  );
}

export default function MemoryBooksScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { familyId, role } = useFamily();
  const { members, isLoading: isLoadingMembers } = useFamilyMembers();
  const member = members.find((candidate) => candidate.id === id);
  const canGenerate = canEditFamilyContent(role);
  // The fixed CTA overlay sits outside SafeAreaView (it needs to float over
  // the ScrollView, not push it around), so it reads the bottom inset
  // directly -- otherwise it renders behind the Android system nav bar.
  const insets = useSafeAreaInsets();

  const [todayIso] = useState(() => getLocalTodayIso());

  const {
    rows,
    isLoading,
    isError,
    exampleCoverAssetKey,
    generate,
    refresh,
  } = useMemoryBooks({
    familyId,
    childId: id,
    dateOfBirth: member?.date_of_birth ?? null,
  });

  const [createSheetVisible, setCreateSheetVisible] = useState(false);
  const [retryOption, setRetryOption] = useState<MemoryBookScopeOption | null>(null);
  const [retryVisible, setRetryVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Locked design point (unchanged from the original picker): viewers see
  // books that already exist, never the affordance to start a new one --
  // RLS would reject their insert anyway, but this degrades gracefully
  // instead of relying on that error.
  const visibleRows = canGenerate ? rows : rows.filter((row) => row.book !== null);
  const shelfRows = useMemo(
    () =>
      visibleRows
        .filter((row) => row.book !== null)
        .slice()
        .sort((a, b) => (b.book!.created_at < a.book!.created_at ? -1 : b.book!.created_at > a.book!.created_at ? 1 : 0)),
    [visibleRows],
  );
  const hasBooks = shelfRows.length > 0;

  const rowsByScopeKey = useMemo(
    () => Object.fromEntries(rows.map((row) => [row.key, row.book !== null])),
    [rows],
  );
  const suggestions = useMemo(
    () => pickSuggestedScopes(rows.map((row) => row.option), rowsByScopeKey, todayIso),
    [rows, rowsByScopeKey, todayIso],
  );

  const isPendingRetry = retryOption
    ? Boolean(rows.find((row) => row.option === retryOption)?.isPending)
    : false;

  const handleSelectScope = (option: MemoryBookScopeOption) => {
    setCreateSheetVisible(false);
    void generate(option);
    setToastMessage(`We’re making your ${option.label} book. We’ll let you know when it’s ready.`);
  };

  const openRetry = (option: MemoryBookScopeOption) => {
    setRetryOption(option);
    setRetryVisible(true);
  };

  const handleRetryConfirm = () => {
    if (!retryOption) return;
    void generate(retryOption);
    setRetryVisible(false);
    setToastMessage('Starting that book again. Ready in about 3 minutes.');
  };

  const handleTilePress = (row: MemoryBookScopeRow) => {
    if (row.status === 'ready' && row.book) {
      void Linking.openURL(memoryBookWebUrl(row.book.id));
      return;
    }
    if (row.status === 'failed') {
      openRetry(row.option);
    }
    // 'in_progress' -- no-op, the tile Pressable is disabled for it anyway.
  };

  if (isLoadingMembers || isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!member) {
    return (
      <View style={styles.centered}>
        <Text style={styles.notFoundText}>Person not found</Text>
      </View>
    );
  }

  const childFirstName = member.name;
  const birthYear = member.date_of_birth ? parseDateParts(member.date_of_birth).year : null;

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.iconBtn} testID="memory-books-back">
            <SymbolView
              fallback={<Text style={styles.iconBtnText}>‹</Text>}
              name={{ ios: 'chevron.left', android: 'chevron_left' }}
              size={17}
              tintColor={colors.ink2}
            />
          </Pressable>
          <Text style={styles.headerTitle}>Memory Books</Text>
          <View style={styles.iconBtnSpacer} />
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={[styles.content, canGenerate && { paddingBottom: CTA_BOTTOM_CLEARANCE + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        {isError ? (
          <View style={styles.errorState} testID="memory-books-error">
            <Text style={styles.errorStateText}>Couldn’t load Memory Books.</Text>
            <Pressable onPress={refresh} testID="memory-books-retry-load">
              <Text style={styles.errorStateRetry}>Try again</Text>
            </Pressable>
          </View>
        ) : hasBooks ? (
          <>
            <Text style={styles.subtitle}>
              Turn {childFirstName}’s memories into a premium keepsake book.
            </Text>

            <View style={styles.shelfHeaderRow}>
              <Text style={styles.eyebrow}>YOUR BOOKS</Text>
              <Text style={styles.countText}>{shelfRows.length} {shelfRows.length === 1 ? 'book' : 'books'}</Text>
            </View>

            <View style={styles.grid}>
              {shelfRows.map((row) => (
                <ShelfTile childFirstName={childFirstName} key={row.key} onPress={() => handleTilePress(row)} row={row} />
              ))}
            </View>
          </>
        ) : (
          <View style={styles.emptyState} testID="memory-books-empty">
            <Text style={styles.emptyEyebrow}>KEEPSAKES</Text>
            <Text style={styles.emptyHeadline}>A year of {childFirstName}, printed and bound.</Text>
            <Text style={styles.emptyBody}>
              We gather {childFirstName}’s memories: the words, the photos, the illustrations. They become a
              premium layflat book, ready to look through in about 3 minutes, shipped to your door.
            </Text>

            <View style={styles.exampleCoverWrap}>
              <BookCoverTile
                childFirstName={childFirstName}
                coverAssetKey={exampleCoverAssetKey}
                scopeLabel="Year One"
                status="ready"
                testID="memory-books-example-cover"
                washId={`example-${member.id}`}
                yearRangeLabel={birthYear ? `${birthYear} – ${birthYear + 1}` : null}
              />
            </View>

            <View style={styles.bulletsCard}>
              <View style={styles.bulletRow}>
                <Text style={styles.bulletMark}>■</Text>
                <Text style={styles.bulletText}>
                  <Text style={styles.bulletBold}>Layflat, 8.3×8.3 inches.</Text> Thick pages that open completely,
                  so no memory is lost in the fold.
                </Text>
              </View>
              <View style={styles.bulletRow}>
                <Text style={styles.bulletMark}>■</Text>
                <Text style={styles.bulletText}>
                  <Text style={styles.bulletBold}>Chosen for you.</Text> We pick the moments and photos that tell
                  the year, then you can change anything.
                </Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      <BookToast
        bottomOffset={(canGenerate ? CTA_HEIGHT + 24 : 24) + insets.bottom}
        message={toastMessage}
        onDismiss={() => setToastMessage(null)}
      />

      {canGenerate ? (
        <View pointerEvents="box-none" style={[styles.ctaOverlay, { paddingBottom: 20 + insets.bottom }]}>
          <LinearGradient
            colors={['rgba(250,250,253,0)', colors.bg]}
            pointerEvents="none"
            style={styles.ctaFade}
          />
          <Pressable
            accessibilityLabel="Create a book"
            accessibilityRole="button"
            onPress={() => setCreateSheetVisible(true)}
            style={({ pressed }) => [styles.ctaButton, pressed && styles.ctaButtonPressed]}
            testID="memory-books-create"
          >
            <SymbolView
              fallback={<Text style={styles.ctaIconFallback}>+</Text>}
              name={{ ios: 'plus', android: 'add' }}
              size={16}
              tintColor={colors.white}
            />
            <Text style={styles.ctaButtonText}>Create a book</Text>
          </Pressable>
        </View>
      ) : null}

      <CreateBookSheet
        onClose={() => setCreateSheetVisible(false)}
        onSelect={handleSelectScope}
        rows={rows}
        suggestions={suggestions}
        todayIso={todayIso}
        visible={createSheetVisible}
      />

      <RetryBookSheet
        childFirstName={childFirstName}
        isPending={isPendingRetry}
        onCancel={() => setRetryVisible(false)}
        onConfirm={handleRetryConfirm}
        option={retryOption}
        visible={retryVisible}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  notFoundText: {
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.ink3,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  headerTitle: {
    fontFamily: fonts.displayMedium,
    fontSize: 17,
    color: colors.ink,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnSpacer: { width: 38, height: 38 },
  iconBtnText: {
    fontSize: 22,
    color: colors.ink2,
    fontWeight: '300',
    marginTop: -2,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: 8,
    paddingBottom: 40,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 13.5,
    color: colors.ink2,
    lineHeight: 13.5 * 1.4,
    marginBottom: 20,
  },
  shelfHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.primary,
  },
  countText: {
    fontFamily: fonts.sans,
    fontSize: 11.5,
    color: colors.ink3,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 14,
    rowGap: 26,
  },
  gridItem: {
    flexBasis: '47%',
    flexGrow: 0,
  },
  shelfTileLabel: {
    fontFamily: fonts.displayMedium,
    fontSize: 15.5,
    color: colors.ink,
    marginTop: 10,
  },
  shelfTileRange: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
    marginTop: 2,
  },
  shelfTileRetry: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    color: colors.primary,
    marginTop: 4,
  },
  emptyState: { gap: 20 },
  emptyEyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.primary,
  },
  emptyHeadline: {
    fontFamily: fonts.display,
    fontSize: 27,
    lineHeight: 32,
    color: colors.ink,
    marginTop: -12,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 13.5,
    lineHeight: 13.5 * 1.5,
    color: colors.ink2,
    marginTop: -8,
  },
  exampleCoverWrap: {
    width: 212,
    alignSelf: 'center',
    transform: [{ rotate: '-2.5deg' }],
    marginVertical: 8,
  },
  bulletsCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 14,
  },
  bulletRow: {
    flexDirection: 'row',
    gap: 10,
  },
  bulletMark: {
    color: colors.primary,
    fontSize: 10,
    marginTop: 4,
  },
  bulletText: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 13 * 1.45,
    color: colors.ink2,
  },
  bulletBold: {
    fontFamily: fonts.sansMedium,
    color: colors.ink,
  },
  errorState: { gap: 8, alignItems: 'flex-start' },
  errorStateText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.error,
  },
  errorStateRetry: {
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
    color: colors.primary,
  },
  ctaOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingBottom: 20,
  },
  ctaFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 100,
  },
  ctaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    height: CTA_HEIGHT,
    paddingHorizontal: 28,
  },
  ctaButtonPressed: { opacity: 0.88 },
  ctaButtonText: {
    fontFamily: fonts.sansBold,
    fontSize: 15.5,
    color: colors.white,
  },
  ctaIconFallback: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
  },
});
