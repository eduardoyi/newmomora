// One object on a year's shelf plus its caption (docs/plans/keepsakes-redesign.md
// C1). Every object sits in a fixed-height zone aligned to the bottom, so a
// poster, a book and a card share one baseline; the caption (title, meta,
// optional status badge) hangs beneath, top-aligned across the row.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { KeepsakeBadge } from '@/components/keepsakes/keepsake-badge';
import { KeepsakeFilmTile, shelfFilmDurationLabel } from '@/components/keepsakes/keepsake-film-tile';
import { ShelfHolidayCard, shelfHolidayCardSize } from '@/components/keepsakes/shelf-holiday-card';
import { UpcomingFilmTile } from '@/components/keepsakes/upcoming-film-tile';
import {
  UpcomingRecapTile,
  upcomingRecapCaptionMeta,
  upcomingRecapTitle,
} from '@/components/keepsakes/upcoming-recap-tile';
import { BookCoverTile, type BookCoverTileStatus } from '@/components/memory-books/book-cover-tile';
import { colors, fonts } from '@/constants/theme';
import { formatYearRange } from '@/utils/memory-book-scope';
import type { KeepsakesOverview } from '@/services/keepsakes';
import {
  shelfCardFront,
  upcomingFilmCaptionMeta,
  upcomingFilmCaptionTitle,
  type BookShelfItem,
  type CardShelfItem,
  type FilmShelfItem,
  type ShelfItem,
} from '@/utils/keepsakes';
import { filmTitle, type YearFilmMember } from '@/utils/year-films';

/** The shared baseline: every object is bottom-aligned inside this zone. */
export const SHELF_OBJECT_ZONE_HEIGHT = 166;
export const SHELF_FILM_ITEM_WIDTH = 110;
export const SHELF_BOOK_ITEM_WIDTH = 146;

export interface ShelfItemViewProps {
  item: ShelfItem;
  members: readonly YearFilmMember[];
  /** The shelf's today (`YYYY-MM-DD`), for "arrives today" on the upcoming tiles. */
  todayIso: string;
  /** The overview, for the holiday card's real front (`card_front`) and the fallback picture (`preview_key`). */
  overview: KeepsakesOverview | null;
  onBookPress: (item: BookShelfItem) => void;
}

function bookTileStatus(item: BookShelfItem): BookCoverTileStatus {
  if (item.row.status === 'ready') return 'ready';
  if (item.row.status === 'failed') return 'failed';
  return 'generating';
}

function bookYearRangeLabel(book: BookShelfItem['row']['book']): string | null {
  if (!book.scope_start_date || !book.scope_end_date) return null;
  return formatYearRange(book.scope_start_date, book.scope_end_date);
}

function itemWidth(item: ShelfItem, overview: KeepsakesOverview | null): number {
  switch (item.kind) {
    case 'book':
      return SHELF_BOOK_ITEM_WIDTH;
    case 'card':
      // A landscape card is wider than a portrait one; the caption follows it.
      return shelfHolidayCardSize(shelfCardFront(item, overview)).width;
    default:
      return SHELF_FILM_ITEM_WIDTH;
  }
}

function BookObject({ item, childName, onPress }: { item: BookShelfItem; childName: string; onPress: () => void }) {
  const { row } = item;
  const status = bookTileStatus(item);
  return (
    <Pressable
      accessibilityLabel={`${row.option.label} book`}
      accessibilityRole="button"
      disabled={status === 'generating'}
      onPress={onPress}
      style={({ pressed }) => [styles.bookObject, pressed && styles.pressed]}
      testID={`memory-book-tile-${row.key}`}
    >
      <BookCoverTile
        cacheVersion={row.book.updated_at}
        childFirstName={childName}
        coverAssetKey={row.book.cover_asset_key}
        scopeLabel={row.option.label}
        status={status}
        washId={row.book.id}
        yearRangeLabel={bookYearRangeLabel(row.book)}
      />
    </Pressable>
  );
}

export function shelfCaption(
  item: ShelfItem,
  members: readonly YearFilmMember[],
  todayIso: string,
): { title: string; meta: string | null } {
  switch (item.kind) {
    case 'upcoming-recap':
      return { title: upcomingRecapTitle(item.recap), meta: upcomingRecapCaptionMeta(item.recap, todayIso, item.isPrevious) };
    case 'upcoming-film':
      return { title: upcomingFilmCaptionTitle(item.upcoming, members), meta: upcomingFilmCaptionMeta(item.upcoming, todayIso) };
    case 'film':
      return { title: filmTitle(item.film, members), meta: shelfFilmDurationLabel(item.film.duration_ms) };
    case 'book': {
      const member = members.find((candidate) => candidate.id === item.row.book.child_id);
      return { title: item.row.option.label, meta: member ? member.name : null };
    }
    case 'card':
      return { title: 'Holiday card', meta: String(item.year) };
  }
}

export function ShelfItemView({ item, members, todayIso, overview, onBookPress }: ShelfItemViewProps) {
  const { title, meta } = shelfCaption(item, members, todayIso);
  const width = itemWidth(item, overview);

  let object;
  switch (item.kind) {
    case 'upcoming-recap':
      object = <UpcomingRecapTile previous={item.isPrevious} recap={item.recap} todayIso={todayIso} />;
      break;
    case 'upcoming-film':
      object = <UpcomingFilmTile film={item.upcoming} members={members} todayIso={todayIso} />;
      break;
    case 'film':
      object = <KeepsakeFilmTile film={(item as FilmShelfItem).film} members={members} variant="shelf" width={SHELF_FILM_ITEM_WIDTH} />;
      break;
    case 'book': {
      const member = members.find((candidate) => candidate.id === item.row.book.child_id);
      object = <BookObject childName={member?.name ?? ''} item={item} onPress={() => onBookPress(item)} />;
      break;
    }
    case 'card': {
      const card: CardShelfItem = item;
      const front = shelfCardFront(card, overview);
      object = (
        <ShelfHolidayCard
          cardId={card.cardId}
          front={front}
          imageKey={overview?.preview_key ?? null}
          language={card.isPast ? (front?.language ?? 'en') : card.summary.language}
          year={item.year}
        />
      );
      break;
    }
  }

  return (
    <View style={{ width }} testID={`keepsakes-item-${item.id}`}>
      <View style={styles.objectZone}>{object}</View>
      <View style={styles.caption}>
        <Text numberOfLines={2} style={styles.captionTitle}>
          {title}
        </Text>
        {meta ? (
          <Text numberOfLines={2} style={styles.captionMeta}>
            {meta}
          </Text>
        ) : null}
        {item.badge ? (
          <View style={styles.badge}>
            <KeepsakeBadge label={item.badge.label} testID={`keepsakes-badge-${item.id}`} tone={item.badge.tone} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  objectZone: { height: SHELF_OBJECT_ZONE_HEIGHT, justifyContent: 'flex-end' },
  bookObject: {
    shadowColor: '#2C2418',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    width: SHELF_BOOK_ITEM_WIDTH,
  },
  pressed: { opacity: 0.85 },
  caption: { gap: 2, marginTop: 8 },
  badge: { marginTop: 4 },
  captionTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 13, lineHeight: 17 },
  captionMeta: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
});
