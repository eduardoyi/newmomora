/**
 * Country selector options for the checkout address form (memory-book-5c
 * plan Step 6, per the task brief: "country selector limited to the SKU's
 * shipsTo list — hardcode the list from docs/plans/prodigi-order-spec.md or
 * a constants file").
 *
 * `docs/plans/prodigi-order-spec.md` documents Orders/Quotes/spine request
 * shapes in detail (every example uses `destinationCountryCode: "ES"`, the
 * owner's own test destination) but contains NO enumerated "this SKU ships
 * to these countries" list anywhere -- there is nothing to hardcode FROM
 * that doc. This is therefore the "or a constants file" fallback the brief
 * allows: a curated, best-effort set of markets Prodigi's global print
 * network is known to reach for a book product (their own marketing states
 * worldwide fulfillment from a regional-print-node network), NOT an
 * independently confirmed per-SKU destination list.
 *
 * IMPORTANT -- unconfirmed, same posture as `_shared/prodigi.ts`'s own
 * documented open questions: the real-order canary (plan step 7) is the
 * actual confirmation point. If `POST /v4.0/quotes` or `POST /v4.0/Orders`
 * ever rejects a country on this list (or a customer asks for one that
 * isn't), prune/extend this list and cite the response, not guesswork.
 * ZERO-REGISTRATION LAUNCH LIST (owner decision 2026-09-10): this list is
 * now a TAX boundary, not just a UX narrowing. Prodigi's layflat SKU is
 * fulfilled from EU + US labs (their product page; the owner's own sample
 * shipped from Germany), which makes EU destinations EU-located supplies
 * (zero-threshold VAT registration for a non-established seller) and UK
 * destinations sub-£135 imports (also zero-threshold seller registration)
 * -- both EXCLUDED until the LLC registers. Every remaining destination is
 * registration-free below its non-resident seller threshold at launch
 * volume. The server enforces the SAME list (`memory-book-orders`'s
 * `validateShippingAddress` -- a crafted request must not be able to
 * create the very obligation this list avoids); keep the two in sync when
 * registrations land and countries return (EU/UK re-entry is one
 * registration each -- see docs/plans/memory-book.md's launch ledger).
 */

export interface ShipsToCountry {
  code: string;
  name: string;
}

export const SHIPS_TO_COUNTRIES: ShipsToCountry[] = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'MX', name: 'Mexico' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'JP', name: 'Japan' },
  { code: 'SG', name: 'Singapore' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'NO', name: 'Norway' },
];

export const DEFAULT_SHIPS_TO_COUNTRY_CODE = 'US';

export function isShipsToCountryCode(code: string): boolean {
  return SHIPS_TO_COUNTRIES.some((c) => c.code === code);
}
