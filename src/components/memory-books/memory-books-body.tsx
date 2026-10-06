// Keepsakes body -- Memory Books and Year Films in ONE scroll, shared by the
// Keepsakes tab (year sections: family films + a shelf per child) and the
// per-child route `keepsakes/[memberId]` (birthday films above one child's
// books, opened from the child profile's "See {name}'s keepsakes" link).
// docs/plans/timeline-calendar-keepsakes.md C2-C5 and
// docs/plans/year-film-p2.md Step 7; supersedes the single-child screen at family/[id]/memory-books
// (owner-approved picker-redesign brief, 2026-09-17). See
// docs/features/keepsakes.md for the contract.
//
// Data: ONE family-wide books query (useFamilyMemoryBooks) drives every
// shelf, so shelf membership and contents can't disagree. The per-child
// create/retry flow (useMemoryBooks: eligibility counts, example cover, the
// generate call) only mounts once a flow starts, for that one child.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BookCoverTile, type BookCoverTileStatus } from '@/components/memory-books/book-cover-tile';
import { HolidayCardTile } from '@/components/keepsakes/holiday-card-tile';
import { KeepsakeFilmTile } from '@/components/keepsakes/keepsake-film-tile';
import { KeepsakeYearSection } from '@/components/keepsakes/keepsake-year-section';
import { BookToast } from '@/components/memory-books/book-toast';
import { ChildPickerSheet } from '@/components/memory-books/child-picker-sheet';
import { CreateBookSheet } from '@/components/memory-books/create-book-sheet';
import { RetryBookSheet } from '@/components/memory-books/retry-book-sheet';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyYearFilms, useYearFilmsEnabled } from '@/hooks/useYearFilms';
import {
  buildMemoryBookRows,
  useFamilyMemoryBooks,
  useMemoryBooks,
  type MemoryBookScopeRow,
} from '@/hooks/useMemoryBooks';
import { trackEvent } from '@/services/analytics';
import type { FamilyMember } from '@/services/family-members';
import { fetchExampleCoverAssetKey, memoryBookWebUrl } from '@/services/memory-books';
import { openShopUrl } from '@/services/web-handoff';
import { familyRosterRoute } from '@/lib/routes';
import { getMemberAvatarImageKey } from '@/utils/family-members';
import { isOwnChild } from '@/utils/family-relationships';
import {
  buildMemoryBookScopeOptions,
  formatYearRange,
  memoryBookScopeKey,
  parseDateParts,
  pickSuggestedScopes,
  type MemoryBookScopeOption,
} from '@/utils/memory-book-scope';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { canEditFamilyContent } from '@/utils/roles';
import { buildKeepsakeYears } from '@/utils/year-films';

