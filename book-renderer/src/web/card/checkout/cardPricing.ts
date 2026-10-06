/**
 * The card shop's price table. This MIRRORS the server's, which is the
 * authority: `supabase/functions/_shared/holiday-card-products.ts`
 * (`US_CA_TIERS`, `priceCents`, `savingsPercent`). The shop cannot import the
 * Deno module, so the table lives here, ONCE; change both together (the tier
 * values are pinned by `__tests__/cardPricing.test.ts`). The quote the server
 * returns is what the buyer is actually charged; this only drives the list
 * prices and the "Save X%" badges on the quantity step.
 *
 * Owner decision 2026-10-06: tiered per-card price, shipping included, tax
 * extra, relative to the 10-card per-card price for "Save X%".
 */

export type Packs = 1 | 2 | 3 | 5 | 10;

export const CARDS_PER_PACK = 10;

export interface PackOption {
  packs: Packs;
  cards: number;
  /** Shipping included, tax excluded. */
  pricePerCardCents: number;
  /** The list price the quote will confirm (the server's price is the authority). */
  totalCents: number;
  /** "Save X%" against the 10-card per-card price, rounded; 0 for the 10-card option (no badge). */
  savingsPercent: number;
}

const TIERS: readonly (readonly [Packs, number])[] = [
  [1, 299],
  [2, 249],
  [3, 229],
  [5, 199],
  [10, 179],
];

const BASE_PER_CARD_CENTS = TIERS[0][1];

export const PACK_OPTIONS: readonly PackOption[] = TIERS.map(([packs, pricePerCardCents]) => ({
  packs,
  cards: packs * CARDS_PER_PACK,
  pricePerCardCents,
  totalCents: packs * CARDS_PER_PACK * pricePerCardCents,
  savingsPercent: Math.round((1 - pricePerCardCents / BASE_PER_CARD_CENTS) * 100),
}));

export function isPacks(value: unknown): value is Packs {
  return PACK_OPTIONS.some((option) => option.packs === value);
}

/** The hint under the quantity options. */
export const PRICE_NOTE = 'Shipping included · tax added at checkout';
