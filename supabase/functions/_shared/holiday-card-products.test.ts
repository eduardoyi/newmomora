import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  CARD_PRODUCTS,
  ENABLED_COUNTRIES,
  evaluateQuote,
  gelatoFilesFor,
  HOLIDAY_CARD_TAX_CODE,
  isQuoteDeliverable,
  isValidPacks,
  maxCostCents,
  MIN_MARGIN,
  PACK_OPTIONS,
  packsForCards,
  printFileNames,
  priceCents,
  regionForCountry,
  regionGuessForTimezone,
  type QuoteForGuard,
} from './holiday-card-products.ts';

function quote(productsCents: number | null, shipping: (number | null)[], currency = 'USD'): QuoteForGuard {
  return { currency, quotes: [{ productsCents, currency, shipmentMethods: shipping.map((priceCents) => ({ priceCents })) }] };
}

Deno.test('us_ca product: 5R, two files, USD, $2.49 per card', () => {
  const product = CARD_PRODUCTS.us_ca;
  assertEquals(product.format, '5R');
  assertEquals(product.fileLayout, 'one_pdf');
  assertEquals(product.currency, 'USD');
  assertEquals(product.pricePerCardCents, 249);
  assert(product.productUid.startsWith('pack_of_cards_qt_10_pcs_pf_5r_'));
  assert(product.productUid.includes('glossy-protection'));
  assertEquals([...product.countries], ['US', 'CA']);
  assertEquals([...ENABLED_COUNTRIES], ['US', 'CA']);
});

Deno.test('packs: 20/30/50/100 cards map to 2/3/5/10 packs and price at $2.49 a card', () => {
  assertEquals(PACK_OPTIONS.map((o) => [o.packs, o.cards]), [[2, 20], [3, 30], [5, 50], [10, 100]]);
  assertEquals(priceCents('us_ca', 2), 4980);
  assertEquals(priceCents('us_ca', 3), 7470);
  assertEquals(priceCents('us_ca', 5), 12450);
  assertEquals(priceCents('us_ca', 10), 24900);
  assertEquals(packsForCards(50), 5);
  assertEquals(packsForCards(40), null);
  assert(isValidPacks(3));
  assert(!isValidPacks(1));
  assert(!isValidPacks('3'));
  assertThrows(() => priceCents('us_ca', 1), Error, 'HOLIDAY_CARD_PACKS_INVALID');
});

Deno.test('regionForCountry: US and CA only, case/space tolerant', () => {
  assertEquals(regionForCountry('US'), 'us_ca');
  assertEquals(regionForCountry(' ca '), 'us_ca');
  assertEquals(regionForCountry('PT'), null);
  assertEquals(regionForCountry('MX'), null);
  assertEquals(regionForCountry('PR'), null);
  assertEquals(regionForCountry(''), null);
  assertEquals(regionForCountry(null), null);
});

Deno.test('regionGuessForTimezone: US/CA zones guess us_ca, everything else null', () => {
  for (const tz of ['America/Chicago', 'America/New_York', 'America/Los_Angeles', 'America/Indiana/Indianapolis', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/St_Johns', 'US/Pacific', 'Canada/Eastern']) {
    assertEquals(regionGuessForTimezone(tz), 'us_ca', tz);
  }
  for (const tz of ['America/Mexico_City', 'America/Bogota', 'America/Sao_Paulo', 'Europe/Lisbon', 'Asia/Tokyo', 'UTC', '', null, undefined]) {
    assertEquals(regionGuessForTimezone(tz), null, String(tz));
  }
});

Deno.test('tax code constant is a Stripe txcd code', () => {
  assert(/^txcd_\d{8}$/.test(HOLIDAY_CARD_TAX_CODE));
});

Deno.test('print files: two_files = front + back as default/back; one_pdf = single default', () => {
  assertEquals(printFileNames('two_files'), ['front.pdf', 'back.pdf']);
  assertEquals(printFileNames('one_pdf'), ['card.pdf']);
  assertEquals(gelatoFilesFor('two_files', { frontUrl: 'https://x/f', backUrl: 'https://x/b' }), [
    { type: 'default', url: 'https://x/f' },
    { type: 'back', url: 'https://x/b' },
  ]);
  assertEquals(gelatoFilesFor('one_pdf', { pdfUrl: 'https://x/p' }), [{ type: 'default', url: 'https://x/p' }]);
  assertThrows(() => gelatoFilesFor('two_files', { frontUrl: 'https://x/f' }), Error, 'HOLIDAY_CARD_FILES_MISSING');
});

Deno.test('deliverability: needs a real numeric shipping price; 0 counts, null does not', () => {
  assert(isQuoteDeliverable(quote(1168, [703])));
  assert(isQuoteDeliverable(quote(1168, [null, 0])));
  assert(!isQuoteDeliverable(quote(1168, [null, null])));
  assert(!isQuoteDeliverable(quote(1168, [])));
  assert(!isQuoteDeliverable({ quotes: [] }));
  assert(!isQuoteDeliverable(quote(null, [703])));
});

Deno.test('max cost: price * (1 - MIN_MARGIN), floored without float drift', () => {
  assertEquals(MIN_MARGIN, 0.3);
  assertEquals(maxCostCents(4980), 3486);
  assertEquals(maxCostCents(12450), 8715);
  assertEquals(maxCostCents(24900), 17430);
});

Deno.test('guard accepts the real US quotes (2026-10-04) for every sold size', () => {
  const cases: [number, number, number][] = [[2, 1168, 703], [5, 3244, 856], [10, 5990, 1111]];
  for (const [packs, products, ship] of cases) {
    const verdict = evaluateQuote('us_ca', packs, quote(products, [ship]));
    assert(verdict.ok, `packs ${packs}`);
    if (verdict.ok) {
      assertEquals(verdict.costCents, products + ship);
      assertEquals(verdict.priceCents, priceCents('us_ca', packs));
    }
  }
});

Deno.test('guard picks the cheapest real shipping and ignores null prices', () => {
  const verdict = evaluateQuote('us_ca', 2, quote(1168, [2362, null, 703, 3193]));
  assert(verdict.ok);
  if (verdict.ok) assertEquals(verdict.shippingCents, 703);
});

Deno.test('guard rejects an over-cost quote (remote-address shipping)', () => {
  const verdict = evaluateQuote('us_ca', 2, quote(1168, [2900])); // 40.68 > 34.86
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assertEquals(verdict.reason, 'over_cost_guard');
    assertEquals(verdict.costCents, 4068);
    assertEquals(verdict.maxCostCents, 3486);
  }
  // exactly at the cap passes
  assert(evaluateQuote('us_ca', 2, quote(1168, [3486 - 1168])).ok);
  assert(!evaluateQuote('us_ca', 2, quote(1168, [3486 - 1168 + 1])).ok);
});

Deno.test('guard rejects non-deliverable and wrong-currency quotes', () => {
  const nd = evaluateQuote('us_ca', 2, quote(1168, [null]));
  assertEquals(nd.ok === false && nd.reason, 'not_deliverable');
  const cur = evaluateQuote('us_ca', 2, quote(1168, [703], 'EUR'));
  assertEquals(cur.ok === false && cur.reason, 'currency_mismatch');
});