const CTA_HEIGHT = 54;
// The floating tab bar sits max(28, insets.bottom + 8) above the screen
// bottom on Android (28 on iOS) and is ~50pt tall -- the same geometry
// MemoryFab clears. On the tab, the CTA sits just above it.
const TAB_BAR_HEIGHT = 50;
const TAB_BAR_GAP = 12;

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
  width,
}: {
  row: MemoryBookScopeRow;
  childFirstName: string;
  onPress: () => void;
  /** Fixed width inside a horizontal year shelf; the stack route's wrapped grid uses `gridItem`. */
  width?: number;
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
      style={width ? { width } : styles.gridItem}
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

interface Shelf {
  member: FamilyMember;
  rows: MemoryBookScopeRow[];
  // Rows that have a book, newest request first.
  shelfRows: MemoryBookScopeRow[];
}

type BookFlow =
  | { memberId: string; mode: 'create'; visible: boolean }
  | { memberId: string; mode: 'retry'; option: MemoryBookScopeOption; visible: boolean };

/**
 * The create/retry sheets for ONE child, mounted only once a flow starts
 * (and kept mounted after its sheet closes so an in-flight generate call can
 * finish and refresh the shelves). Eligibility counts and the example cover
 * therefore load per sheet-open, not per shelf.
 */
function MemoryBookFlowHost({
  flow,
  member,
  todayIso,
  onClose,
  onToast,
}: {
  flow: BookFlow;
  member: FamilyMember;
  todayIso: string;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const { familyId } = useFamily();
  const { rows, generate } = useMemoryBooks({
    familyId,
    childId: member.id,
    dateOfBirth: member.date_of_birth ?? null,
    todayIso,
  });
  const rowsByScopeKey = useMemo(
    () => Object.fromEntries(rows.map((row) => [row.key, row.book !== null])),
    [rows],
  );
  const suggestions = useMemo(
    () => pickSuggestedScopes(rows.map((row) => row.option), rowsByScopeKey, todayIso),
    [rows, rowsByScopeKey, todayIso],
  );
  const retryOption = flow.mode === 'retry' ? flow.option : null;
  const retryKey = retryOption ? memoryBookScopeKey(retryOption) : null;
  const isPendingRetry = retryKey ? Boolean(rows.find((row) => row.key === retryKey)?.isPending) : false;

  return (
    <>
      <CreateBookSheet
        childFirstName={member.name}
        onClose={onClose}
        onImportPhotos={
          isGalleryImportFeatureEnabled
            ? () => {
                onClose();
                router.push({ pathname: '/(app)/gallery-import' as never, params: { surface: 'keepsakes' } });
              }
            : undefined
        }
        onSelect={(option) => {
          onClose();
          void generate(option);
          onToast(`We’re making your ${option.label} book. We’ll let you know when it’s ready.`);
        }}
        rows={rows}
        suggestions={suggestions}
        todayIso={todayIso}
        visible={flow.visible && flow.mode === 'create'}
      />
      <RetryBookSheet
        childFirstName={member.name}
        isPending={isPendingRetry}
        onCancel={onClose}
        onConfirm={() => {
          if (!retryOption) return;
          void generate(retryOption);
          onClose();
          onToast('Starting that book again. Ready in about 3 minutes.');
        }}
        option={retryOption}
        visible={flow.visible && flow.mode === 'retry'}
      />
    </>
  );
}

const SHELF_BOOK_TILE_WIDTH = 150;
const SHELF_FIRST_BOOK_TILE_WIDTH = 190;
const CHILD_FILM_TILE_WIDTH = 112;

export interface KeepsakesBodyProps {
  variant: 'tab' | 'stack';
  // Stack variant: the one child whose shelf this is.
  memberId?: string;
  todayIso: string;
  isFocused: boolean;
}

export function KeepsakesBody({ variant, memberId, todayIso, isFocused }: KeepsakesBodyProps) {
  const { familyId, role } = useFamily();
  const canGenerate = canEditFamilyContent(role);
  const insets = useSafeAreaInsets();
  const { members, isLoading: isLoadingMembers } = useFamilyMembers();
  // Viewers never see books on the tab (owner decision 2026-09-15), so the
  // tab doesn't even fetch them; the stack route still shows existing books
  // read-only.
  const { booksByChild, isLoading, isError, refetch } = useFamilyMemoryBooks({
    familyId: variant === 'tab' && !canGenerate ? null : familyId,
    isFocused,
  });
  // Films arrive by push, the drawer or this focus refetch (tab screens never
  // unmount); only while one is remaking/updating does the hook poll (every
  // 20 s, and only while this screen is focused).
  const {
    films,
    isLoading: isLoadingFilms,
    refetch: refetchFilms,
  } = useFamilyYearFilms(familyId, { isFocused });
  const { enabled: upcomingEnabled } = useYearFilmsEnabled(variant === 'tab' ? familyId : null);
  useEffect(() => {
    if (isFocused) void refetchFilms({ cancelRefetch: false });
  }, [isFocused, refetchFilms]);

  const shelves = useMemo<Shelf[]>(() => {
    const today = new Date(`${todayIso}T12:00:00`);
    const shelfMembers = memberId
      ? members.filter((member) => member.id === memberId)
      : members.filter((member) => (booksByChild.get(member.id)?.length ?? 0) > 0 || isOwnChild(member, today));
    return shelfMembers.map((member) => {
      const rows = buildMemoryBookRows(
        buildMemoryBookScopeOptions(member.date_of_birth ?? null, todayIso),
        booksByChild.get(member.id) ?? [],
      );
      const shelfRows = rows
        .filter((row) => row.book !== null)
        .sort((a, b) => (b.book!.created_at < a.book!.created_at ? -1 : b.book!.created_at > a.book!.created_at ? 1 : 0));
      return { member, rows, shelfRows };
    });
  }, [booksByChild, memberId, members, todayIso]);
  const hasBooks = shelves.some((shelf) => shelf.shelfRows.length > 0);

  // The stack route shows only this child's birthday films (all years, newest first).
  const childFilms = useMemo(
    () =>
      memberId
        ? films
            .filter((film) => film.kind === 'birthday' && film.family_member_id === memberId)
            .sort((a, b) => (a.placement_date < b.placement_date ? 1 : a.placement_date > b.placement_date ? -1 : 0))
        : [],
    [films, memberId],
  );
  const hasFilms = variant === 'tab' ? films.length > 0 : childFilms.length > 0;

  const currentYear = Number(todayIso.slice(0, 4));
  const keepsakeYears = useMemo(() => {
    if (variant !== 'tab') return [];
    const books = canGenerate ? [...booksByChild.values()].flat() : [];
    return buildKeepsakeYears(films, books, members, todayIso);
  }, [booksByChild, canGenerate, films, members, todayIso, variant]);

  // Tab tiles come from the year sections' books, so map each book back to
  // the scope row the shelf tile needs (pickRelevantBook may drop a
  // superseded duplicate for the same scope).
  const bookRowsById = useMemo(() => {
    const map = new Map<string, MemoryBookScopeRow>();
    for (const shelf of shelves) for (const row of shelf.shelfRows) map.set(row.book!.id, row);
    return map;
  }, [shelves]);

  // The example cover: one real photo of the (first) child -- the pitch's
  // personalized touch. Loaded only while the pitch is on screen.
  const exampleMember = shelves[0]?.member ?? null;
  // A found photo/illustration stays put for 30 minutes (the random pick
  // shouldn't reshuffle on every visit). While there's none yet -- the
  // portrait fallback below is showing -- re-check on every tab focus, so the
  // first illustration replaces the portrait as soon as it lands.
  const exampleCoverQuery = useQuery({
    queryKey: ['memory-book-example-cover', familyId, exampleMember?.id],
    queryFn: async () => (await fetchExampleCoverAssetKey(familyId!, exampleMember!.id)).data,
    enabled: Boolean(familyId && exampleMember && !hasBooks && !hasFilms && !isLoading && isFocused),
    staleTime: (query) => (query.state.data ? 30 * 60 * 1000 : 0),
  });
  const exampleCoverKey =
    exampleCoverQuery.data ??
    (exampleMember
      ? exampleMember.resolvedPortraitVersion?.illustrated_profile_key ?? getMemberAvatarImageKey(exampleMember)
      : null);

  const [flow, setFlow] = useState<BookFlow | null>(null);
  const [isChildPickerVisible, setIsChildPickerVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const flowMember = flow ? members.find((member) => member.id === flow.memberId) ?? null : null;

  const startCreate = (forMemberId: string) => setFlow({ memberId: forMemberId, mode: 'create', visible: true });

  const handleCreatePress = () => {
    trackEvent('keepsakes_create_book_tapped', { children_count: shelves.length });
    if (shelves.length === 0) {
      router.navigate(familyRosterRoute);
      return;
    }
    if (shelves.length === 1) {
      startCreate(shelves[0]!.member.id);
      return;
    }
    setIsChildPickerVisible(true);
  };

  const handleTilePress = (shelf: Shelf, row: MemoryBookScopeRow) => {
    if (row.status === 'ready' && row.book) {
      void openShopUrl(memoryBookWebUrl(row.book.id));
      return;
    }
    if (row.status === 'failed' && canGenerate) {
      setFlow({ memberId: shelf.member.id, mode: 'retry', option: row.option, visible: true });
    }
    // 'in_progress' -- no-op, the tile Pressable is disabled for it anyway.
  };

  const tabBarBottom = Platform.OS === 'android' ? Math.max(28, insets.bottom + 8) : 28;
  const ctaBottom = variant === 'tab' ? tabBarBottom + TAB_BAR_HEIGHT + TAB_BAR_GAP : 20 + insets.bottom;
  const contentBottomPadding = canGenerate ? ctaBottom + CTA_HEIGHT + 24 : variant === 'tab' ? 130 : 40;

  const singleShelf = variant === 'stack' ? shelves[0] : undefined;
  const ctaLabel = variant === 'tab' && shelves.length === 0 ? 'Go to Family' : 'Create a book';

  // "Create {name}'s first book": owners/managers, for a child with no book
  // at all -- and only once there's something else on screen (a family with
  // no books and no films gets the one family pitch instead).
  const canShowFirstBookTile = (member: FamilyMember) =>
    canGenerate &&
    (hasBooks || hasFilms) &&
    (booksByChild.get(member.id)?.length ?? 0) === 0 &&
    shelves.some((shelf) => shelf.member.id === member.id);

  const renderFirstBookTile = (member: FamilyMember, inRow: boolean) => (
    <Pressable
      accessibilityRole="button"
      key={`first-book-${member.id}`}
      onPress={() => startCreate(member.id)}
      style={({ pressed }) => [
        styles.firstBookTile,
        inRow && { width: SHELF_FIRST_BOOK_TILE_WIDTH },
        pressed && styles.firstBookTilePressed,
      ]}
      testID={`memory-books-first-book-${member.id}`}
    >
      <Text style={styles.firstBookText}>Create {member.name}’s first book</Text>
    </Pressable>
  );

  // The tab holds films too (2026-10-02). Once films are really coming
  // (`year_films_enabled`: 10+ moments this month and a kid with a birthday)
  // the current year's section already shows the dated upcoming-recap card;
  // before that -- every brand-new family -- this pitch is the whole tab, so
  // it says what makes a film instead of promising one. The Family-page
  // stack variant stays books-only.
  const hasKidBirthday = members.some((member) => isOwnChild(member) && Boolean(member.date_of_birth));
  const filmsIntro =
    variant === 'tab' && !upcomingEnabled ? (
      <View style={[styles.emptyState, styles.filmsIntro]} testID="keepsakes-films-intro">
        <Text style={styles.emptyEyebrow}>FILMS</Text>
        <Text style={styles.emptyHeadline}>A little film of your month.</Text>
        <Text style={styles.emptyBody}>
          Any month with 10 or more moments becomes a short film on the 1st.{' '}
          {hasKidBirthday
            ? 'Birthdays get their own film too.'
            : 'Birthdays get their own film too, once your kids’ birthdays are in Family.'}
        </Text>
      </View>
    ) : null;

  const pitch = (
    <View style={styles.emptyState} testID="memory-books-empty">
      {filmsIntro}
      <Text style={styles.emptyEyebrow}>{filmsIntro ? 'BOOKS' : 'KEEPSAKES'}</Text>
      <Text style={styles.emptyHeadline}>
        {singleShelf
          ? `A year of ${singleShelf.member.name}, printed and bound.`
          : 'Your family’s years, printed and bound.'}
      </Text>
      <Text style={styles.emptyBody}>
        {singleShelf
          ? `We gather ${singleShelf.member.name}’s memories: the words, the photos, the illustrations.`
          : 'We gather your memories: the words, the photos, the illustrations.'}
        {' '}They become a premium layflat book, ready to look through in about 3 minutes, shipped to your door.
      </Text>

      {exampleMember ? (
        <View style={styles.exampleCoverWrap}>
          <BookCoverTile
            childFirstName={exampleMember.name}
            coverAssetKey={exampleCoverKey}
            scopeLabel="Year One"
            status="ready"
            testID="memory-books-example-cover"
            washId={`example-${exampleMember.id}`}
            yearRangeLabel={(() => {
              const birthYear = exampleMember.date_of_birth ? parseDateParts(exampleMember.date_of_birth).year : null;
              return birthYear ? `${birthYear} – ${birthYear + 1}` : null;
            })()}
          />
        </View>
      ) : null}

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

      {variant === 'tab' && shelves.length === 0 ? (
        <Text style={styles.noChildHint} testID="memory-books-no-child-hint">
          Books start from your child’s profile. Add them (with their birthday) in Family.
        </Text>
      ) : null}
    </View>
  );

  const renderTab = (): ReactNode => {
    // Viewers see films only -- no book UI (owner decision 2026-09-15 keeps
    // books manager-only). Nothing to show yet: the gentle line.
    if (!canGenerate && !hasFilms) {
      return (
        <View style={styles.viewerEmpty} testID="keepsakes-viewer-empty">
          <Text style={styles.viewerEmptyText}>Books and films your family makes will show up here.</Text>
        </View>
      );
    }
    return (
      <>
        {/* Own block above the year sections: an empty year renders nothing,
            which must never hide the holiday-card entry. */}
        <HolidayCardTile canEdit={canGenerate} familyId={familyId} isFocused={isFocused} todayIso={todayIso} />
        {keepsakeYears.map((year) => (
          <KeepsakeYearSection
            key={year.year}
            members={members}
            renderBookTile={(book, member) => {
              const row = bookRowsById.get(book.id);
              const shelf = shelves.find((candidate) => candidate.member.id === member.id);
              if (!row || !shelf) return null;
              return (
                <ShelfTile
                  childFirstName={member.name}
                  key={row.key}
                  onPress={() => handleTilePress(shelf, row)}
                  row={row}
                  width={SHELF_BOOK_TILE_WIDTH}
                />
              );
            }}
            renderShelfExtra={(member) =>
              year.year === currentYear && canShowFirstBookTile(member) ? renderFirstBookTile(member, true) : null
            }
            showUpcoming={upcomingEnabled && year.year === currentYear}
            todayIso={todayIso}
            year={year}
          />
        ))}
        {!hasBooks && !hasFilms ? pitch : null}
      </>
    );
  };

  const renderStack = (): ReactNode => (
    <>
      {childFilms.length > 0 ? (
        <View style={styles.shelf} testID="keepsakes-child-films">
          <View style={styles.shelfHeaderRow}>
            <Text style={styles.eyebrow}>BIRTHDAY FILMS</Text>
            <Text style={styles.countText}>
              {childFilms.length} {childFilms.length === 1 ? 'film' : 'films'}
            </Text>
          </View>
          <ScrollView
            contentContainerStyle={styles.filmRow}
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
          >
            {childFilms.map((film) => (
              <KeepsakeFilmTile film={film} key={film.id} members={members} showSubtitle width={CHILD_FILM_TILE_WIDTH} />
            ))}
          </ScrollView>
        </View>
      ) : null}
      {hasBooks ? (
        shelves.map((shelf) => (
          <View key={shelf.member.id} style={styles.shelf} testID={`memory-books-shelf-${shelf.member.id}`}>
            <Text style={styles.subtitle}>
              Turn {shelf.member.name}’s memories into a premium keepsake book.
            </Text>
            <View style={styles.shelfHeaderRow}>
              <Text style={styles.eyebrow}>YOUR BOOKS</Text>
              <Text style={styles.countText}>
                {shelf.shelfRows.length} {shelf.shelfRows.length === 1 ? 'book' : 'books'}
              </Text>
            </View>
            <View style={styles.grid}>
              {shelf.shelfRows.map((row) => (
                <ShelfTile
                  childFirstName={shelf.member.name}
                  key={row.key}
                  onPress={() => handleTilePress(shelf, row)}
                  row={row}
                />
              ))}
            </View>
          </View>
        ))
      ) : hasFilms ? (
        singleShelf && canGenerate ? renderFirstBookTile(singleShelf.member, false) : null
      ) : (
        pitch
      )}
    </>
  );

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
        showsVerticalScrollIndicator={false}
      >
        {isError ? (
          <View style={styles.errorState} testID="memory-books-error">
            <Text style={styles.errorStateText}>Couldn’t load Memory Books.</Text>
            <Pressable onPress={() => void refetch()} testID="memory-books-retry-load">
              <Text style={styles.errorStateRetry}>Try again</Text>
            </Pressable>
          </View>
        ) : isLoading || isLoadingMembers || isLoadingFilms ? (
          <ActivityIndicator color={colors.primary} style={styles.loading} testID="memory-books-loading" />
        ) : variant === 'tab' ? (
          renderTab()
        ) : (
          renderStack()
        )}
      </ScrollView>

      <BookToast
        bottomOffset={canGenerate ? ctaBottom + CTA_HEIGHT + 12 : ctaBottom}
        message={toastMessage}
        onDismiss={() => setToastMessage(null)}
      />

      {canGenerate ? (
        <View pointerEvents="box-none" style={[styles.ctaOverlay, { paddingBottom: ctaBottom }]}>
          <LinearGradient
            colors={['rgba(250,250,253,0)', colors.bg]}
            pointerEvents="none"
            style={[styles.ctaFade, { height: ctaBottom + CTA_HEIGHT + 40 }]}
          />
          <Pressable
            accessibilityLabel={ctaLabel}
            accessibilityRole="button"
            onPress={variant === 'stack' && singleShelf ? () => startCreate(singleShelf.member.id) : handleCreatePress}
            style={({ pressed }) => [styles.ctaButton, pressed && styles.ctaButtonPressed]}
            testID="memory-books-create"
          >
            {ctaLabel === 'Create a book' ? (
              <SymbolView
                fallback={<Text style={styles.ctaIconFallback}>+</Text>}
                name={{ ios: 'plus', android: 'add' }}
                size={16}
                tintColor={colors.white}
              />
            ) : null}
            <Text style={styles.ctaButtonText}>{ctaLabel}</Text>
          </Pressable>
        </View>
      ) : null}

      <ChildPickerSheet
        onClose={() => setIsChildPickerVisible(false)}
        onSelect={(selectedId) => {
          setIsChildPickerVisible(false);
          startCreate(selectedId);
        }}
        options={shelves.map((shelf) => ({ id: shelf.member.id, name: shelf.member.name }))}
        visible={isChildPickerVisible}
      />

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
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: 8,
  },
  shelf: {
    marginBottom: 32,
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
  firstBookTile: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radius.lg,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    paddingVertical: 22,
  },
  firstBookTilePressed: { opacity: 0.8 },
  firstBookText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 14,
    paddingHorizontal: 12,
    textAlign: 'center',
  },
  filmRow: {
    alignItems: 'flex-start',
    gap: 14,
  },
  emptyState: { gap: 20 },
  filmsIntro: { marginBottom: 16 },
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
  noChildHint: {
    color: colors.ink2,
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  loading: { marginTop: 48 },
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
  viewerEmpty: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  viewerEmptyText: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 14.5,
    lineHeight: 22,
  },
  ctaOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  ctaFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
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
