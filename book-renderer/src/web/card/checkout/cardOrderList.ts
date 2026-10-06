import { supabase } from '../../supabaseClient';
import { safeCardOrderItems } from './cardOrderItems';
import type { OrderListItem } from '../../order/orderListItems';

/**
 * Holiday card orders for the buyer's "Your orders" list: a direct
 * `holiday_card_orders` SELECT (RLS: `requested_by = auth.uid()`, the same
 * buyer-only scope the Memory Book list relies on) of the columns the client
 * is granted. Kept apart from the card editor's modules so the shell's orders
 * screen does not pull the card editor into its chunk.
 */

// `card:holiday_cards(year)` is a to-one embed (the client has a column grant on `year`); null when RLS hides a deleted card.
export const CARD_ORDER_LIST_COLUMNS = 'id, card_id, status, packs, price_cents, currency, refunded_at, created_at, card:holiday_cards(year)';

/** The buyer's card orders, newest first, without bare draft shells (like the book list). A failed read is "none": the book list must not break over it. */
export async function fetchCardOrderItems(): Promise<OrderListItem[]> {
  const { data, error } = await supabase
    .from('holiday_card_orders')
    .select(CARD_ORDER_LIST_COLUMNS)
    .neq('status', 'draft')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('card orders list failed:', error.message);
    return [];
  }
  return safeCardOrderItems(data);
}

/** Whether the buyer has any card order worth listing (the "Your orders" link's probe). */
export async function hasCardOrders(): Promise<boolean> {
  const { data, error } = await supabase.from('holiday_card_orders').select('id').neq('status', 'draft').limit(1);
  return !error && (data?.length ?? 0) > 0;
}
