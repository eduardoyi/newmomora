import { formatMoney } from '../../order/formatMoney';
import type { OrderListItem } from '../../order/orderListItems';
import { cardOrderStatusCopy, isCardOrderListTerminal } from './cardOrderStatusCopy';
import type { CardOrderStatusName } from './checkoutTypes';

/** The pure half of the card orders list (no Supabase: unit-testable in node). */

export interface CardOrderListRow {
  id: string;
  card_id: string | null;
  status: string;
  packs: number | null;
  price_cents: number | null;
  currency: string | null;
  refunded_at: string | null;
  created_at: string;
  /** The embedded card (`holiday_cards(year)`); null when the card is deleted or hidden. */
  card?: { year: number } | { year: number }[] | null;
}

const KNOWN: readonly string[] = ['draft', 'quoted', 'checkout', 'paid', 'rendering', 'submitted', 'in_production', 'shipped', 'failed', 'cancelled'];

/** The card's year; a deleted card (no embed) falls back to the year the order was placed. */
export function cardYear(order: Pick<CardOrderListRow, 'card' | 'created_at'>): number {
  const card = Array.isArray(order.card) ? order.card[0] : order.card;
  if (card && Number.isInteger(card.year)) return card.year;
  return new Date(order.created_at).getFullYear();
}

/** The holiday card adapter for the shared list row. */
export function cardOrderItem(order: CardOrderListRow): OrderListItem {
  const status = (KNOWN.includes(order.status) ? order.status : 'unknown') as CardOrderStatusName | 'unknown';
  const copy = cardOrderStatusCopy(status, { refunded: order.refunded_at !== null });
  return {
    kind: 'card',
    id: order.id,
    title: `Holiday cards ${cardYear(order)}`,
    detail: order.packs ? `${order.packs * 10} cards` : null,
    createdAt: order.created_at,
    chip: { label: copy.label, tone: copy.tone },
    total: order.price_cents !== null ? formatMoney(order.price_cents, order.currency ?? 'USD') : null,
    refunded: order.refunded_at !== null,
    terminal: isCardOrderListTerminal(order.status),
    cardId: order.card_id,
  };
}

/**
 * Maps raw table rows to list items, skipping any row that is malformed (not an
 * object, no id / created_at, a throw while mapping): one bad row never rejects
 * the whole list.
 */
export function safeCardOrderItems(rows: unknown): OrderListItem[] {
  if (!Array.isArray(rows)) return [];
  const items: OrderListItem[] = [];
  for (const row of rows) {
    try {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Partial<CardOrderListRow>;
      if (typeof r.id !== 'string' || typeof r.created_at !== 'string' || Number.isNaN(Date.parse(r.created_at)) || typeof r.status !== 'string') continue;
      items.push(
        cardOrderItem({
          id: r.id,
          card_id: typeof r.card_id === 'string' ? r.card_id : null,
          status: r.status,
          packs: typeof r.packs === 'number' ? r.packs : null,
          price_cents: typeof r.price_cents === 'number' ? r.price_cents : null,
          currency: typeof r.currency === 'string' ? r.currency : null,
          refunded_at: typeof r.refunded_at === 'string' ? r.refunded_at : null,
          created_at: r.created_at,
          card: r.card ?? null,
        }),
      );
    } catch {
      // Skip the row.
    }
  }
  return items;
}
