import { describe, expect, it } from 'vitest';
import {
  bookTileAriaLabel,
  cardTileState,
  homeSections,
  NOTHING_YET_COPY,
  shouldPollCards,
  tileFromSummary,
  tilesFromSummaries,
  type HolidayCardSummaryRow,
} from '../keepsakes';

// Fictional ids only (the repo is public).
const row = (over: Partial<HolidayCardSummaryRow> = {}): HolidayCardSummaryRow => ({
  enabled: true,
  card_id: 'card-1',
  year: 2026,
  status: 'ready',
  last_failure_code: null,
  ordered: false,
  language: 'en',
  readiness: 'ready',
  ...over,
});

describe('holiday card tile mapping', () => {
  it.each([
    [{ readiness: 'generating', status: 'generating' }, 'being_made', 'Being made'],
    [{ readiness: 'film' }, 'being_made', 'Being made'],
    [{ readiness: 'ready' }, 'ready', 'Ready to order'],
    [{ readiness: 'failed', status: 'failed' }, 'failed', "Couldn't be made"],
    [{ readiness: 'ready', ordered: true }, 'ordered', 'Ordered'],
    [{ readiness: 'film', ordered: true }, 'ordered', 'Ordered'],
    [{ readiness: 'failed', ordered: true }, 'ordered', 'Ordered'],
  ] as const)('%j → %s / %s', (over, state, label) => {
    const tile = tileFromSummary(row(over))!;
    expect(tile.state).toBe(state);
    expect(tile.label).toBe(label);
    expect(tile.title).toBe('Holiday card 2026');
    expect(tile.ariaLabel).toBe(`Holiday card 2026, ${label.toLowerCase()}`);
  });

  it('falls back to the card status before the readiness migration is applied', () => {
    expect(cardTileState({ ordered: false, readiness: null, status: 'generating' })).toBe('being_made');
    expect(cardTileState({ ordered: false, readiness: undefined, status: 'ready' })).toBe('ready');
    expect(cardTileState({ ordered: false, readiness: undefined, status: 'failed' })).toBe('failed');
    expect(cardTileState({ ordered: null, readiness: null, status: null })).toBe('being_made');
  });

  it('a row with no card is no tile; several families give one tile per card, newest year first', () => {
    expect(tileFromSummary(row({ card_id: null, year: null, readiness: null }))).toBeNull();
    const tiles = tilesFromSummaries([row({ card_id: 'a', year: 2025 }), row({ card_id: 'b', year: 2026 }), row({ card_id: 'a', year: 2025, readiness: 'film' }), row({ card_id: null })]);
    expect(tiles.map((t) => [t.cardId, t.year])).toEqual([['b', 2026], ['a', 2025]]);
    expect(tiles[1].state).toBe('being_made'); // the later row for the same card wins
  });

  it('polls only while a card is being made', () => {
    expect(shouldPollCards(tilesFromSummaries([row({ readiness: 'film' })]))).toBe(true);
    expect(shouldPollCards(tilesFromSummaries([row({ readiness: 'generating' }), row({ card_id: 'z', ordered: true })]))).toBe(true);
    expect(shouldPollCards(tilesFromSummaries([row(), row({ card_id: 'y', readiness: 'failed' }), row({ card_id: 'x', ordered: true, readiness: 'film' })]))).toBe(false);
    expect(shouldPollCards([])).toBe(false);
  });
});

describe('home sections', () => {
  it('hides an empty section, and shows the empty copy only when there is neither', () => {
    expect(homeSections({ loading: false, bookCount: 2, cardCount: 1 })).toEqual({ cards: true, books: true, empty: false });
    expect(homeSections({ loading: false, bookCount: 2, cardCount: 0 })).toEqual({ cards: false, books: true, empty: false });
    expect(homeSections({ loading: false, bookCount: 0, cardCount: 1 })).toEqual({ cards: true, books: false, empty: false });
    expect(homeSections({ loading: false, bookCount: 0, cardCount: 0 })).toEqual({ cards: false, books: false, empty: true });
    // Never flash the empty state while still loading.
    expect(homeSections({ loading: true, bookCount: 0, cardCount: 0 }).empty).toBe(false);
  });
  it('has the agreed empty copy', () => {
    expect(NOTHING_YET_COPY).toBe("Nothing here yet. Make a Memory Book or a holiday card from the Keepsakes tab in the Momora app, and it'll show up here.");
  });
  it('book tile aria-labels carry the status', () => {
    expect(bookTileAriaLabel('Enzo — Year one', 'Generating…')).toBe('Enzo — Year one, generating');
    expect(bookTileAriaLabel('Enzo — Year one', 'Ready')).toBe('Enzo — Year one, ready');
  });
});
