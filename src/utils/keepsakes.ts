// Pure helpers behind the redesigned Keepsakes tab (docs/plans/keepsakes-redesign.md
// B3): shelf items, badges, the needs-you line, the library filter, year
// summaries and the Memory Book period list. No React, no I/O -- every date is
// passed in (`todayIso`) so the unit tests pin them.
//
// Data flow for the tab:
//   relevantBookRows = buildRelevantBookRows({ booksByChild, members, todayIso })
//   items            = buildShelfItems({ films, bookRows, cardSummary, overview, role, todayIso })
//   needsYou         = pickNeedsYou({ cardSummary, bookRows, members, role, todayIso })
//   visible          = applyKeepsakesFilter(items, filter)
//   years            = groupShelfByYear(visible, todayIso)
import { buildMemoryBookRows, type MemoryBookScopeRow } from '@/hooks/useMemoryBooks';
import type { HolidayCardSummary } from '@/services/holiday-cards';
import type { KeepsakesCardFront, KeepsakesOverview, KeepsakesRecap } from '@/services/keepsakes';
import type { MemoryBookListRow } from '@/services/memory-books';
import type { YearFilm } from '@/services/year-films';
import { isOwnChild } from '@/utils/family-relationships';
import { holidayCardTileState, type HolidayCardTileState } from '@/utils/holiday-card-state';
import {
  buildMemoryBookScopeOptions,
  memoryBookScopeKey,
  parseDateParts,
  toJulianDayNumber,
  type MemoryBookScopeOption,
} from '@/utils/memory-book-scope';
import { canEditFamilyContent } from '@/utils/roles';
import { filmDisplayState, type FilmDisplayState } from '@/utils/year-films';

// ---------------------------------------------------------------------------
// Copy (exact strings from the plan; typographic apostrophes like the rest of
// the app's copy)
// ---------------------------------------------------------------------------

export const KEEPSAKE_BADGE_COPY = {
  beingMade: 'Being made',
  readyToOrder: 'Ready to order',
  ordered: 'Ordered',
  shipped: 'Shipped',
  couldntBeMade: 'Couldn’t be made',
} as const;

export const NEEDS_YOU_CARD_READY_LABEL = 'Your holiday card is ready to order';
export const NEEDS_YOU_CARD_FAILED_LABEL = 'Your holiday card couldn’t be made';

/** A failed book stops raising the needs-you banner after this many days. */
export const FAILED_BOOK_BANNER_DAYS = 30;
/** A year with MORE monthly recaps than this ends its row with an "All {year} recaps" tile. */
export const ALL_RECAPS_TILE_THRESHOLD = 3;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "October" from a `YYYY-MM-DD` string (no `Date`, no time zone). */
export function monthNameOf(dateStr: string): string {
  return MONTH_NAMES[parseDateParts(dateStr).month - 1] ?? '';
}

