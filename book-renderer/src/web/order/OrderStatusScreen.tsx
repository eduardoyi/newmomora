import { lazy, Suspense, useState } from 'react';
import { useOrderStatus } from './useOrderStatus';
import { orderStatusCopy, CANCELLED_AFTER_PAYMENT_MESSAGE, ORDER_THANKS_MESSAGE } from './orderStatusCopy';
import { formatMoney } from './formatMoney';
import { OrderStatusLayout } from './OrderStatusLayout';
import { goToOrders, OrderStatusError } from './OrderStatusError';
import { showsProgressStepper } from './orderProgressSteps';
import { OrderProgressStepper } from './OrderProgressStepper';
import { SHIPS_TO_COUNTRIES } from './shippingCountries';
import { useDocumentTitle } from '../useDocumentTitle';
import {
  getFixtureSlug,
  fixtureOrderJumpStates,
  fixtureSetOrderStatus,
  fixtureToggleOrderRefunded,
} from '../dev/fixture';
import type { MemoryBookOrderStatus } from '../types';
import './OrderStatusScreen.css';

/** Country display name for the "Ships to" block. Falls back to the bare
 * ISO code for anything not in `SHIPS_TO_COUNTRIES` — possible in theory
 * only for a historical row quoted before a country was removed from the
 * list; never worth erroring the page over. */
function shipsToCountryName(code: string): string {
  return SHIPS_TO_COUNTRIES.find((country) => country.code === code)?.name ?? code;
}

/**
 * `/order/<id>` (memory-book-5c plan Step 6, Design Decision 5) — Stripe
 * Checkout's own `success_url` return target, and the page a buyer's order
 * confirmation email should eventually link to. Reads via
 * `useOrderStatus.ts` (a direct RLS-scoped SELECT), shows honest per-status
 * copy (`orderStatusCopy.ts` — includes the task's exact required `failed`
 * wording), and polls while the order isn't done changing on its own.
 */
export function OrderStatusScreen({
  orderId,
  onBackToBook,
  onOpenOrders,
}: {
  orderId: string;
  onBackToBook: (bookId: string) => void;
  /** The orders list (`/orders`); omitted = a plain page load of it. */
  onOpenOrders?: () => void;
}) {
  // `/order/<id>?kind=card`: a holiday card order opened on its own (its card may
  // be gone, so there is no card page to show it on). Same layout, card adapter.
  if (new URLSearchParams(window.location.search).get('kind') === 'card') {
    return (
      <Suspense fallback={<LoadingOrder />}>
        <CardOrderStatusPanel orderId={orderId} returnedFromPayment={false} onBack={onOpenOrders ?? goToOrders} backLabel="← All orders" onOpenOrders={onOpenOrders} />
      </Suspense>
    );
  }
  return <BookOrderStatusScreen orderId={orderId} onBackToBook={onBackToBook} onOpenOrders={onOpenOrders} />;
}

// Lazy: the card status page (and its adapter) is only fetched for a card order.
const CardOrderStatusPanel = lazy(() => import('../card/checkout/CardOrderStatusPanel').then((m) => ({ default: m.CardOrderStatusPanel })));

function LoadingOrder() {
  return (
    <div className="order-status order-status--center">
      <h1 className="order-status__sr-only">Order status</h1>
      <p className="order-status__hint">Loading your order…</p>
    </div>
  );
}

