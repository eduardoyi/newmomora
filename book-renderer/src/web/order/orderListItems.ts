import type { MemoryBookOrderListRow } from '../types';
import { formatMoney } from './formatMoney';
import { isTerminalOrderStatus, orderStatusCopy } from './orderStatusCopy';

/**
 * One row of the buyer's "Your orders" list, whichever product it is for:
 * Memory Books and holiday cards are mapped onto this shape by their own
 * adapter (`bookOrderItem` here, `cardOrderItem` in
 * `card/checkout/cardOrderList.ts`) and merged newest first, so the list
 * screen stays one component with one set of classes.
 */
export interface OrderListItem {
  kind: 'book' | 'card';
  id: string;
  title: string;
  /** Shown after the date ("30 cards"); null for books (the row looks as it always did). */
  detail: string | null;
  createdAt: string;
  chip: { label: string; tone: 'positive' | 'neutral' | 'negative' };
  /** "$74.70", or null before a price is known. */
  total: string | null;
  refunded: boolean;
  /** Nothing more will change on the buyer's time scale: the list stops polling. */
  terminal: boolean;
  /** Card orders: the card the order belongs to (its page shows the status); null when the card was deleted. */
  cardId: string | null;
}

/** The Memory Book adapter: the row exactly as the list always showed it. */
export function bookOrderItem(order: MemoryBookOrderListRow): OrderListItem {
  const copy = orderStatusCopy(order.status);
  return {
    kind: 'book',
    id: order.id,
    title: order.book_title,
    detail: null,
    createdAt: order.created_at,
    chip: { label: copy.label, tone: copy.tone },
    total:
      order.price_cents !== null && order.shipping_cost_cents !== null
        ? formatMoney(order.price_cents + order.shipping_cost_cents, order.currency)
        : null,
    refunded: order.refunded_at !== null,
    terminal: isTerminalOrderStatus(order.status),
    cardId: null,
  };
}

/** Newest first across products (ties keep the order given: books before cards). */
export function mergeOrderItems(...lists: OrderListItem[][]): OrderListItem[] {
  return lists
    .flat()
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt) || a.index - b.index)
    .map(({ item }) => item);
}
