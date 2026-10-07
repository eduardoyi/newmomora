import { holidayCardTileState } from '@/utils/holiday-card-state';
import type { HolidayCardSummary } from '@/services/holiday-cards';

function summary(overrides: Partial<HolidayCardSummary> = {}): HolidayCardSummary {
  return {
    enabled: true,
    cardId: null,
    year: null,
    status: null,
    readiness: null,
    lastFailureCode: null,
    ordered: false,
    language: 'en',
    ...overrides,
  };
}

const card = (overrides: Partial<HolidayCardSummary> = {}) =>
  summary({ cardId: 'card-1', year: 2026, status: 'ready', ...overrides });

describe('holidayCardTileState', () => {
  it('maps the summary to a tile state', () => {
    expect(holidayCardTileState(null, '2026-10-15')).toBeNull();
    expect(holidayCardTileState(summary({ enabled: false }), '2026-10-15')).toBeNull();
    expect(holidayCardTileState(summary(), '2026-10-15')).toBe('make');
    expect(holidayCardTileState(card({ status: 'generating' }), '2026-10-15')).toBe('generating');
    expect(holidayCardTileState(card(), '2026-10-15')).toBe('ready');
    expect(holidayCardTileState(card({ status: 'failed' }), '2026-10-15')).toBe('failed');
    expect(holidayCardTileState(card({ ordered: true }), '2026-10-15')).toBe('ordered');
  });

  it.each([
    ['generating', 'generating'],
    ['film', 'generating'],
    ['ready', 'ready'],
    ['failed', 'failed'],
  ] as const)('readiness %s wins over status and maps to %s', (readiness, expected) => {
    // `status` reads "ready" while the film is still rendering.
    expect(holidayCardTileState(card({ status: 'ready', readiness }), '2026-10-15')).toBe(expected);
  });

  it('falls back to status when readiness is absent (older backend)', () => {
    expect(holidayCardTileState(card({ status: 'generating', readiness: null }), '2026-10-15')).toBe('generating');
    expect(holidayCardTileState(card({ status: 'ready', readiness: null }), '2026-10-15')).toBe('ready');
  });

  it('ordered wins over readiness', () => {
    expect(holidayCardTileState(card({ ordered: true, readiness: 'film' }), '2026-10-15')).toBe('ordered');
  });

  it('shows a card even when the server switch is off', () => {
    expect(holidayCardTileState(card({ enabled: false }), '2026-10-15')).toBe('ready');
  });

  it('keeps last year\'s ORDERED card as "ordered" through Jan 31', () => {
    const lastYearOrdered = card({ year: 2025, ordered: true });
    expect(holidayCardTileState(lastYearOrdered, '2026-01-01')).toBe('ordered');
    expect(holidayCardTileState(lastYearOrdered, '2026-01-15')).toBe('ordered');
    expect(holidayCardTileState(lastYearOrdered, '2026-01-31')).toBe('ordered');
    expect(holidayCardTileState(card({ year: 2025, ordered: true, enabled: false }), '2026-01-15')).toBe('ordered');
  });

  it('drops last year\'s ordered card from Feb 1: make when enabled, hidden when not', () => {
    expect(holidayCardTileState(card({ year: 2025, ordered: true }), '2026-02-01')).toBe('make');
    expect(holidayCardTileState(card({ year: 2025, ordered: true, enabled: false }), '2026-02-01')).toBeNull();
    expect(holidayCardTileState(card({ year: 2025, ordered: true }), '2026-10-15')).toBe('make');
  });

  it('treats a previous-year card that was never ordered as no card', () => {
    expect(holidayCardTileState(card({ year: 2025 }), '2026-01-15')).toBe('make');
    expect(holidayCardTileState(card({ year: 2025, status: 'failed', enabled: false }), '2026-01-15')).toBeNull();
  });

  it('does not keep a card from two years back', () => {
    expect(holidayCardTileState(card({ year: 2024, ordered: true }), '2026-01-15')).toBe('make');
  });
});