/** "Nov 1" from a `YYYY-MM-DD` string (no `Date`, no time zone). */
export function formatMonthDay(dateStr: string): string {
  const { month, day } = parseDateParts(dateStr);
  return `${MONTH_ABBR[month - 1]} ${day}`;
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

function possessive(name: string): string {
  const trimmed = name.trim();
  return /s$/i.test(trimmed) ? `${trimmed}’` : `${trimmed}’s`;
}

// ---------------------------------------------------------------------------
// Books: dedupe through the per-child row logic
// ---------------------------------------------------------------------------

/** A scope row that is known to have a book. */
export type BookRow = MemoryBookScopeRow & { book: MemoryBookListRow };

/**
 * Deduplicates books exactly like `KeepsakesBody` derives `bookRowsById`:
 * for each shelf member (an own child, or anyone with a book) build the scope
 * rows (`buildMemoryBookScopeOptions` + `buildMemoryBookRows`, which applies
 * `pickRelevantBook` per scope) and keep the rows that have a book. A retry
 * creates a fresh row and leaves the failed one as history, so raw rows would
 * resurface a superseded failure forever -- only each scope's RELEVANT book
 * may become a shelf item or a banner.
 */
export function buildRelevantBookRows({
  booksByChild,
  members,
  todayIso,
}: {
  booksByChild: ReadonlyMap<string, readonly MemoryBookListRow[]>;
  members: readonly { id: string; relationship?: string | null; date_of_birth?: string | null }[];
  todayIso: string;
}): BookRow[] {
  const today = new Date(`${todayIso}T12:00:00`);
  const shelfMembers = members.filter(
    (member) => (booksByChild.get(member.id)?.length ?? 0) > 0 || isOwnChild(member, today),
  );
  const rows: BookRow[] = [];
  for (const member of shelfMembers) {
    const memberRows = buildMemoryBookRows(
      buildMemoryBookScopeOptions(member.date_of_birth ?? null, todayIso),
      booksByChild.get(member.id) ?? [],
    );
    for (const row of memberRows) {
      if (row.book !== null) rows.push(row as BookRow);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shelf items
// ---------------------------------------------------------------------------

/** `needsYou` is raspberry (waiting on you); `progress` is lavender. */
export type KeepsakeBadgeTone = 'needsYou' | 'progress';

export interface KeepsakeBadgeData {
  label: string;
  tone: KeepsakeBadgeTone;
}

export type ShelfItemKind = 'upcoming-recap' | 'film' | 'book' | 'card';

interface ShelfItemBase {
  /** Stable React key: `upcoming-recap`, `film:{id}`, `book:{id}`, `card:{id}`. */
  id: string;
  /** The shelf (calendar year) the item lives on. */
  year: number;
  /** `YYYY-MM-DD`, for ordering within a year. */
  date: string;
  /** The child it belongs to; null for family-wide items (recaps, year-end film, card). */
  memberId: string | null;
  badge: KeepsakeBadgeData | null;
}

export interface UpcomingRecapShelfItem extends ShelfItemBase {
  kind: 'upcoming-recap';
  recap: KeepsakesRecap;
}

export interface FilmShelfItem extends ShelfItemBase {
  kind: 'film';
  film: YearFilm;
  /** `ready` | `remaking` | `updating` (hidden films are never items). */
  displayState: FilmDisplayState;
}

export interface BookShelfItem extends ShelfItemBase {
  kind: 'book';
  /** The scope's relevant row; `row.book` is non-null. */
  row: BookRow;
}

export interface CardShelfItem extends ShelfItemBase {
  kind: 'card';
  cardId: string;
  /** Never `make` (a card that does not exist is not a shelf item). */
  cardState: Exclude<HolidayCardTileState, 'make'>;
  summary: HolidayCardSummary;
}

export type ShelfItem = UpcomingRecapShelfItem | FilmShelfItem | BookShelfItem | CardShelfItem;

/** A book/card order lookup key from the overview. */
function findOrder(overview: KeepsakesOverview | null, product: 'book' | 'card', itemId: string) {
  return overview?.orders.find((order) => order.product === product && order.item_id === itemId) ?? null;
}

/** "Shipped · Nov 12" from a timestamptz, in the device's local calendar; plain "Shipped" without a date. */
function shippedLabel(shippedAt: string | null): string {
  if (!shippedAt) return KEEPSAKE_BADGE_COPY.shipped;
  const date = new Date(shippedAt);
  if (Number.isNaN(date.getTime())) return KEEPSAKE_BADGE_COPY.shipped;
  return `${KEEPSAKE_BADGE_COPY.shipped} · ${MONTH_ABBR[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Badge for a book (its relevant row) -- plan B3:
 * queued/generating -> "Being made"; failed -> "Couldn’t be made" (needs you);
 * ready + order: paid|rendering|submitted|in_production -> "Ordered",
 * shipped -> "Shipped" (no date: `memory_book_orders` has no `shipped_at`),
 * delivered -> none.
 */
export function bookBadge(row: BookRow, overview: KeepsakesOverview | null): KeepsakeBadgeData | null {
  if (row.status === 'in_progress') return { label: KEEPSAKE_BADGE_COPY.beingMade, tone: 'progress' };
  if (row.status === 'failed') return { label: KEEPSAKE_BADGE_COPY.couldntBeMade, tone: 'needsYou' };
  if (row.status !== 'ready') return null;
  const order = findOrder(overview, 'book', row.book.id);
  if (!order) return null;
  switch (order.status) {
    case 'paid':
    case 'rendering':
    case 'submitted':
    case 'in_production':
      return { label: KEEPSAKE_BADGE_COPY.ordered, tone: 'progress' };
    case 'shipped':
      return { label: KEEPSAKE_BADGE_COPY.shipped, tone: 'progress' };
    default:
      return null; // delivered (and anything unknown) carries no badge
  }
}

/**
 * Badge for the holiday card -- plan B3: generating -> "Being made"; ready ->
 * "Ready to order" and failed -> "Couldn’t be made" (both needs you); ordered
 * (`summary.ordered`, the state function's own source) -> "Shipped · {MMM d}"
 * once the card's order is `shipped` (terminal: cards have no `delivered`),
 * else "Ordered".
 */
export function cardBadge(
  cardState: Exclude<HolidayCardTileState, 'make'>,
  cardId: string,
  overview: KeepsakesOverview | null,
): KeepsakeBadgeData {
  switch (cardState) {
    case 'generating':
      return { label: KEEPSAKE_BADGE_COPY.beingMade, tone: 'progress' };
    case 'ready':
      return { label: KEEPSAKE_BADGE_COPY.readyToOrder, tone: 'needsYou' };
    case 'failed':
      return { label: KEEPSAKE_BADGE_COPY.couldntBeMade, tone: 'needsYou' };
    case 'ordered': {
      const order = findOrder(overview, 'card', cardId);
      if (order?.status === 'shipped') return { label: shippedLabel(order.shipped_at), tone: 'progress' };
      return { label: KEEPSAKE_BADGE_COPY.ordered, tone: 'progress' };
    }
  }
}

/**
 * The overview's real card front, only when it is THE card at hand: the
 * overview and the card summary are separate queries, so right after a create
 * (or a stale refetch) they can briefly disagree, and the wrong card's picture
 * must never be drawn under another card's badge.
 */
export function cardFrontFor(overview: KeepsakesOverview | null, cardId: string | null): KeepsakesCardFront | null {
  const front = overview?.card_front ?? null;
  return front && cardId !== null && front.card_id === cardId ? front : null;
}

/**
 * The real card front for the card the tile / product page treats as THIS
 * season's (a card exists per `holidayCardTileState`, not "make") and that
 * matches the overview's `card_front`; null otherwise (the generic preview).
 */
export function activeCardFront(
  overview: KeepsakesOverview | null,
  summary: HolidayCardSummary | null,
  todayIso: string,
): KeepsakesCardFront | null {
  const state = holidayCardTileState(summary, todayIso);
  if (!summary || state === null || state === 'make') return null;
  return cardFrontFor(overview, summary.cardId);
}

const KIND_RANK: Record<ShelfItemKind, number> = { 'upcoming-recap': 0, card: 1, film: 2, book: 3 };

function isYearEndFilm(item: ShelfItem): boolean {
  return item.kind === 'film' && item.film.kind === 'family_year';
}

/**
 * Upcoming recap first, then the year-end film (it is the year's headline: it
 * leads whatever its date says, e.g. ahead of the December recap), then newest
 * date, then kind, then id (stable).
 */
function compareWithinYear(a: ShelfItem, b: ShelfItem): number {
  const aUpcoming = a.kind === 'upcoming-recap';
  const bUpcoming = b.kind === 'upcoming-recap';
  if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
  const aYearEnd = isYearEndFilm(a);
  const bYearEnd = isYearEndFilm(b);
  if (aYearEnd !== bYearEnd) return aYearEnd ? -1 : 1;
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BuildShelfItemsInput {
  films: readonly YearFilm[];
  /** The deduplicated rows from `buildRelevantBookRows`. */
  bookRows: readonly BookRow[];
  /** `useHolidayCard().summary` (null while loading / for viewers). */
  cardSummary: HolidayCardSummary | null;
  /** `useKeepsakesOverview().overview` (null: degrade -- no upcoming tile, no order badges). */
  overview: KeepsakesOverview | null;
  role: string | null | undefined;
  /** The screen's local "today" (`YYYY-MM-DD`); decides what a previous-year card means. */
  todayIso: string;
}

/**
 * Every shelf item of the library, flat, ordered year descending and, within a
 * year, the upcoming recap first, then the year-end film, then newest `date` first.
 *
 * - Films: `hidden` ones dropped (`filmDisplayState`); filed by `placement_date`'s year.
 * - Books (owner/manager only): filed by `scope_end_date`'s year, falling back
 *   to `created_at` (an unbounded "everything" book has none).
 * - Card (owner/manager only): on a shelf only while `holidayCardTileState` is
 *   non-null and not `make`; its year is `summary.year`, its date Dec 1 of it.
 * - Upcoming recap (everyone): filed by the OWNER-LOCAL year of
 *   `overview.recap.month_start`, never the device clock.
 * Viewers get films and the upcoming recap only.
 */
export function buildShelfItems({
  films,
  bookRows,
  cardSummary,
  overview,
  role,
  todayIso,
}: BuildShelfItemsInput): ShelfItem[] {
  const canEdit = canEditFamilyContent(role);
  const items: ShelfItem[] = [];

  for (const film of films) {
    const displayState = filmDisplayState(film);
    if (displayState === 'hidden') continue;
    items.push({
      kind: 'film',
      id: `film:${film.id}`,
      year: yearOf(film.placement_date),
      date: film.placement_date,
      memberId: film.kind === 'birthday' ? film.family_member_id : null,
      badge: null,
      film,
      displayState,
    });
  }

  if (canEdit) {
    for (const row of bookRows) {
      const date = row.book.scope_end_date ?? row.book.created_at.slice(0, 10);
      items.push({
        kind: 'book',
        id: `book:${row.book.id}`,
        year: yearOf(date),
        date,
        memberId: row.book.child_id,
        badge: bookBadge(row, overview),
        row,
      });
    }

    const cardState = holidayCardTileState(cardSummary, todayIso);
    if (cardSummary && cardSummary.cardId && cardState && cardState !== 'make') {
      const year = cardSummary.year ?? yearOf(todayIso);
      items.push({
        kind: 'card',
        id: `card:${cardSummary.cardId}`,
        year,
        date: `${String(year).padStart(4, '0')}-12-01`,
        memberId: null,
        badge: cardBadge(cardState, cardSummary.cardId, overview),
        cardId: cardSummary.cardId,
        cardState,
        summary: cardSummary,
      });
    }
  }

  if (overview?.recap) {
    items.push({
      kind: 'upcoming-recap',
      id: 'upcoming-recap',
      year: yearOf(overview.recap.month_start),
      date: overview.recap.delivers_on,
      memberId: null,
      badge: null,
      recap: overview.recap,
    });
  }

  return items.sort((a, b) => (a.year !== b.year ? b.year - a.year : compareWithinYear(a, b)));
}

// ---------------------------------------------------------------------------
// Year grouping
// ---------------------------------------------------------------------------

export interface ShelfYear {
  year: number;
  /** Ordered: the upcoming recap first, then the year-end film, then newest first. */
  items: ShelfItem[];
  /** The device's current year. */
  isCurrent: boolean;
  /** True when the year must render open: the current year, or the year holding
   * the upcoming recap (so it never lands in a folded or wrong year when the
   * device and owner time zones straddle New Year). */
  isAlwaysOpen: boolean;
  /** Monthly recap films on this shelf. */
  recapCount: number;
  /** The row ends with an "All {year} recaps" tile (more than 3 monthly recaps). */
  showAllRecapsTile: boolean;
}

/**
 * Groups (already ordered) items into year shelves, newest year first. Only
 * years that have items appear.
 */
export function groupShelfByYear(items: readonly ShelfItem[], todayIso: string): ShelfYear[] {
  const currentYear = yearOf(todayIso);
  const byYear = new Map<number, ShelfItem[]>();
  for (const item of items) {
    const list = byYear.get(item.year);
    if (list) list.push(item);
    else byYear.set(item.year, [item]);
  }
  return [...byYear.keys()]
    .sort((a, b) => b - a)
    .map((year) => {
      const yearItems = (byYear.get(year) ?? []).slice().sort(compareWithinYear);
      const recapCount = yearItems.filter((item) => item.kind === 'film' && item.film.kind === 'family_month').length;
      return {
        year,
        items: yearItems,
        isCurrent: year === currentYear,
        isAlwaysOpen: year === currentYear || yearItems.some((item) => item.kind === 'upcoming-recap'),
        recapCount,
        showAllRecapsTile: recapCount > ALL_RECAPS_TILE_THRESHOLD,
      };
    });
}

/** "14 keepsakes" for owners and managers, "12 films" for viewers. The upcoming recap is not counted. */
export function yearSummaryLabel(items: readonly ShelfItem[], role: string | null | undefined): string {
  const real = items.filter((item) => item.kind !== 'upcoming-recap');
  if (canEditFamilyContent(role)) {
    return `${real.length} ${real.length === 1 ? 'keepsake' : 'keepsakes'}`;
  }
  const films = real.filter((item) => item.kind === 'film').length;
  return `${films} ${films === 1 ? 'film' : 'films'}`;
}

// ---------------------------------------------------------------------------
// Needs-you line
// ---------------------------------------------------------------------------

export type NeedsYouKind = 'card-ready' | 'card-failed' | 'book-failed';

export type NeedsYouTarget =
  | { type: 'card'; cardId: string }
  | { type: 'book'; memberId: string; bookId: string; option: MemoryBookScopeOption };

export interface NeedsYou {
  kind: NeedsYouKind;
  label: string;
  target: NeedsYouTarget;
}

export interface PickNeedsYouInput {
  cardSummary: HolidayCardSummary | null;
  /** The deduplicated rows from `buildRelevantBookRows` -- never raw books. */
  bookRows: readonly BookRow[];
  members: readonly { id: string; name: string }[];
  role: string | null | undefined;
  todayIso: string;
}

function daysBetween(fromDate: string, toDate: string): number {
  return toJulianDayNumber(toDate) - toJulianDayNumber(fromDate);
}

/**
 * At most one banner; owners and managers only. Priority: card ready -> card
 * failed -> the most recently updated failed RELEVANT book.
 * - Card banners show only while `summary.enabled` (they stop when the season
 *   closes, so "ready" nags at most until `closes_on`).
 * - A failed-book banner shows only while the failure is under 30 days old
 *   (`updated_at`); after that it is just the shelf badge.
 */
export function pickNeedsYou({ cardSummary, bookRows, members, role, todayIso }: PickNeedsYouInput): NeedsYou | null {
  if (!canEditFamilyContent(role)) return null;

  if (cardSummary?.enabled && cardSummary.cardId) {
    const state = holidayCardTileState(cardSummary, todayIso);
    if (state === 'ready') {
      return { kind: 'card-ready', label: NEEDS_YOU_CARD_READY_LABEL, target: { type: 'card', cardId: cardSummary.cardId } };
    }
    if (state === 'failed') {
      return { kind: 'card-failed', label: NEEDS_YOU_CARD_FAILED_LABEL, target: { type: 'card', cardId: cardSummary.cardId } };
    }
  }

  let newest: BookRow | null = null;
  for (const row of bookRows) {
    if (row.status !== 'failed' || !row.book.child_id) continue;
    if (daysBetween(row.book.updated_at.slice(0, 10), todayIso) >= FAILED_BOOK_BANNER_DAYS) continue;
    if (!newest || row.book.updated_at > newest.book.updated_at) newest = row;
  }
  if (newest && newest.book.child_id) {
    const member = members.find((candidate) => candidate.id === newest!.book.child_id);
    return {
      kind: 'book-failed',
      label: member ? `${possessive(member.name)} book couldn’t be made` : 'Your book couldn’t be made',
      target: { type: 'book', memberId: newest.book.child_id, bookId: newest.book.id, option: newest.option },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Library filter
// ---------------------------------------------------------------------------

export type KeepsakesTypeFilter = 'all' | 'films' | 'books' | 'cards';

export interface KeepsakesFilter {
  /** A child chip; null = "All". Family-wide items only show under "All". */
  memberId: string | null;
  type: KeepsakesTypeFilter;
  /** Only this year (rendered forced open); null = every year. */
  year: number | null;
}

export const DEFAULT_KEEPSAKES_FILTER: KeepsakesFilter = { memberId: null, type: 'all', year: null };

function matchesType(item: ShelfItem, type: KeepsakesTypeFilter): boolean {
  switch (type) {
    case 'all':
      return true;
    case 'films':
      return item.kind === 'film' || item.kind === 'upcoming-recap'; // the upcoming recap is a film-to-be
    case 'books':
      return item.kind === 'book';
    case 'cards':
      return item.kind === 'card';
  }
}

/**
 * Child chip: only items of that child (books, birthday films); family-wide
 * items (recaps, year-end, card, upcoming recap) show only under "All".
 * Type filters by kind (the upcoming recap counts as Films). Year shows only
 * that year. Order is preserved.
 */
export function applyKeepsakesFilter(items: readonly ShelfItem[], filter: KeepsakesFilter): ShelfItem[] {
  return items.filter(
    (item) =>
      (filter.memberId === null || item.memberId === filter.memberId) &&
      matchesType(item, filter.type) &&
      (filter.year === null || item.year === filter.year),
  );
}

/** Years that have items, newest first (the filter sheet's Year chips). */
export function availableYears(items: readonly ShelfItem[]): number[] {
  return [...new Set(items.map((item) => item.year))].sort((a, b) => b - a);
}

/**
 * Drops a selection whose child or year no longer exists in `items` (the
 * family switched, or the only item of a year went away). Returns the same
 * object when nothing changed.
 */
export function reconcileKeepsakesFilter(filter: KeepsakesFilter, items: readonly ShelfItem[]): KeepsakesFilter {
  const hasMember = filter.memberId === null || items.some((item) => item.memberId === filter.memberId);
  const hasYear = filter.year === null || items.some((item) => item.year === filter.year);
  if (hasMember && hasYear) return filter;
  return { ...filter, memberId: hasMember ? filter.memberId : null, year: hasYear ? filter.year : null };
}

/**
 * The child chips, in member order: each member that has at least one item.
 * Empty when fewer than 2 qualify (the chips row is hidden then; "All" is
 * implicit and always first in the UI).
 */
export function buildChildChips<M extends { id: string; name: string }>(
  items: readonly ShelfItem[],
  members: readonly M[],
): M[] {
  const withItems = new Set<string>();
  for (const item of items) if (item.memberId) withItems.add(item.memberId);
  const chips = members.filter((member) => withItems.has(member.id));
  return chips.length >= 2 ? chips : [];
}

// ---------------------------------------------------------------------------
// Memory Book product page: period list
// ---------------------------------------------------------------------------

/** Row status shown next to a period. */
export type ScopeStatusLabel = 'already made' | 'being made' | 'couldn’t be made';

export interface ScopeChoice {
  /** `memoryBookScopeKey(option)`. */
  key: string;
  option: MemoryBookScopeOption;
  /** The scope's status row, or null when the caller passed none for it. */
  row: MemoryBookScopeRow | null;
  /** Null when the scope has no book yet. */
  statusLabel: ScopeStatusLabel | null;
  /** `in_progress_year`: the age-year is not finished (its caution copy applies);
   * `mid_year`: the current calendar year (the mid-year caution applies). */
  caution: 'in_progress_year' | 'mid_year' | null;
}

export type ScopeGroupTitle = 'Years of life' | 'Calendar years' | 'Everything';

export interface ScopeGroup {
  title: ScopeGroupTitle;
  choices: ScopeChoice[];
}

export interface SplitScopeOptionsResult {
  /** At most 2 newest completed age-years (made ones included, labeled), topped up with Everything. */
  visible: ScopeChoice[];
  /** Everything else, grouped like `CreateBookSheet`'s "More options". Empty groups are omitted. */
  more: ScopeGroup[];
  /** The preselected choice: the first visible without a book, else Everything when it has none, else the first visible. */
  defaultChoice: ScopeChoice | null;
}

function statusLabelOf(row: MemoryBookScopeRow | null): ScopeStatusLabel | null {
  if (!row || !row.book) return null;
  if (row.status === 'ready') return 'already made';
  if (row.status === 'in_progress') return 'being made';
  if (row.status === 'failed') return 'couldn’t be made';
  return null;
}

/**
 * Splits a child's scope options for the Memory Book page (plan B3).
 * `visible` holds the two newest COMPLETED age-year options (`endDate <
 * todayIso`), including ones that already have a book (labeled by their row
 * status); with fewer than 2, Everything fills in. Calendar years and
 * in-progress periods never land in `visible` -- claiming them mid-period
 * locks the window (the rule behind `pickSuggestedScopes`).
 */
export function splitScopeOptions(
  options: readonly MemoryBookScopeOption[],
  rows: readonly MemoryBookScopeRow[],
  todayIso: string,
): SplitScopeOptionsResult {
  const currentYear = parseDateParts(todayIso).year;
  const rowByKey = new Map(rows.map((row) => [row.key, row]));

  const toChoice = (option: MemoryBookScopeOption): ScopeChoice => {
    const key = memoryBookScopeKey(option);
    const row = rowByKey.get(key) ?? null;
    let caution: ScopeChoice['caution'] = null;
    if (option.kind === 'age_year' && (option.endDate === null || option.endDate >= todayIso)) caution = 'in_progress_year';
    else if (option.kind === 'calendar_year' && option.calendarYear === currentYear) caution = 'mid_year';
    return { key, option, row, statusLabel: statusLabelOf(row), caution };
  };

  const everything = options.find((option) => option.kind === 'everything') ?? null;
  // Options are enumerated oldest-first: reverse for newest-first.
  const completedAgeYears = options
    .filter((option) => option.kind === 'age_year' && option.endDate !== null && option.endDate < todayIso)
    .slice()
    .reverse()
    .slice(0, 2);

  const visibleOptions: MemoryBookScopeOption[] = [...completedAgeYears];
  if (visibleOptions.length < 2 && everything) visibleOptions.push(everything);
  const visibleKeys = new Set(visibleOptions.map(memoryBookScopeKey));
  const visible = visibleOptions.map(toChoice);

  const rest = options.filter((option) => !visibleKeys.has(memoryBookScopeKey(option)));
  const groups: ScopeGroup[] = [
    { title: 'Years of life', choices: rest.filter((o) => o.kind === 'age_year').map(toChoice) },
    { title: 'Calendar years', choices: rest.filter((o) => o.kind === 'calendar_year').map(toChoice) },
    { title: 'Everything', choices: rest.filter((o) => o.kind === 'everything').map(toChoice) },
  ];
  const more = groups.filter((group) => group.choices.length > 0);

  const hasBook = (choice: ScopeChoice) => choice.row?.book != null;
  const everythingChoice =
    [...visible, ...more.flatMap((group) => group.choices)].find((choice) => choice.option.kind === 'everything') ?? null;
  const defaultChoice =
    visible.find((choice) => !hasBook(choice)) ??
    (everythingChoice && !hasBook(everythingChoice) ? everythingChoice : null) ??
    visible[0] ??
    null;

  return { visible, more, defaultChoice };
}
