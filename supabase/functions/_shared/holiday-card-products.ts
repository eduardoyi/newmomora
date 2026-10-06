// Holiday card product map, pricing and quote rules (docs/plans/holiday-cards-p1.md
// §2, §3 "Gelato facts", Step 2 / Step 6). Pure: no I/O, no env, no Deno-only
// APIs, so it runs in Edge Functions and Cloudflare Workers alike.
//
// v1 sells US + CA only (owner, 2026-10-06): 5x7 ("5R"), USD, shipping included,
// packs of 10, TIERED per-card price (owner, 2026-10-06: $2.99 at 10 cards down
// to $1.79 at 100; see `US_CA_TIERS`). The shop mirrors the table in
// book-renderer/src/web/card/checkout/cardPricing.ts: change both together. Europe (A5, one 2-page PDF, EUR) is NOT
// sold: books exclude the EU for the same VAT reason. The map is data-driven so
// an `eu` entry can be added later without touching the callers:
//   1. extend `CardRegion` with 'eu',
//   2. add its entry to `CARD_PRODUCTS` (format 'A5', fileLayout 'one_pdf',
//      currency 'EUR', the A5 product uid, its countries),
//   3. extend `ENABLED_COUNTRIES`/`regionForCountry` and the timezone guess.
// Nothing else (Gelato client, snapshot, quote guard) is region specific.

export type CardRegion = 'us_ca';
export type CardPrintFormat = '5R' | 'A5';
/** `one_pdf`: ONE 2-page PDF (page 1 front, page 2 back) as Gelato `default`.
 * Both card lines need it: the EU A5 pack (confirmed by Gelato support
 * 2026-10-05) and the US 5R pack — order 05f43f74 with separate `default` +
 * `back` files was refused on 2026-10-06 ("Can't combine multiple files into
 * production one"). `two_files` (separate `default` + `back`) stays supported
 * by the renderer and the Gelato client but no product uses it. */
export type CardFileLayout = 'two_files' | 'one_pdf';
export type CardCurrency = 'USD' | 'EUR';

export const CARDS_PER_PACK = 10;

export interface PriceTier {
  /** Gelato quantity (packs of 10). */
  packs: number;
  cards: number;
  /** What the parent pays per card at this quantity, shipping included, tax excluded. */
  pricePerCardCents: number;
}

function tier(packs: number, pricePerCardCents: number): PriceTier {
  return { packs, cards: packs * CARDS_PER_PACK, pricePerCardCents };
}

/**
 * Tiered US/CA price (owner decision 2026-10-06; shipping included, tax extra):
 * 10 cards $2.99 ($29.90), 20 $2.49 ($49.80), 30 $2.29 ($68.70), 50 $1.99
 * ($99.50), 100 $1.79 ($179.00). The first tier is the "Save X%" baseline.
 */
const US_CA_TIERS: readonly PriceTier[] = [tier(1, 299), tier(2, 249), tier(3, 229), tier(5, 199), tier(10, 179)];

export interface CardProduct {
  region: CardRegion;
  /** Gelato product uid (one pack = 10 cards; Gelato `quantity` counts packs). */
  productUid: string;
  format: CardPrintFormat;
  fileLayout: CardFileLayout;
  currency: CardCurrency;
  /** The price tiers, one per sellable pack count (per-card price shipping included, tax excluded). */
  tiers: readonly PriceTier[];
  /** ISO 3166-1 alpha-2 codes this product ships to. */
  countries: readonly string[];
}

/** Countries the card shop sells to in v1. */
export const ENABLED_COUNTRIES = ['US', 'CA'] as const;
export type EnabledCountry = (typeof ENABLED_COUNTRIES)[number];

