import { useState } from 'react';
import { useOrderStatus } from './useOrderStatus';
import { orderStatusCopy } from './orderStatusCopy';
import { useDocumentTitle } from '../useDocumentTitle';
import {
  getFixtureSlug,
  fixtureOrderJumpStates,
  fixtureSetOrderStatus,
  fixtureToggleOrderRefunded,
} from '../dev/fixture';
import type { MemoryBookOrderStatus } from '../types';
import './OrderStatusScreen.css';

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

/**
 * `/order/<id>` (memory-book-5c plan Step 6, Design Decision 5) — Stripe
 * Checkout's own `success_url` return target, and the page a buyer's order
 * confirmation email should eventually link to. Reads via
 * `useOrderStatus.ts` (a direct RLS-scoped SELECT), shows honest per-status
 * copy (`orderStatusCopy.ts` — includes the task's exact required `failed`
 * wording), and polls while the order isn't done changing on its own.
 */
export function OrderStatusScreen({ orderId, onBackToBook }: { orderId: string; onBackToBook: (bookId: string) => void }) {
  const { loading, error, order, reload } = useOrderStatus(orderId);
  useDocumentTitle(order ? `Order status · Momora` : null);

  // Stripe's success_url carries `?checkout=success` — a one-time "thanks"
  // banner on first arrival, purely cosmetic (the real state of record is
  // always `order.status`/`orderStatusCopy`, never this query param).
  const [showThanks] = useState(() => new URLSearchParams(window.location.search).get('checkout') === 'success');

  if (loading) {
    return (
      <div className="order-status order-status--center">
        <p className="order-status__hint">Loading your order…</p>
      </div>
    );
  }
  if (error || !order) {
    return (
      <div className="order-status order-status--center">
        <p className="order-status__error">{error ?? 'Order not found.'}</p>
      </div>
    );
  }

  const copy = orderStatusCopy(order.status);

  return (
    <div className="order-status">
      <header className="order-status__header">
        <button type="button" className="order-status__back" onClick={() => onBackToBook(order.book_id)}>
          ← Your book
        </button>
        <span className="order-status__title">Order status</span>
      </header>

      <div className="order-status__body">
        {showThanks && order.status !== 'draft' && order.status !== 'quoted' && (
          <div className="order-status__thanks" role="status">
            Thanks for your order! We'll keep this page updated as it moves through printing and shipping.
          </div>
        )}

        <span className={`order-status-chip order-status-chip--${copy.tone}`}>{copy.label}</span>
        <p className="order-status__message">{copy.message}</p>

        {order.refunded_at && (
          <p className="order-status__refunded" role="status">
            A refund was issued on {new Date(order.refunded_at).toLocaleDateString()}.
          </p>
        )}

        <dl className="order-status__facts">
          {order.price_cents !== null && order.shipping_cost_cents !== null && (
            <>
              <dt>Book</dt>
              <dd>{formatMoney(order.price_cents, order.currency)}</dd>
              <dt>Shipping</dt>
              <dd>{formatMoney(order.shipping_cost_cents, order.currency)}</dd>
              <dt>Total</dt>
              <dd>{formatMoney(order.price_cents + order.shipping_cost_cents, order.currency)} (plus tax, if applicable)</dd>
            </>
          )}
          {order.quoted_page_count !== null && (
            <>
              <dt>Pages</dt>
              <dd>{order.quoted_page_count}</dd>
            </>
          )}
        </dl>

        {(order.status === 'draft' || order.status === 'quoted') && (
          <button type="button" className="order-status__resume" onClick={() => onBackToBook(order.book_id)}>
            Back to your book
          </button>
        )}
      </div>

      {import.meta.env.DEV && getFixtureSlug() && (
        <FixtureOrderControls
          orderId={orderId}
          currentStatus={order.status}
          refunded={Boolean(order.refunded_at)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

/**
 * DEV-ONLY fixture "state switcher" (task brief: "mock a state switcher or
 * sequential progression") — lets the interactive walkthrough jump this
 * order to any of `orderStatusCopy.ts`'s ten statuses and toggle
 * `refunded_at`, without a render worker, Prodigi, or a cron sweep to drive
 * real progression. Gated on `getFixtureSlug()` the same way every other
 * fixture affordance in this app is, so it is dead code (and never rendered)
 * in a production build — see `dev/fixture.ts`'s header comment for the
 * tree-shaking contract `check-web-bundle.mjs` verifies.
 */
function FixtureOrderControls({
  orderId,
  currentStatus,
  refunded,
  onChanged,
}: {
  orderId: string;
  currentStatus: MemoryBookOrderStatus;
  refunded: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="order-status__fixture-controls">
      <span className="order-status__fixture-label">Fixture mode — jump order state</span>
      <select
        className="order-status__fixture-select"
        value={currentStatus}
        onChange={(e) => {
          fixtureSetOrderStatus(orderId, e.target.value as MemoryBookOrderStatus);
          onChanged();
        }}
      >
        {fixtureOrderJumpStates().map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="order-status__fixture-btn"
        onClick={() => {
          fixtureToggleOrderRefunded(orderId);
          onChanged();
        }}
      >
        {refunded ? 'Clear refund' : 'Mark refunded'}
      </button>
    </div>
  );
}
