import type { CardShippingAddress } from '../../order/cardAddress';
import { supabase } from '../../supabaseClient';
import { invoke } from '../cardApi';
import { CardApiError } from '../cardTypes';
import {
  fixtureCancelCheckout,
  fixtureCreateCheckout,
  fixtureCreateDraft,
  fixtureOrderStatus,
  fixtureQuote,
  isCardFixture,
} from '../dev/cardFixture';
import {
  parseCancel,
  parseCheckout,
  parseDraft,
  parseOrderRow,
  parseOrderStatus,
  parseQuote,
  type CardOrderQuote,
  type CardOrderStatus,
  type CheckoutSession,
  type Packs,
} from './checkoutTypes';

/**
 * Typed clients for the `holiday-card-orders` Edge Function (create_draft,
 * quote, create_checkout, cancel_checkout, status). Every failure is a
 * `CardApiError { status, code }` (a hung call becomes status 0 / `timeout`),
 * the shape `errorCopy.ts` describes. Each op has a DEV-only walkthrough branch
 * (`dev/cardFixture.ts`), dead code in a production build.
 */

const FUNCTION = 'holiday-card-orders';

/** Draft and status are quick reads/writes. */
export const ORDER_READ_TIMEOUT_MS = 30_000;
/** `quote` asks the print partner for a price (its own timeout is 30 s). */
export const QUOTE_TIMEOUT_MS = 45_000;
/** `create_checkout` only opens the Stripe session (the print files are made after payment): the default cap, like the book's. */
export const CREATE_CHECKOUT_TIMEOUT_MS = 45_000;

export async function createCardDraft(cardId: string): Promise<{ orderId: string }> {
  if (import.meta.env.DEV && isCardFixture()) return parseDraft(await fixtureCreateDraft(cardId));
  return parseDraft(await invoke<unknown>(FUNCTION, { op: 'create_draft', cardId }, ORDER_READ_TIMEOUT_MS));
}

export async function quoteCardOrder(orderId: string, packs: Packs, address: CardShippingAddress): Promise<CardOrderQuote> {
  if (import.meta.env.DEV && isCardFixture()) return parseQuote(await fixtureQuote(orderId, packs, address));
  return parseQuote(await invoke<unknown>(FUNCTION, { op: 'quote', orderId, packs, address }, QUOTE_TIMEOUT_MS));
}

export async function createCardCheckout(orderId: string, expectedEditsVersion: number): Promise<CheckoutSession> {
  if (import.meta.env.DEV && isCardFixture()) return parseCheckout(await fixtureCreateCheckout(orderId, expectedEditsVersion), window.location.origin);
  return parseCheckout(await invoke<unknown>(FUNCTION, { op: 'create_checkout', orderId, expectedEditsVersion }, CREATE_CHECKOUT_TIMEOUT_MS));
}

export async function cancelCardCheckout(orderId: string): Promise<{ status: string }> {
  if (import.meta.env.DEV && isCardFixture()) return parseCancel(await fixtureCancelCheckout(orderId));
  return parseCancel(await invoke<unknown>(FUNCTION, { op: 'cancel_checkout', orderId }, ORDER_READ_TIMEOUT_MS));
}

/** The columns the client is granted on `holiday_card_orders` that the status page reads (no `*`: the grant is column-level). */
export const ORDER_STATUS_COLUMNS =
  'id, card_id, status, packs, price_cents, currency, region, gelato_status, tracking_number, tracking_url, carrier, shipped_at, failure_reason, refunded_at, shipping_address, created_at';

/**
 * One order's status. Like the Memory Book's order page, a direct read of the
 * buyer's own row (RLS: `requested_by = auth.uid()`), so no Edge Function round
 * trip per poll and the refund date and address come with it. A row that RLS
 * hides (someone else's order) is a 404 `ORDER_NOT_FOUND`, like the function's.
 */
export async function getCardOrderStatus(orderId: string): Promise<CardOrderStatus> {
  if (import.meta.env.DEV && isCardFixture()) return parseOrderStatus(await fixtureOrderStatus(orderId));
  const { data, error } = await supabase.from('holiday_card_orders').select(ORDER_STATUS_COLUMNS).eq('id', orderId).maybeSingle();
  if (error) {
    const expired = /jwt|token/i.test(error.message);
    throw new CardApiError(expired ? 401 : 0, expired ? 'unauthorized' : 'network_error', error.message);
  }
  if (!data) throw new CardApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
  return parseOrderRow(data);
}
