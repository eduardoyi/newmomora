// One year of the Keepsakes tab (docs/plans/year-film-p2.md Step 7.1):
// the year title, the "Family films" block (year-end film large, the latest
// three monthly recaps small, "See all" past three, the upcoming-recap card
// on the current year), then one shelf per child -- birthday-film covers
// first, then that year's book tiles.
//
// Presentational: the caller (`KeepsakesBody`) owns the book tiles and the
// create/retry flow and hands them in through `renderBookTile` /
// `renderShelfExtra`, so this file never touches the books hooks.
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { KeepsakeFilmTile } from '@/components/keepsakes/keepsake-film-tile';
import { UpcomingRecapCard } from '@/components/keepsakes/upcoming-recap-card';
import { colors, fonts, spacing } from '@/constants/theme';
import { keepsakeRecapsRoute } from '@/lib/routes';
import type { FamilyMember } from '@/services/family-members';
import type { MemoryBookListRow } from '@/services/memory-books';
import type { KeepsakeYear } from '@/utils/year-films';

const RECAPS_PREVIEW_COUNT = 3;
const RECAP_GAP = 12;
const BIRTHDAY_FILM_WIDTH = 112;

export interface KeepsakeYearSectionProps {
  year: KeepsakeYear<FamilyMember>;
  members: readonly FamilyMember[];
  /** Render the dashed upcoming-recap card (current year, server-enabled). */
  showUpcoming: boolean;
  todayIso: string;
  /** A tile for one of the child's books (the body owns the book UI). */
  renderBookTile: (book: MemoryBookListRow, member: FamilyMember) => ReactNode;
  /** Extra shelf content, e.g. the "Create {name}'s first book" tile. */
  renderShelfExtra: (member: FamilyMember) => ReactNode;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function KeepsakeYearSection({
  year,
  members,
  showUpcoming,
  todayIso,
  renderBookTile,
  renderShelfExtra,
}: KeepsakeYearSectionProps) {
  const { width: windowWidth } = useWindowDimensions();
  const contentWidth = windowWidth - spacing.md * 2;
  const yearEndWidth = Math.round(contentWidth / 2);
  const recapWidth = Math.floor((contentWidth - RECAP_GAP * (RECAPS_PREVIEW_COUNT - 1)) / RECAPS_PREVIEW_COUNT);

  const { yearEnd, recaps } = year.familyFilms;
  const previewRecaps = recaps.slice(0, RECAPS_PREVIEW_COUNT);
  const hasFamilyFilms = showUpcoming || yearEnd !== null || recaps.length > 0;
  const shelves = year.children
    .map((child) => ({ child, extra: renderShelfExtra(child.member) }))
    .filter(({ child, extra }) => child.films.length > 0 || child.books.length > 0 || Boolean(extra));

  // An empty year renders nothing (no bare title).
  if (!hasFamilyFilms && shelves.length === 0) return null;

  return (
    <View style={styles.section} testID={`keepsakes-year-${year.year}`}>
      <Text accessibilityRole="header" style={styles.yearTitle}>
        {year.year}
      </Text>

      {hasFamilyFilms ? (
        <View style={styles.block} testID={`keepsakes-family-films-${year.year}`}>
          <Text style={styles.eyebrow}>Family films</Text>
          {showUpcoming ? <UpcomingRecapCard todayIso={todayIso} /> : null}
          {yearEnd ? (
            <KeepsakeFilmTile film={yearEnd} members={members} showSubtitle width={yearEndWidth} />
          ) : null}
          {previewRecaps.length > 0 ? (
            <View style={styles.recapRow}>
              {previewRecaps.map((film) => (
                <KeepsakeFilmTile film={film} key={film.id} members={members} width={recapWidth} />
              ))}
            </View>
          ) : null}
          {recaps.length > RECAPS_PREVIEW_COUNT ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(keepsakeRecapsRoute(year.year))}
              style={({ pressed }) => [styles.seeAll, pressed && styles.pressed]}
              testID={`keepsakes-recaps-${year.year}`}
            >
              <Text style={styles.seeAllText}>See all {year.year} recaps</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {shelves.map(({ child, extra }) => {
        const counts = [
          child.films.length > 0 ? countLabel(child.films.length, 'film') : null,
          child.books.length > 0 ? countLabel(child.books.length, 'book') : null,
        ].filter(Boolean);
        return (
          <View
            key={child.member.id}
            style={styles.block}
            testID={`keepsakes-shelf-${year.year}-${child.member.id}`}
          >
            <View style={styles.shelfHeaderRow}>
              <Text style={styles.eyebrow}>{child.member.name}</Text>
              {counts.length > 0 ? <Text style={styles.countText}>{counts.join(' · ')}</Text> : null}
            </View>
            <ScrollView
              contentContainerStyle={styles.shelfRow}
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator={false}
            >
              {child.films.map((film) => (
                <KeepsakeFilmTile
                  film={film}
                  key={film.id}
                  members={members}
                  showSubtitle
                  width={BIRTHDAY_FILM_WIDTH}
                />
              ))}
              {child.books.map((book) => renderBookTile(book, child.member))}
              {extra}
            </ScrollView>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 32,
    gap: 18,
  },
  yearTitle: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 36,
    color: colors.ink,
  },
  block: {
    gap: 12,
  },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.primary,
  },
  recapRow: {
    flexDirection: 'row',
    gap: RECAP_GAP,
  },
  seeAll: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  seeAllText: {
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
    color: colors.primary,
  },
  pressed: { opacity: 0.8 },
  shelfHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  countText: {
    fontFamily: fonts.sans,
    fontSize: 11.5,
    color: colors.ink3,
  },
  shelfRow: {
    alignItems: 'flex-start',
    gap: 14,
  },
});
