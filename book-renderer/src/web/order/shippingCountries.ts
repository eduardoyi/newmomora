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
 * `memory-book-orders`'s `quote` op re-validates `countryCode` as a bare
 * 2-letter ISO shape regardless of this list (see `validateShippingAddress`
 * in `supabase/functions/memory-book-orders/index.ts`) -- this list is a
 * client-side UX narrowing (don't let a parent fill out a whole address for
 * a destination we can't quote), not the real trust boundary.
 */

export interface ShipsToCountry {
  code: string;
  name: string;
}

export const SHIPS_TO_COUNTRIES: ShipsToCountry[] = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'ES', name: 'Spain' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'IT', name: 'Italy' },
  { code: 'PT', name: 'Portugal' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'IE', name: 'Ireland' },
  { code: 'AT', name: 'Austria' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'NO', name: 'Norway' },
  { code: 'PL', name: 'Poland' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'JP', name: 'Japan' },
  { code: 'SG', name: 'Singapore' },
  { code: 'MX', name: 'Mexico' },
];

export const DEFAULT_SHIPS_TO_COUNTRY_CODE = 'US';

export function isShipsToCountryCode(code: string): boolean {
  return SHIPS_TO_COUNTRIES.some((c) => c.code === code);
}