export const CARD_PRODUCTS: Record<CardRegion, CardProduct> = {
  us_ca: {
    region: 'us_ca',
    // 5R, 350 gsm coated silk, 4/4, gloss protection on the FRONT only (the back
    // stays writable), standard envelopes, pack of 10. Verified with a real
    // draft + quote 2026-10-06; files as ONE 2-page PDF (see CardFileLayout).
    productUid:
      'pack_of_cards_qt_10_pcs_pf_5r_upt_350-gsm-130lb-coated-silk_cl_4-4_ct_glossy-protection_prt_1-0_sft_none_set_none_hor_ept_standard',
    format: '5R',
    fileLayout: 'one_pdf',
    currency: 'USD',
    tiers: US_CA_TIERS,
    countries: ENABLED_COUNTRIES,
  },
};

export interface PackOption {
  /** Gelato quantity (packs of 10). */
  packs: number;
  cards: number;
}

/**
 * Quantities offered: 10 / 20 / 30 / 50 / 100 cards. Every region offers the
 * same pack counts (only the per-card price may differ), so this is derived
 * from the US/CA tiers; a region with a different set would need per-region
 * validation.
 */
export const PACK_OPTIONS: readonly PackOption[] = US_CA_TIERS.map(({ packs, cards }) => ({ packs, cards }));

export function isValidPacks(packs: unknown): packs is number {
  return typeof packs === 'number' && PACK_OPTIONS.some((option) => option.packs === packs);
}

/** Packs for a card count (10/20/30/50/100), or null when it is not offered. */
export function packsForCards(cards: unknown): number | null {
  return PACK_OPTIONS.find((option) => option.cards === cards)?.packs ?? null;
}

function tierFor(region: CardRegion, packs: number): PriceTier {
  const found = isValidPacks(packs) ? CARD_PRODUCTS[region].tiers.find((t) => t.packs === packs) : undefined;
  if (!found) throw new Error('HOLIDAY_CARD_PACKS_INVALID');
  return found;
}

/** Total price (tax excluded, shipping included). Throws on a pack count that is not offered. */
export function priceCents(region: CardRegion, packs: number): number {
  const t = tierFor(region, packs);
  return t.pricePerCardCents * t.cards;
}

/**
 * "Save X%" for the shop: the tier's per-card price against the smallest
 * tier's, rounded to a whole percent (0 for the smallest tier). Throws on a
 * pack count that is not offered.
 */
export function savingsPercent(region: CardRegion, packs: number): number {
  const t = tierFor(region, packs);
  const base = CARD_PRODUCTS[region].tiers[0];
  return Math.round((1 - t.pricePerCardCents / base.pricePerCardCents) * 100);
}

// ── Region lookups ────────────────────────────────────────────────────────

/** The region a shipping country belongs to, or null when we do not sell there. */
export function regionForCountry(iso: string | null | undefined): CardRegion | null {
  if (typeof iso !== 'string') return null;
  const code = iso.trim().toUpperCase();
  for (const product of Object.values(CARD_PRODUCTS)) {
    if (product.countries.includes(code)) return product.region;
  }
  return null;
}

// IANA zones of the US and Canada (explicit lists: `America/*` also covers Mexico
// and all of Latin America, which we do not sell to).
const US_CA_ZONES: ReadonlySet<string> = new Set([
  // United States
  'America/New_York', 'America/Detroit', 'America/Chicago', 'America/Menominee', 'America/Denver', 'America/Boise',
  'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Metlakatla',
  'America/Yakutat', 'America/Nome', 'America/Adak', 'Pacific/Honolulu',
  'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
  'America/Indiana/Indianapolis', 'America/Indiana/Knox', 'America/Indiana/Marengo', 'America/Indiana/Petersburg',
  'America/Indiana/Tell_City', 'America/Indiana/Vevay', 'America/Indiana/Vincennes', 'America/Indiana/Winamac',
  'America/North_Dakota/Beulah', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem',
  // Canada
  'America/Toronto', 'America/Montreal', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax',
  'America/St_Johns', 'America/Regina', 'America/Moncton', 'America/Glace_Bay', 'America/Goose_Bay', 'America/Iqaluit',
  'America/Rankin_Inlet', 'America/Resolute', 'America/Cambridge_Bay', 'America/Inuvik', 'America/Whitehorse',
  'America/Dawson', 'America/Dawson_Creek', 'America/Fort_Nelson', 'America/Swift_Current', 'America/Atikokan',
  'America/Blanc-Sablon', 'America/Creston', 'America/Nipigon', 'America/Thunder_Bay', 'America/Pangnirtung',
  'America/Rainy_River', 'America/Yellowknife', 'America/Coral_Harbour',
]);

