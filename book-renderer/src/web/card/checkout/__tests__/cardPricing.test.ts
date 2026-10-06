import { describe, expect, it } from 'vitest';
import { PACK_OPTIONS, PRICE_NOTE, isPacks } from '../cardPricing';

// The documented tier table (owner decision 2026-10-06). It must equal the
// server's: supabase/functions/_shared/holiday-card-products.ts (US_CA_TIERS).
describe('card price table (mirrors holiday-card-products.ts)', () => {
  it('has the five tiers with per-card price, total and savings', () => {
    expect(PACK_OPTIONS.map((o) => [o.packs, o.cards, o.pricePerCardCents, o.totalCents, o.savingsPercent])).toEqual([
      [1, 10, 299, 2990, 0],
      [2, 20, 249, 4980, 17],
      [3, 30, 229, 6870, 23],
      [5, 50, 199, 9950, 33],
      [10, 100, 179, 17900, 40],
    ]);
  });

  it('accepts only the offered pack counts', () => {
    for (const packs of [1, 2, 3, 5, 10]) expect(isPacks(packs)).toBe(true);
    for (const packs of [0, 4, 20, '2', null]) expect(isPacks(packs)).toBe(false);
  });

  it('says shipping is included and tax is added at checkout', () => {
    expect(PRICE_NOTE).toBe('Shipping included · tax added at checkout');
  });
});
