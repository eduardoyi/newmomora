import { CardApiError } from '../cardTypes';

/**
 * Types and PURE parsers for the `holiday-card-orders` Edge Function client
 * (no Supabase import: they unit-test in plain node). The network calls live
 * in `cardOrdersApi.ts`; the contract is docs/plans/holiday-cards-p2.md Step 5
 * and supabase/functions/holiday-card-orders/index.ts.
 */

// ── Packs and prices ─────────────────────────────────────────────────────

// The price table lives in ONE module (it mirrors the server's tiers).
export { CARDS_PER_PACK, PACK_OPTIONS, isPacks, type PackOption, type Packs } from './cardPricing';
import { CARDS_PER_PACK, isPacks, type Packs } from './cardPricing';

export function formatMoney(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

// ── Responses ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function bad(what: string): never {
  throw new CardApiError(0, 'bad_response', `Unexpected response (${what})`);
}

export function parseDraft(raw: unknown): { orderId: string } {
  if (!isObj(raw) || !str(raw.orderId)) return bad('create_draft');
  return { orderId: raw.orderId as string };
}

export interface CardOrderQuote {
  orderId: string;
  packs: Packs;
  cards: number;
  /** The total the buyer pays before tax (shipping included). */
  priceCents: number;
  currency: string;
  region: string | null;
  format: string | null;
}

export function parseQuote(raw: unknown): CardOrderQuote {
  if (!isObj(raw) || !str(raw.orderId) || !isPacks(raw.packs) || num(raw.priceCents) === null) return bad('quote');
  const packs = raw.packs;
  return {
    orderId: raw.orderId as string,
    packs,
    cards: num(raw.cards) ?? packs * CARDS_PER_PACK,
    priceCents: raw.priceCents as number,
    currency: str(raw.currency) ?? 'USD',
    region: str(raw.region),
    format: str(raw.format),
  };
}

export interface CheckoutSession {
  orderId: string;
  checkoutUrl: string;
  resumed: boolean;
  /** When the Stripe session expires (ISO), as the server reports it. */
  expiresAt: string | null;
}

/** Only a real https Stripe-style URL (or a same-origin return URL in the dev walkthrough) is ever navigated to. */
export function isSafeCheckoutUrl(url: string, origin?: string): boolean {
  try {
    const parsed = new URL(url, origin);
    return parsed.protocol === 'https:' || (origin !== undefined && parsed.origin === new URL(origin).origin);
  } catch {
    return false;
  }
}

export function parseCheckout(raw: unknown, origin?: string): CheckoutSession {
  if (!isObj(raw) || !str(raw.orderId)) return bad('create_checkout');
  const url = str(raw.checkoutUrl);
  if (!url || !isSafeCheckoutUrl(url, origin)) return bad('create_checkout url');
  return { orderId: raw.orderId as string, checkoutUrl: url, resumed: raw.resumed === true, expiresAt: str(raw.expiresAt) };
}

export type CardOrderStatusName = 'draft' | 'quoted' | 'checkout' | 'paid' | 'rendering' | 'submitted' | 'in_production' | 'shipped' | 'failed' | 'cancelled';

export const CARD_ORDER_STATUS_NAMES: readonly CardOrderStatusName[] = [
  'draft',
  'quoted',
  'checkout',
  'paid',
  'rendering',
  'submitted',
  'in_production',
  'shipped',
  'failed',
  'cancelled',
];

export interface CardOrderStatus {
  orderId: string;
  cardId: string | null;
  /** A status this build does not know degrades to `'unknown'` (generic copy, polling stops). */
  status: CardOrderStatusName | 'unknown';
  packs: number | null;
  cards: number | null;
  priceCents: number | null;
  currency: string;
  region: string | null;
  gelatoStatus: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  shippedAt: string | null;
  failureReason: string | null;
  /** True once money was refunded (with the date when the row carries it). */
  refunded: boolean;
  refundedAt: string | null;
  /** The quoted destination (camelCase, as the quote op stored it). */
  shippingAddress: OrderShippingAddress | null;
  createdAt: string | null;
}

export interface OrderShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode: string;
  countryCode: string;
}

function parseAddress(raw: unknown): OrderShippingAddress | null {
  if (!isObj(raw) || !str(raw.name) || !str(raw.line1) || !str(raw.postalCode) || !str(raw.countryCode)) return null;
  return {
    name: raw.name as string,
    line1: raw.line1 as string,
    ...(str(raw.line2) ? { line2: raw.line2 as string } : {}),
    ...(str(raw.city) ? { city: raw.city as string } : {}),
    ...(str(raw.state) ? { state: raw.state as string } : {}),
    postalCode: raw.postalCode as string,
    countryCode: raw.countryCode as string,
  };
}

/** A tracking link is only ever followed when it is http(s). */
export function safeTrackingUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function parseOrderStatus(raw: unknown): CardOrderStatus {
  if (!isObj(raw) || !str(raw.orderId) || !str(raw.status)) return bad('status');
  const status = CARD_ORDER_STATUS_NAMES.includes(raw.status as CardOrderStatusName) ? (raw.status as CardOrderStatusName) : 'unknown';
  return {
    orderId: raw.orderId as string,
    cardId: str(raw.cardId),
    status,
    packs: num(raw.packs),
    cards: num(raw.cards),
    priceCents: num(raw.priceCents),
    currency: str(raw.currency) ?? 'USD',
    region: str(raw.region),
    gelatoStatus: str(raw.gelatoStatus),
    trackingNumber: str(raw.trackingNumber),
    trackingUrl: safeTrackingUrl(str(raw.trackingUrl)),
    carrier: str(raw.carrier),
    shippedAt: str(raw.shippedAt),
    failureReason: str(raw.failureReason),
    refunded: raw.refunded === true || str(raw.refundedAt) !== null,
    refundedAt: str(raw.refundedAt),
    shippingAddress: parseAddress(raw.shippingAddress),
    createdAt: str(raw.createdAt),
  };
}

/**
 * A `holiday_card_orders` row read straight from the table (snake_case;
 * buyer-only RLS, the columns the client is granted): the same direct read the
 * Memory Book's order page makes. Maps onto the same shape as the `status` op.
 */
export function parseOrderRow(raw: unknown): CardOrderStatus {
  if (!isObj(raw)) return bad('order row');
  const packs = num(raw.packs);
  return parseOrderStatus({
    orderId: raw.id,
    cardId: raw.card_id,
    status: raw.status,
    packs,
    cards: packs === null ? null : packs * CARDS_PER_PACK,
    priceCents: raw.price_cents,
    currency: raw.currency,
    region: raw.region,
    gelatoStatus: raw.gelato_status,
    trackingNumber: raw.tracking_number,
    trackingUrl: raw.tracking_url,
    carrier: raw.carrier,
    shippedAt: raw.shipped_at,
    failureReason: raw.failure_reason,
    refundedAt: raw.refunded_at,
    shippingAddress: raw.shipping_address,
    createdAt: raw.created_at,
  });
}

export function parseCancel(raw: unknown): { status: string } {
  if (!isObj(raw)) return bad('cancel_checkout');
  return { status: str(raw.status) ?? 'cancelled' };
}
