// Memory Book product page (docs/plans/keepsakes-redesign.md D4), opened from
// the Keepsakes storefront (`?memberId=` preselects a child). A stack screen
// (no tab bar). Pick the child and the period, then make the book; no prices
// (they live in the shop). The scope-dependent part lives in
// `ChildBookPage`, KEYED BY CHILD, because `useMemoryBooks` keeps its
// `pendingKeys` / `dispatchErrors` by scope key and `everything:null:null` and
// the calendar-year keys are shared across children: one shared instance
// would leak "being made" / error state between the chips.
// See docs/features/keepsakes.md.
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FreeToMake } from '@/components/keepsakes/free-to-make';
import {
  ChoiceChip,
  EligibilityBox,
  FactsBox,
  OptionRow,
  PrivacyNote,
  ProductCtaBar,
  ProductHeading,
  ProductPageLoading,
  ProductPageShell,
  ProductStage,
  SectionLabel,
  type ProductFact,
} from '@/components/keepsakes/product-page';
import { BookCoverTile } from '@/components/memory-books/book-cover-tile';
import { colors, fonts, radius } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useKeepsakesOverview } from '@/hooks/useKeepsakesOverview';
import { useLeaveKeepsakesPage } from '@/hooks/useLeaveKeepsakesPage';
import { useFamilyMemoryBooks, useMemoryBooks } from '@/hooks/useMemoryBooks';
import { setPendingKeepsakesToast } from '@/lib/keepsakes-toast';
import { familyRosterRoute } from '@/lib/routes';
import type { FamilyMember } from '@/services/family-members';
import type { KeepsakesOverview } from '@/services/keepsakes';
import { memoryBookWebUrl } from '@/services/memory-books';
import { openShopUrl } from '@/services/web-handoff';
import { isOwnChild } from '@/utils/family-relationships';
import { splitScopeOptions, type ScopeChoice, type ScopeGroup } from '@/utils/keepsakes';
import { isGalleryImportFeatureEnabled } from '@/utils/gallery-import-flags';
import { bookCtaFor } from '@/utils/keepsake-product-pages';
import { MEMORY_BOOK_THIN_THRESHOLD, formatYearRange, type MemoryBookScopeOption } from '@/utils/memory-book-scope';
import { getLocalTodayIso } from '@/utils/portrait-versions';
import { canEditFamilyContent } from '@/utils/roles';

const MEMORY_BOOK_CTA_SUBLINE = 'Ready to look through in a few minutes.';

const BOOK_FACTS: ProductFact[] = [
  { lead: 'Layflat, 8.3×8.3 inches.', rest: 'Thick pages that open completely.' },
  { lead: 'Chosen for you.', rest: 'We pick the moments that tell the story.' },
];

