/**
 * Pure mapping for the home page ("Your keepsakes"): a `holiday_card_summary`
 * row becomes a tile (state, label, aria text), plus the poll rule and the
 * empty-state copy. No Supabase import, so it unit-tests in plain node.
 */

/** One row of the `holiday_card_summary(p_family_id)` RPC (zero rows unless the caller owns/manages the family). */
export interface HolidayCardSummaryRow {
  enabled?: boolean | null;
  card_id: string | null;
  year: number | null;
  status?: string | null;
  last_failure_code?: string | null;
  ordered?: boolean | null;
  language?: string | null;
  /** generating | film | ready | failed (absent before the readiness migration is applied). */
  readiness?: string | null;
}

export type CardTileState = 'being_made' | 'ready' | 'failed' | 'ordered';

export interface CardTile {
  cardId: string;
  year: number;
  state: CardTileState;
  label: string;
  title: string;
  /** Still changing: poll until it settles. */
  active: boolean;
  /** Screen-reader text for the whole tile, including the status. */
  ariaLabel: string;
}

export const CARD_TILE_LABELS: Record<CardTileState, string> = {
  being_made: 'Being made',
  ready: 'Ready to order',
  failed: "Couldn't be made",
  ordered: 'Ordered',
};

export function cardTileState(row: Pick<HolidayCardSummaryRow, 'ordered' | 'readiness' | 'status'>): CardTileState {
  if (row.ordered === true) return 'ordered';
  // `readiness` is the source of truth; an older RPC without it falls back to the card's own status.
  const r = row.readiness ?? (row.status === 'generating' ? 'generating' : row.status === 'failed' ? 'failed' : row.status === 'ready' ? 'ready' : null);
  if (r === 'failed') return 'failed';
  if (r === 'ready') return 'ready';
  return 'being_made'; // generating | film | unknown
}

export function tileFromSummary(row: HolidayCardSummaryRow): CardTile | null {
  if (!row.card_id) return null;
  const year = row.year ?? new Date().getFullYear();
  const state = cardTileState(row);
  const title = `Holiday card ${year}`;
  const label = CARD_TILE_LABELS[state];
  return { cardId: row.card_id, year, state, label, title, active: state === 'being_made', ariaLabel: `${title}, ${label.toLowerCase()}` };
}

/** Tiles for every family's summary rows: one per card, newest year first. */
export function tilesFromSummaries(rows: readonly HolidayCardSummaryRow[]): CardTile[] {
  const byId = new Map<string, CardTile>();
  for (const row of rows) {
    const tile = tileFromSummary(row);
    if (tile) byId.set(tile.cardId, tile);
  }
  return [...byId.values()].sort((a, b) => b.year - a.year);
}

export const CARD_POLL_MS = 5_000;

export function shouldPollCards(tiles: readonly CardTile[]): boolean {
  return tiles.some((t) => t.active);
}

export const NOTHING_YET_COPY =
  "Nothing here yet. Make a Memory Book or a holiday card from the Keepsakes tab in the Momora app, and it'll show up here.";

export type HomeSections = { cards: boolean; books: boolean; empty: boolean };

/** Which sections show: a section with nothing in it is hidden; with neither, the empty copy. */
export function homeSections(args: { loading: boolean; bookCount: number; cardCount: number }): HomeSections {
  const { loading, bookCount, cardCount } = args;
  return { cards: cardCount > 0, books: bookCount > 0, empty: !loading && bookCount === 0 && cardCount === 0 };
}

/** aria-label for a Memory Book tile: its name plus the status, so a disabled "generating" tile is not mute. */
export function bookTileAriaLabel(name: string, statusLabel: string): string {
  return `${name}, ${statusLabel.toLowerCase().replace(/…$/, '')}`;
}