/**
 * Best-effort early warning from the device timezone (IANA name), used by the
 * card `create` op to refuse BEFORE any AI or film spend when the parent is
 * clearly outside the sold countries. It is a guess, not an authority: the
 * shipping address decides at quote time (`regionForCountry`). Returns
 * 'us_ca' for a US/CA zone (including the legacy `US/*` and `Canada/*`
 * aliases), null for anything else, including an unknown or empty zone, so
 * callers must treat null as "not sure / outside", never as "elsewhere
 * confirmed". A traveller or an expat in Mexico City is correctly a null.
 */
export function regionGuessForTimezone(timeZone: string | null | undefined): CardRegion | null {
  if (typeof timeZone !== 'string') return null;
  const tz = timeZone.trim();
  if (!tz) return null;
  if (US_CA_ZONES.has(tz)) return 'us_ca';
  if (tz.startsWith('US/') || tz.startsWith('Canada/')) return 'us_ca';
  return null;
}

// ── Tax code ──────────────────────────────────────────────────────────────

/**
 * Stripe Tax code for the card line item. The book uses `txcd_35010000`
 * (Books); a pack of printed greeting cards is general tangible goods in the US
 * and Canada, so this is Stripe's general tangible-goods code. OWNER: confirm in
 * the Stripe tax settings / code picker whether a more specific printed-matter
 * or greeting-card code applies before launch (the book's code was corrected
 * after the fact, `_shared/stripe.ts`), and change it here, in one place.
 */
export const HOLIDAY_CARD_TAX_CODE = 'txcd_99999999';

/** Product name on the Stripe line item / receipt. */
export const HOLIDAY_CARD_PRODUCT_NAME = 'Momora Holiday Cards';

// ── Print file helpers ────────────────────────────────────────────────────

/** File names the render step writes under `print-orders/<orderId>/`. */
export function printFileNames(layout: CardFileLayout): string[] {
  return layout === 'two_files' ? ['front.pdf', 'back.pdf'] : ['card.pdf'];
}

export interface CardPrintFileUrls {
  /** `two_files`: the front PDF. */
  frontUrl?: string;
  /** `two_files`: the back PDF. */
  backUrl?: string;
  /** `one_pdf`: the 2-page PDF (page 1 front, page 2 back). */
  pdfUrl?: string;
}

/** Gelato `files` array for a layout (`default` = front; `back` = separate back). */
export function gelatoFilesFor(layout: CardFileLayout, urls: CardPrintFileUrls): { type: 'default' | 'back'; url: string }[] {
  if (layout === 'two_files') {
    if (!urls.frontUrl || !urls.backUrl) throw new Error('HOLIDAY_CARD_FILES_MISSING');
    return [{ type: 'default', url: urls.frontUrl }, { type: 'back', url: urls.backUrl }];
  }
  if (!urls.pdfUrl) throw new Error('HOLIDAY_CARD_FILES_MISSING');
  return [{ type: 'default', url: urls.pdfUrl }];
}

// ── Quote rules ───────────────────────────────────────────────────────────

