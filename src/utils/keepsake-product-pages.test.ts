import type { MemoryBookScopeRow } from '@/hooks/useMemoryBooks';
import type { KeepsakesOverview } from '@/services/keepsakes';
import type { MemoryBookListRow } from '@/services/memory-books';
import { bookCtaFor, holidayCardEligibility, STUCK_QUEUE_MS } from '@/utils/keepsake-product-pages';
import type { ScopeChoice } from '@/utils/keepsakes';

function overview(overrides: Partial<KeepsakesOverview> = {}): KeepsakesOverview {
  return {
    recap: null,
    has_viewers: false,
    year_moments: 31,
    holiday_pool: 24,
    holiday_min_pool: 20,
    holiday_ship_by_note: null,
    preview_key: null,
    book_preview_keys: {},
    orders: [],
    ...overrides,
  };
}

describe('holidayCardEligibility', () => {
  it('promises the letter and the QR film at or above the holiday floor', () => {
    expect(holidayCardEligibility(overview(), 2026)).toEqual({
      line: 'Your 2026 has 31 moments, plenty for the letter.',
      promisesFilm: true,
    });
    expect(holidayCardEligibility(overview({ holiday_pool: 20 }), 2026).promisesFilm).toBe(true);
  });

  it('does not promise the film below the floor', () => {
    expect(holidayCardEligibility(overview({ holiday_pool: 19, year_moments: 12 }), 2026)).toEqual({
      line: 'Your 2026 has 12 moments so far.',
      promisesFilm: false,
    });
  });

  it('uses the singular for one moment', () => {
    expect(holidayCardEligibility(overview({ holiday_pool: 1, year_moments: 1 }), 2026).line).toBe(
      'Your 2026 has 1 moment so far.',
    );
  });

  it('says nothing while the overview is unknown', () => {
    expect(holidayCardEligibility(null, 2026)).toEqual({ line: null, promisesFilm: null });
    expect(holidayCardEligibility(overview({ holiday_pool: null }), 2026)).toEqual({ line: null, promisesFilm: null });
    expect(holidayCardEligibility(overview({ year_moments: null }), 2026)).toEqual({ line: null, promisesFilm: true });
  });
});

function book(overrides: Partial<MemoryBookListRow> = {}): MemoryBookListRow {
  return {
    id: 'book-1',
    family_id: 'family-1',
    child_id: 'child-1',
    status: 'ready',
    scope_kind: 'everything',
    scope_start_date: null,
    scope_end_date: null,
    scope_label: 'Everything',
    failure_reason: null,
    cover_asset_key: null,
    created_at: '2026-10-15T10:00:00.000Z',
    updated_at: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function choice(row: Partial<MemoryBookScopeRow> | null): ScopeChoice {
  const option = { kind: 'everything', label: 'Everything', eraLine: null, startDate: null, endDate: null } as const;
  return {
    key: 'everything:null:null',
    option,
    row: row
      ? ({
          key: 'everything:null:null',
          option,
          book: null,
          status: 'available',
          eligibleCount: 40,
          disabledReason: null,
          dispatchError: null,
          isPending: false,
          ...row,
        } as MemoryBookScopeRow)
      : null,
    statusLabel: null,
    caution: null,
  };
}

const NOW = new Date('2026-10-15T10:30:00.000Z').getTime();

describe('bookCtaFor', () => {
  it('makes a book for a period without one', () => {
    expect(bookCtaFor(choice({ status: 'available' }), 'Lila', NOW)).toEqual({
      kind: 'make',
      label: 'Make Lila’s Everything book',
    });
    expect(bookCtaFor(choice({ status: 'thin' }), 'Lila', NOW).kind).toBe('make');
    expect(bookCtaFor(choice(null), 'Lila', NOW).kind).toBe('make');
  });

  it('opens a ready book', () => {
    expect(bookCtaFor(choice({ status: 'ready', book: book() }), 'Lila', NOW)).toEqual({
      kind: 'open',
      label: 'Open Lila’s book',
    });
  });

  it('retries a failed book with a fresh one', () => {
    expect(bookCtaFor(choice({ status: 'failed', book: book({ status: 'failed' }) }), 'Lila', NOW)).toEqual({
      kind: 'retry',
      label: 'Try again',
    });
  });

  it('re-dispatches a queued row whose dispatch failed or is older than 10 minutes', () => {
    const queued = book({ status: 'queued' });
    expect(bookCtaFor(choice({ status: 'in_progress', book: queued, dispatchError: 'boom' }), 'Lila', NOW).kind).toBe(
      'redispatch',
    );
    const old = book({ status: 'queued', created_at: new Date(NOW - STUCK_QUEUE_MS - 1000).toISOString() });
    expect(bookCtaFor(choice({ status: 'in_progress', book: old }), 'Lila', NOW).kind).toBe('redispatch');
  });

  it('shows a healthy in-progress book as busy', () => {
    const fresh = book({ status: 'queued', created_at: new Date(NOW - 60_000).toISOString() });
    expect(bookCtaFor(choice({ status: 'in_progress', book: fresh }), 'Lila', NOW)).toEqual({
      kind: 'busy',
      label: 'Being made…',
    });
    // `generating` is never re-dispatched, even when old.
    const generating = book({ status: 'generating', created_at: new Date(NOW - 3 * STUCK_QUEUE_MS).toISOString() });
    expect(bookCtaFor(choice({ status: 'in_progress', book: generating }), 'Lila', NOW).kind).toBe('busy');
  });
});