function BookOrderStatusScreen({ orderId, onBackToBook, onOpenOrders }: { orderId: string; onBackToBook: (bookId: string) => void; onOpenOrders?: () => void }) {
  const { loading, error, order, reload } = useOrderStatus(orderId);
  useDocumentTitle(order ? `Order status · Momora` : null);

  // Stripe's success_url carries `?checkout=success` — a one-time "thanks"
  // banner on first arrival, purely cosmetic (the real state of record is
  // always `order.status`/`orderStatusCopy`, never this query param).
  const [showThanks] = useState(() => new URLSearchParams(window.location.search).get('checkout') === 'success');

  if (loading) return <LoadingOrder />;
  if (error || !order) {
    return <OrderStatusError message={error ?? undefined} onRetry={reload} onOpenOrders={onOpenOrders ?? goToOrders} />;
  }

  const copy = orderStatusCopy(order.status);
  // Post-payment cancellation reads differently from an abandoned
  // checkout — see CANCELLED_AFTER_PAYMENT_MESSAGE's comment.
  const statusMessage =
    order.status === 'cancelled' && order.refunded_at ? CANCELLED_AFTER_PAYMENT_MESSAGE : copy.message;

  return (
    <OrderStatusLayout
      backLabel="← Your book"
      onBack={() => onBackToBook(order.book_id)}
      onOpenOrders={onOpenOrders}
      thanks={showThanks && order.status !== 'draft' && order.status !== 'quoted' ? ORDER_THANKS_MESSAGE : null}
      chip={{ label: copy.label, tone: copy.tone }}
      message={statusMessage}
      refundedAt={order.refunded_at}
      // Item 1: paid→delivered progress bar. Deliberately gated on
      // `showsProgressStepper` (draft/quoted -- nothing paid yet --
      // failed/cancelled/refunded already have their own full-width
      // copy above, and a stepper next to it would read as a
      // half-filled, contradictory "still on track" bar).
      stepper={
        showsProgressStepper(order.status, order.refunded_at) ? (
          <OrderProgressStepper status={order.status} carrier={order.carrier} />
        ) : null
      }
      tracking={
        order.tracking_url || order.tracking_number
          ? { url: order.tracking_url, number: order.tracking_number, carrier: order.carrier }
          : null
      }
      facts={[
        ...(order.price_cents !== null && order.shipping_cost_cents !== null
          ? [
              { label: 'Book', value: formatMoney(order.price_cents, order.currency) },
              { label: 'Shipping', value: formatMoney(order.shipping_cost_cents, order.currency) },
              {
                label: 'Total',
                value: `${formatMoney(order.price_cents + order.shipping_cost_cents, order.currency)} (plus tax, if applicable)`,
              },
            ]
          : []),
        ...(order.quoted_page_count !== null ? [{ label: 'Pages', value: String(order.quoted_page_count) }] : []),
      ]}
      // The quoted destination, so a buyer can double-check where the
      // book is headed — half the value is the escalation line: a wrong
      // address caught fast is fixable, because the Prodigi 2h edit
      // window is deliberately KEPT on in production (owner decision
      // 2026-09-09, docs/plans/prodigi-order-spec.md). The hint only
      // shows pre-`shipped` and post-payment — once shipped it's too
      // late for a fix, and pre-payment (`quoted`) the buyer is still in
      // checkout and can simply start over.
      shipTo={
        order.shipping_address
          ? {
              ...order.shipping_address,
              countryName: shipsToCountryName(order.shipping_address.countryCode),
              hint: ['paid', 'rendering', 'submitted', 'in_production'].includes(order.status)
                ? 'Wrong address? Reply to your confirmation email right away — mistakes caught quickly can usually still be fixed.'
                : null,
            }
          : null
      }
      resume={
        order.status === 'draft' || order.status === 'quoted'
          ? { label: 'Back to your book', onClick: () => onBackToBook(order.book_id) }
          : null
      }
      // Item 4: the exit hatch -- always visible, small print, no
      // conditional gating on status. A buyer stuck anywhere in this
      // flow (including draft/quoted/failed) should always see a way
      // out that isn't "wait and hope".
      contact={
        <>
          Questions about your order? Just reply to your confirmation email or message us at{' '}
          <a href="mailto:hello@usemomora.com">hello@usemomora.com</a>.
        </>
      }
      footer={
        import.meta.env.DEV && getFixtureSlug() ? (
          <FixtureOrderControls
            orderId={orderId}
            currentStatus={order.status}
            refunded={Boolean(order.refunded_at)}
            onChanged={reload}
          />
        ) : null
      }
    />
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
