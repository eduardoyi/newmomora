import { ORDER_LOAD_ERROR } from './loadErrors';
import './OrderStatusScreen.css';

/**
 * The status page's "could not load" state, one component for both products
 * (Memory Book and holiday card): the message, then [Try again] [Your orders].
 */
export function OrderStatusError({
  message = ORDER_LOAD_ERROR,
  onRetry,
  onOpenOrders,
}: {
  message?: string;
  onRetry: () => void;
  onOpenOrders: () => void;
}) {
  return (
    <div className="order-status order-status--center">
      <h1 className="order-status__sr-only">Order status</h1>
      <p className="order-status__error" role="alert">
        {message}
      </p>
      <div className="order-status__error-actions">
        <button type="button" className="order-status__resume" onClick={onRetry}>
          Try again
        </button>
        <button type="button" className="order-status__secondary" onClick={onOpenOrders}>
          Your orders
        </button>
      </div>
    </div>
  );
}

/** The default way to the orders list when the host app gives no handler (a plain page load: always works). */
export function goToOrders(): void {
  window.location.assign('/orders');
}
