import { useOrders } from './useOrders';
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
export function OrdersListScreen({
  onOpenOrder,
  onOpenCardOrder,
  onBack,
}: {
  /** A Memory Book order's status page. */
  onOpenOrder: (orderId: string) => void;
  /** A holiday card order: the card page opens on that order's status. Rows for cards are inert without it. */
  onOpenCardOrder?: (cardId: string, orderId: string) => void;
  onBack: () => void;
}) {
  useDocumentTitle('Your orders · Momora');
  const { loading, error, orders } = useOrders();

  return (
    <div className="orders-list">
      <header className="orders-list__header">
        <button type="button" className="orders-list__back" onClick={onBack}>
          ← Your books
        </button>
        <span className="orders-list__title">Your orders</span>
      </header>

      <div className="orders-list__body">
        {loading && <p className="orders-list__hint">Loading your orders…</p>}
        {error && <p className="orders-list__error">{error}</p>}

        {!loading && !error && (orders?.length ?? 0) === 0 && (
          <p className="orders-list__hint">
            No orders yet — once you order a printed Memory Book, it'll show up here so you can track it.
          </p>
        )}

        {!loading && !error && (orders?.length ?? 0) > 0 && (
          <ul className="orders-list__items">
            {(orders ?? []).map((order) => {
              const open =
                order.kind === 'card'
                  ? order.cardId && onOpenCardOrder
                    ? () => onOpenCardOrder(order.cardId as string, order.id)
                    : undefined
                  : () => onOpenOrder(order.id);
              return (
                <li key={`${order.kind}:${order.id}`}>
                  <button type="button" className="orders-list__item" onClick={open} disabled={!open}>
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
