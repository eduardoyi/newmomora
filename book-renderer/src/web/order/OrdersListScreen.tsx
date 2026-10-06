import { useOrders } from './useOrders';
import type { OrderListItem } from './orderListItems';
import { useDocumentTitle } from '../useDocumentTitle';
// Reuses `.order-status-chip*` from OrderStatusScreen.css rather than
// redefining the same tone→color mapping a second time — the two screens
// share the exact same status vocabulary (`orderStatusCopy.ts`).
import './OrderStatusScreen.css';
import './OrdersListScreen.css';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * `/orders` (memory-book-5c order-status UX round, item 2) — the buyer's
 * own order history, RLS-scoped to them the same way `OrderStatusScreen`
 * is (see `useOrders.ts`'s header comment). Reached from a quiet "Your
 * orders" link in `BookListScreen`'s header (always visible) and from
 * `BookViewScreen` near "Order this book" (only once `useHasPastOrders`
 * confirms the buyer actually has one).
 */
/** The path a card order opens on its own (no card page to show it on): the order route with `?kind=card`. */
export function cardStatusPath(orderId: string): string {
  return `/order/${encodeURIComponent(orderId)}?kind=card`;
}

/** The accessible name of a row: what it is, when, its status and total. */
export function orderRowLabel(order: Pick<OrderListItem, 'title' | 'detail' | 'createdAt' | 'chip' | 'total' | 'refunded'>): string {
  return [order.title, order.detail, formatDate(order.createdAt), order.chip.label, order.total, order.refunded ? 'Refunded' : null].filter(Boolean).join(', ');
}

export function OrdersListScreen({
  onOpenOrder,
  onOpenCardOrder,
  onOpenCardStatus,
}: {
  /** A Memory Book order's status page. */
  onOpenOrder: (orderId: string) => void;
  /** A holiday card order whose card still exists: the card page opens on that order's status. */
  onOpenCardOrder?: (cardId: string, orderId: string) => void;
  /** A card order opened on its own (its card was deleted, or no card handler): `/order/<id>?kind=card`. Omitted = a plain page load of that path. */
  onOpenCardStatus?: (orderId: string) => void;
}) {
  useDocumentTitle('Your orders · Momora');
  const { loading, error, orders, reload } = useOrders();

  return (
    <div className="orders-list">
      {/* The page's one top bar is the shared ShopHeader, rendered by the host. */}
      <div className="orders-list__body">
        <h1 className="orders-list__title">Your orders</h1>
        {loading && <p className="orders-list__hint">Loading your orders…</p>}
        {error && (
          <>
            <p className="orders-list__error" role="alert">
              {error}
            </p>
            <button type="button" className="orders-list__retry" onClick={() => void reload()}>
              Try again
            </button>
          </>
        )}

        {!loading && !error && (orders?.length ?? 0) === 0 && (
          <p className="orders-list__hint">
            No orders yet. When you order a Memory Book or holiday cards, they'll show up here so you can track them.
          </p>
        )}

        {!loading && !error && (orders?.length ?? 0) > 0 && (
          <ul className="orders-list__items">
            {(orders ?? []).map((order) => {
              // Never an inert row: a card whose page is gone still opens its status on its own.
              const open = () => {
                if (order.kind === 'book') onOpenOrder(order.id);
                else if (order.cardId && onOpenCardOrder) onOpenCardOrder(order.cardId, order.id);
                else if (onOpenCardStatus) onOpenCardStatus(order.id);
                else window.location.assign(cardStatusPath(order.id));
              };
              return (
                <li key={`${order.kind}:${order.id}`}>
                  <button type="button" className="orders-list__item" onClick={open} aria-label={orderRowLabel(order)}>
                    <div className="orders-list__item-main">
                      <span className="orders-list__item-title">{order.title}</span>
                      <span className="orders-list__item-date">
                        {formatDate(order.createdAt)}
                        {order.detail ? ` · ${order.detail}` : ''}
                      </span>
                    </div>
                    <div className="orders-list__item-meta">
                      <span className={`order-status-chip order-status-chip--${order.chip.tone}`}>{order.chip.label}</span>
                      {order.total && <span className="orders-list__item-total">{order.total}</span>}
                    </div>
                    {order.refunded && <span className="orders-list__item-refunded">Refunded</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
