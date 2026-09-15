import { useState } from 'react';
import { useOrderStatus } from './useOrderStatus';
import { orderStatusCopy, CANCELLED_AFTER_PAYMENT_MESSAGE } from './orderStatusCopy';
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

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

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
  // Post-payment cancellation reads differently from an abandoned
  // checkout — see CANCELLED_AFTER_PAYMENT_MESSAGE's comment.
  const statusMessage =
    order.status === 'cancelled' && order.refunded_at ? CANCELLED_AFTER_PAYMENT_MESSAGE : copy.message;

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
        <p className="order-status__message">{statusMessage}</p>

        {order.refunded_at && (
          <p className="order-status__refunded" role="status">
            A refund was issued on {new Date(order.refunded_at).toLocaleDateString()}.
          </p>
        )}

        {/* Item 1: paid→delivered progress bar. Deliberately gated on
            `showsProgressStepper` (draft/quoted -- nothing paid yet --
            failed/cancelled/refunded already have their own full-width
            copy above, and a stepper next to it would read as a
            half-filled, contradictory "still on track" bar). */}
        {showsProgressStepper(order.status, order.refunded_at) && (
          <OrderProgressStepper status={order.status} carrier={order.carrier} />
        )}

        {/* Item 3: a prominent tracking CTA once the sweep has persisted
            something to show -- a real button when Prodigi gave a URL,
            a plain (non-clickable) number when it only gave that. Shown
            regardless of the exact status (`shipped` and later) so it
            keeps working after `delivered` too. */}
        {(order.tracking_url || order.tracking_number) && (
          <div className="order-status__tracking">
            {order.tracking_url ? (
              <a
                className="order-status__tracking-btn"
                href={order.tracking_url}
                target="_blank"
                rel="noreferrer noopener"
              >
                Track your package
              </a>
            ) : (
              <p className="order-status__tracking-plain">
                Tracking number: <span>{order.tracking_number}</span>
                {order.carrier ? ` (${order.carrier})` : ''}
              </p>
            )}
          </div>
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

        {/* The quoted destination, so a buyer can double-check where the
            book is headed — half the value is the escalation line: a wrong
            address caught fast is fixable, because the Prodigi 2h edit
            window is deliberately KEPT on in production (owner decision
            2026-09-09, docs/plans/prodigi-order-spec.md). The hint only
            shows pre-`shipped` and post-payment — once shipped it's too
            late for a fix, and pre-payment (`quoted`) the buyer is still in
            checkout and can simply start over. */}
        {order.shipping_address && (
          <div className="order-status__ship-to">
            <p className="order-status__ship-to-label">Ships to</p>
            <p className="order-status__ship-to-address">
              {order.shipping_address.name}
              <br />
              {order.shipping_address.line1}
              {order.shipping_address.line2 && (
                <>
                  <br />
                  {order.shipping_address.line2}
                </>
              )}
              <br />
              {[order.shipping_address.city, order.shipping_address.state, order.shipping_address.postalCode]
                .filter(Boolean)
                .join(', ')}
              <br />
              {shipsToCountryName(order.shipping_address.countryCode)}
            </p>
            {['paid', 'rendering', 'submitted', 'in_production'].includes(order.status) && (
              <p className="order-status__ship-to-hint">
                Wrong address? Reply to your confirmation email right away — mistakes caught quickly can usually still
                be fixed.
              </p>
            )}
          </div>
        )}

        {(order.status === 'draft' || order.status === 'quoted') && (
          <button type="button" className="order-status__resume" onClick={() => onBackToBook(order.book_id)}>
            Back to your book
          </button>
        )}

        {/* Item 4: the exit hatch -- always visible, small print, no
            conditional gating on status. A buyer stuck anywhere in this
            flow (including draft/quoted/failed) should always see a way
            out that isn't "wait and hope". */}
        <p className="order-status__contact-hint">
          Questions about your order? Just reply to your confirmation email or message us at{' '}
          <a href="mailto:hello@usemomora.com">hello@usemomora.com</a>.
        </p>
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