/**
 * Minimum gross margin on the cost side: the cheapest real Gelato cost
 * (products + shipping) must be at most `price * (1 - MIN_MARGIN)`. 30% covers
 * Stripe's fee (~3% + $0.30) and leaves a real margin; sales tax is on top of
 * the price and passes through, so it is not part of this.
 *
 * US numbers (Gelato quotes, 2026-10-04..06, USD, USPS Ground Advantage):
 *   1 pack:  $5.84 + $6.52 shipping = $12.36 vs price $29.90 (cap $20.93, ok)
 *   2 packs: $11.68 + $7.03 = $18.71 vs price $49.80 (cap $34.86, ok)
 *   5 packs: $32.44 + $8.56 = $41.00 vs price $99.50 (cap $69.65, ok)
 *  10 packs: $59.90 + $11.11 = $71.01 vs price $179.00 (cap $125.30, ok)
 * Each tier's guard compares the cost to THAT order's price (`priceCents`).
 * Alaska/Hawaii/PR/APO addresses can push shipping far above these; the guard
 * refuses a quote that would make a shipping-included price unprofitable.
 */
export const MIN_MARGIN = 0.3;

/** The most a cart may cost us (cents) for a given price. */
export function maxCostCents(price: number): number {
  // Round before flooring so 4980 * 0.7 (= 3485.9999...) is not off by one.
  return Math.floor(Math.round(price * (1 - MIN_MARGIN) * 1000) / 1000);
}

/** The subset of a parsed Gelato quote the rules need (`gelato.ts` `GelatoQuote` satisfies it). */
export interface QuoteForGuard {
  currency?: string | null;
  quotes: {
    productsCents: number | null;
    currency?: string | null;
    shipmentMethods: { priceCents: number | null }[];
  }[];
}

export type QuoteRejection = 'not_deliverable' | 'currency_mismatch' | 'over_cost_guard';

export type QuoteVerdict =
  | {
    ok: true;
    productCents: number;
    shippingCents: number;
    costCents: number;
    priceCents: number;
    maxCostCents: number;
  }
  | {
    ok: false;
    reason: QuoteRejection;
    /** Present for `over_cost_guard` (and `currency_mismatch` has none). */
    costCents?: number;
    priceCents?: number;
    maxCostCents?: number;
  };

/**
 * Deliverability: a quote only counts as deliverable when at least one shipment
 * method carries a REAL numeric price (EU quotes for products that are not made
 * there come back with `price: null` shipping, plan §C5). A 0 is a real price.
 */
export function isQuoteDeliverable(quote: QuoteForGuard): boolean {
  return quote.quotes.some((q) => q.productsCents !== null && q.shipmentMethods.some((m) => m.priceCents !== null));
}

/**
 * The full quote check for a region + pack count: deliverable, same currency,
 * and (cheapest real shipping + product cost) <= price * (1 - MIN_MARGIN).
 */
export function evaluateQuote(region: CardRegion, packs: number, quote: QuoteForGuard): QuoteVerdict {
  const product = CARD_PRODUCTS[region];
  if (!isQuoteDeliverable(quote)) return { ok: false, reason: 'not_deliverable' };

  let best: { productCents: number; shippingCents: number } | null = null;
  let sawCurrency = false;
  for (const q of quote.quotes) {
    if (q.productsCents === null) continue;
    const currency = q.currency ?? quote.currency ?? null;
    if (currency !== null && currency.toUpperCase() !== product.currency) continue;
    sawCurrency = true;
    for (const method of q.shipmentMethods) {
      if (method.priceCents === null) continue;
      const total = q.productsCents + method.priceCents;
      if (best === null || total < best.productCents + best.shippingCents) {
        best = { productCents: q.productsCents, shippingCents: method.priceCents };
      }
    }
  }
  if (!sawCurrency || best === null) return { ok: false, reason: 'currency_mismatch' };

  const price = priceCents(region, packs);
  const cap = maxCostCents(price);
  const cost = best.productCents + best.shippingCents;
  if (cost > cap) return { ok: false, reason: 'over_cost_guard', costCents: cost, priceCents: price, maxCostCents: cap };
  return { ok: true, productCents: best.productCents, shippingCents: best.shippingCents, costCents: cost, priceCents: price, maxCostCents: cap };
}
