/**
 * Shared shapes for the checkout/order screens (memory-book-5c plan Step 6).
 * Split out of `ordersApi.ts` into their own module so `dev/fixture.ts` can
 * import the address shape without a circular import back to `ordersApi.ts`
 * (which itself imports the fixture module's mock functions).
 */

/** Mirrors `supabase/functions/memory-book-orders/index.ts`'s
 * `ShippingAddress` (the `quote` op's request shape) field-for-field. */
export interface ShippingAddressInput {
  name: string;
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode: string;
  countryCode: string;
}

export interface QuoteResult {
  orderId: string;
  status: 'quoted';
  priceCents: number;
  shippingCostCents: number;
  totalCents: number;
  currency: string;
  pageCount: number;
}

export interface CreateCheckoutResult {
  orderId: string;
  /** Null only in DEV fixture mode (no real Stripe session exists there) —
   * the caller's signal to navigate client-side to `/order/<id>` instead of
   * redirecting to Stripe. See `ordersApi.ts#createCheckoutSession`. */
  checkoutUrl: string | null;
}