const CAUTION_COPY: Record<NonNullable<ScopeChoice['caution']>, string> = {
  in_progress_year: 'Not over yet. The book holds what you’ve saved so far.',
  mid_year: 'The year isn’t over. The book holds what you’ve saved so far.',
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function scopeDisplayLabel(choice: ScopeChoice): string {
  return choice.caution === 'mid_year' ? `${choice.option.label} so far` : choice.option.label;
}

function scopeMeta(option: MemoryBookScopeOption): string | null {
  if (option.kind === 'age_year') return option.eraLine;
  if (option.kind === 'calendar_year' && option.calendarYear) return `Jan – Dec ${option.calendarYear}`;
  return null;
}

function yearRangeLabel(option: MemoryBookScopeOption): string | null {
  if (!option.startDate || !option.endDate) return null;
  return formatYearRange(option.startDate, option.endDate);
}

function newestFirst(group: ScopeGroup): ScopeGroup {
  return {
    ...group,
    choices: group.choices
      .slice()
      .sort((a, b) => (b.option.startDate ?? '').localeCompare(a.option.startDate ?? '')),
  };
}

function ThinWarning({ onImportPhotos }: { onImportPhotos?: () => void }) {
  return (
    <View style={styles.thin} testID="memory-book-thin">
      <Text style={styles.thinTitle}>Not many moments yet</Text>
      <Text style={styles.thinBody}>
        {`A book gathers about ${MEMORY_BOOK_THIN_THRESHOLD} moments. You can still make it now, or add more first.`}
      </Text>
      {onImportPhotos ? (
        <Pressable
          accessibilityRole="button"
          onPress={onImportPhotos}
          style={({ pressed }) => [styles.thinButton, pressed && styles.pressed]}
          testID="memory-book-import-photos"
        >
          <Text style={styles.thinButtonText}>Look through my photos</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

interface ChildBookPageProps {
  child: FamilyMember;
  /** Chips: every child the page can make a book for (hidden with fewer than 2). */
  siblings: FamilyMember[];
  onSelectChild: (id: string) => void;
  overview: KeepsakesOverview | null;
  todayIso: string;
}

function ChildBookPage({ child, siblings: childList, onSelectChild, overview, todayIso }: ChildBookPageProps) {
  const { familyId } = useFamily();
  const { leave } = useLeaveKeepsakesPage();
  const { rows, generate, retryDispatch } = useMemoryBooks({
    familyId,
    childId: child.id,
    dateOfBirth: child.date_of_birth ?? null,
    todayIso,
  });
  const name = firstName(child.name);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const inFlightRef = useRef(false);
  // Re-read now and then so a queued row crosses the 10-minute "stuck" line while the page is open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const split = useMemo(
    () =>
      splitScopeOptions(
        rows.map((row) => row.option),
        rows,
        todayIso,
      ),
    [rows, todayIso],
  );
  const moreGroups = useMemo(() => split.more.map(newestFirst), [split.more]);
  const moreCount = split.more.reduce((total, group) => total + group.choices.length, 0);
  const allChoices = useMemo(
    () => [...split.visible, ...moreGroups.flatMap((group) => group.choices)],
    [split.visible, moreGroups],
  );
  const selected = allChoices.find((choice) => choice.key === selectedKey) ?? split.defaultChoice;

  const onImportPhotos = isGalleryImportFeatureEnabled
    ? () => router.push({ pathname: '/(app)/gallery-import' as never, params: { surface: 'keepsakes' } })
    : undefined;

  const cta = selected ? bookCtaFor(selected, name, nowMs) : null;
  const row = selected?.row ?? null;

  const handleCta = useCallback(async () => {
    if (!selected || !cta || inFlightRef.current) return;
    const { option, row: selectedRow } = selected;
    if (cta.kind === 'open') {
      if (selectedRow?.book) void openShopUrl(memoryBookWebUrl(selectedRow.book.id));
      return;
    }
    inFlightRef.current = true;
    try {
      if (cta.kind === 'redispatch' && selectedRow?.book) {
        await retryDispatch(option, selectedRow.book.id);
        return;
      }
      if (cta.kind === 'make' || cta.kind === 'retry') {
        const result = await generate(option);
        if (result === 'started') {
          setPendingKeepsakesToast(`We’re making your ${option.label} book…`);
          leave();
        }
        // 'exists': the row refetches and shows its real status. 'error':
        // the row's dispatchError is shown inline.
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [selected, cta, generate, retryDispatch, leave]);

  const renderChoice = (choice: ScopeChoice) => (
    <OptionRow
      caution={choice.caution ? CAUTION_COPY[choice.caution] : null}
      key={choice.key}
      label={scopeDisplayLabel(choice)}
      meta={scopeMeta(choice.option)}
      onPress={() => setSelectedKey(choice.key)}
      selected={selected?.key === choice.key}
      status={choice.statusLabel}
      testID={`memory-book-scope-${choice.key}`}
    />
  );

  const eligibleCount = row?.eligibleCount ?? null;
  const isThin = row?.status === 'thin';
  const coverKey = overview?.book_preview_keys[child.id] ?? null;

  return (
    <ProductPageShell
      footer={
        cta ? (
          <ProductCtaBar
            disabled={cta.kind === 'busy'}
            isBusy={Boolean(row?.isPending)}
            label={cta.label}
            onPress={() => void handleCta()}
            subline={MEMORY_BOOK_CTA_SUBLINE}
            testID="memory-book-product-cta"
          />
        ) : undefined
      }
      onBack={leave}
      testID="keepsakes-product-memory-book"
    >
      <ProductStage testID="memory-book-product-stage">
        <View style={styles.cover}>
          <BookCoverTile
            childFirstName={name}
            coverAssetKey={coverKey}
            scopeLabel={selected?.option.label ?? 'Everything'}
            status="ready"
            washId={child.id}
            yearRangeLabel={selected ? yearRangeLabel(selected.option) : null}
          />
        </View>
      </ProductStage>
      <ProductHeading
        body={`Pick a stretch of ${name}’s story. We gather the moments from it, and you can change anything afterwards.`}
        eyebrow="Memory book"
        title={`A year of ${name}, printed and bound.`}
      />
      <FreeToMake product="book" />

      {childList.length >= 2 ? (
        <View style={styles.section}>
          <SectionLabel>Who it’s for</SectionLabel>
          <View style={styles.chips}>
            {childList.map((candidate) => (
              <ChoiceChip
                key={candidate.id}
                label={firstName(candidate.name)}
                onPress={() => onSelectChild(candidate.id)}
                selected={candidate.id === child.id}
                testID={`memory-book-child-${candidate.id}`}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionLabel>{`Which part of ${name}’s story`}</SectionLabel>
        <View style={styles.options}>{split.visible.map(renderChoice)}</View>
        {moreCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setIsMoreOpen((open) => !open)}
            style={styles.moreToggle}
            testID="memory-book-scope-more"
          >
            <Text style={styles.moreToggleText}>{isMoreOpen ? 'See fewer' : `See ${moreCount} more`}</Text>
          </Pressable>
        ) : null}
        {isMoreOpen
          ? moreGroups.map((group) => (
              <View key={group.title} style={styles.group} testID={`memory-book-group-${group.title}`}>
                <Text style={styles.groupTitle}>{group.title}</Text>
                <View style={styles.options}>{group.choices.map(renderChoice)}</View>
              </View>
            ))
          : null}
      </View>

      {eligibleCount !== null ? (
        <EligibilityBox testID="memory-book-eligibility">
          {`${eligibleCount} ${eligibleCount === 1 ? 'moment' : 'moments'} in this period.`}
        </EligibilityBox>
      ) : null}
      {isThin ? <ThinWarning onImportPhotos={onImportPhotos} /> : null}
      {row?.dispatchError ? (
        <Text style={styles.error} testID="memory-book-dispatch-error">
          {row.dispatchError}
        </Text>
      ) : null}
      {overview?.has_viewers ? <PrivacyNote product="book" /> : null}
      <FactsBox facts={BOOK_FACTS} />
    </ProductPageShell>
  );
}

export default function MemoryBookProductScreen() {
  const { memberId: memberIdParam } = useLocalSearchParams<{ memberId?: string }>();
  const { familyId, role, isLoading: isFamilyLoading } = useFamily();
  const canEdit = canEditFamilyContent(role);
  const { members, isLoading: isMembersLoading } = useFamilyMembers();
  const { booksByChild, isLoading: isBooksLoading } = useFamilyMemoryBooks({
    familyId: canEdit ? familyId : null,
    isFocused: true,
  });
  const { overview } = useKeepsakesOverview(familyId, { enabled: canEdit });
  const { leave } = useLeaveKeepsakesPage();
  // A stack screen: "today" is fixed for this visit.
  const [todayIso] = useState(() => getLocalTodayIso());
  const [pickedId, setPickedId] = useState<string | null>(null);

  const isSettled = !isFamilyLoading && !isMembersLoading && !(canEdit && isBooksLoading);

  // Books are an owner/manager keepsake: a viewer (or a deep link) has nothing here.
  const hasLeftRef = useRef(false);
  useEffect(() => {
    if (!isSettled || canEdit || hasLeftRef.current) return;
    hasLeftRef.current = true;
    leave();
  }, [isSettled, canEdit, leave]);

  // Same eligibility as the shelves: an own child, or anyone who already has books.
  const children = useMemo(() => {
    const today = new Date(`${todayIso}T12:00:00`);
    return members.filter((member) => isOwnChild(member, today) || (booksByChild.get(member.id)?.length ?? 0) > 0);
  }, [booksByChild, members, todayIso]);

  const child =
    children.find((member) => member.id === pickedId) ??
    children.find((member) => member.id === memberIdParam) ??
    children[0] ??
    null;

  if (!isSettled || !canEdit) {
    return (
      <ProductPageShell onBack={leave} testID="keepsakes-product-memory-book">
        <ProductPageLoading />
      </ProductPageShell>
    );
  }

  if (!child) {
    return (
      <ProductPageShell
        footer={
          <ProductCtaBar
            label="Go to Family"
            onPress={() => router.navigate(familyRosterRoute)}
            testID="memory-book-product-cta"
          />
        }
        onBack={leave}
        testID="keepsakes-product-memory-book"
      >
        <ProductHeading
          eyebrow="Memory book"
          title="A year of your child, printed and bound."
        />
        <FreeToMake product="book" />
        <Text style={styles.hint} testID="memory-book-no-children">
          Add your child to make a book
        </Text>
      </ProductPageShell>
    );
  }

  return (
    <ChildBookPage
      child={child}
      siblings={children}
      key={child.id}
      onSelectChild={setPickedId}
      overview={overview}
      todayIso={todayIso}
    />
  );
}

const styles = StyleSheet.create({
  cover: { width: 200 },
  section: { gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  options: { gap: 8 },
  group: { gap: 8, marginTop: 6 },
  groupTitle: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  moreToggle: { alignSelf: 'flex-start', paddingVertical: 6 },
  moreToggleText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14 },
  thin: { backgroundColor: colors.sunSoft, borderRadius: radius.md, gap: 6, padding: 14 },
  thinTitle: { color: colors.sunInk, fontFamily: fonts.sansBold, fontSize: 13.5 },
  thinBody: { color: colors.sunInk, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  thinButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.white,
    borderRadius: radius.pill,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  thinButtonText: { color: colors.sunInk, fontFamily: fonts.sansBold, fontSize: 13 },
  pressed: { opacity: 0.85 },
  error: { color: colors.error, fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 19 },
  hint: { color: colors.ink2, fontFamily: fonts.sansMedium, fontSize: 14, lineHeight: 21 },
});
