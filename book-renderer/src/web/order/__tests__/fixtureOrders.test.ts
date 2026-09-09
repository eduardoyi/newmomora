import { describe, expect, it } from 'vitest';
import {
  fixtureCreateOrderDraft,
  fixtureQuoteOrder,
  fixtureCreateCheckout,
  fixtureGetOrder,
  fixtureOrderRow,
  fixtureSetOrderStatus,
  fixtureToggleOrderRefunded,
  fixtureOrderJumpStates,
  fixtureListOrders,
  fixtureHasOrders,
} from '../../dev/fixture';

/**
 * Exercises the DEV-ONLY fixture order mocks (`dev/fixture.ts`, memory-book-
 * 5c plan Step 6) end to end: draft → quote → pay → state-switcher
 * progression → refund toggle. This is the same lifecycle the interactive
 * browser walkthrough drives through `CheckoutScreen`/`OrderStatusScreen`;
 * covering it here catches a regression in the mock logic itself without a
 * browser. Runs under vitest's `environment: 'node'` (no `window`/
 * `sessionStorage`) — the in-memory `ordersStore()` cache is what makes that
 * possible (see that function's own doc comment).
 */
describe('fixture order lifecycle', () => {
  it('create_draft -> quote -> create_checkout -> paid, then every state-switcher jump', () => {
    const { orderId } = fixtureCreateOrderDraft('enzo-year-one');
    expect(fixtureGetOrder(orderId)?.status).toBe('draft');

    const quote = fixtureQuoteOrder(orderId, {
      name: 'Test Parent',
      line1: '123 Main St',
      postalCode: '12345',
      countryCode: 'US',
    });
    if ('error' in quote) throw new Error(`unexpected error: ${quote.error}`);
    expect(quote.status).toBe('quoted');
    expect(quote.totalCents).toBe(quote.priceCents + quote.shippingCostCents);
    expect(fixtureGetOrder(orderId)?.status).toBe('quoted');
    expect(fixtureGetOrder(orderId)?.shippingAddress?.countryCode).toBe('US');

    const checkout = fixtureCreateCheckout(orderId);
    if ('error' in checkout) throw new Error(`unexpected error: ${checkout.error}`);
    expect(fixtureGetOrder(orderId)?.status).toBe('paid');

    // Every one of orderStatusCopy.ts's ten states is reachable via the jump
    // switcher, and the row shape stays consistent (`fixtureOrderRow`).
    for (const status of fixtureOrderJumpStates()) {
      fixtureSetOrderStatus(orderId, status);
      const order = fixtureGetOrder(orderId);
      expect(order?.status).toBe(status);
      const row = fixtureOrderRow(order!);
      expect(row.id).toBe(orderId);
      expect(row.book_id).toBe('enzo-year-one');
    }

    // submitted (and later) carries a fake prodigi_order_id; failed carries a
    // fake failure_reason -- mirrors what the real workflow/sweep would have
    // already set by the time a buyer could see that status.
    fixtureSetOrderStatus(orderId, 'submitted');
    expect(fixtureGetOrder(orderId)?.prodigiOrderId).toBeTruthy();
    // order-status UX round, item 3: shipped/delivered carry fake tracking;
    // every other status (submitted included) does not.
    expect(fixtureGetOrder(orderId)?.trackingNumber).toBeNull();
    fixtureSetOrderStatus(orderId, 'shipped');
    expect(fixtureGetOrder(orderId)?.trackingNumber).toBeTruthy();
    expect(fixtureGetOrder(orderId)?.trackingUrl).toBeTruthy();
    expect(fixtureGetOrder(orderId)?.carrier).toBeTruthy();
    fixtureSetOrderStatus(orderId, 'delivered');
    expect(fixtureGetOrder(orderId)?.trackingNumber).toBeTruthy();
    fixtureSetOrderStatus(orderId, 'failed');
    expect(fixtureGetOrder(orderId)?.failureReason).toBeTruthy();
    expect(fixtureGetOrder(orderId)?.prodigiOrderId).toBeNull();
    expect(fixtureGetOrder(orderId)?.trackingNumber).toBeNull();

    // refunded_at is independent of status (docs/features/memory-book-
    // orders.md#refund-recording) -- toggling it never touches `status`.
    expect(fixtureGetOrder(orderId)?.refundedAt).toBeNull();
    fixtureToggleOrderRefunded(orderId);
    expect(fixtureGetOrder(orderId)?.refundedAt).toBeTruthy();
    expect(fixtureGetOrder(orderId)?.status).toBe('failed');
    fixtureToggleOrderRefunded(orderId);
    expect(fixtureGetOrder(orderId)?.refundedAt).toBeNull();
  });

  it('quote fails against an unknown order id', () => {
    const result = fixtureQuoteOrder('does-not-exist', {
      name: 'X',
      line1: 'Y',
      postalCode: 'Z',
      countryCode: 'US',
    });
    expect('error' in result).toBe(true);
  });

  it('create_checkout refuses an order that has not been quoted', () => {
    const { orderId } = fixtureCreateOrderDraft('enzo-year-one');
    const result = fixtureCreateCheckout(orderId);
    expect('error' in result).toBe(true);
  });
});

/**
 * order-status UX round, item 2 -- `fixtureListOrders`/`fixtureHasOrders`
 * back `OrdersListScreen`/`useHasPastOrders` under `?fixture=` mode. Not
 * gated behind `registerFixtureBookLabel` here (that's only ever called by
 * `loadFixtureBook`, which this file never exercises) -- so `book_title`
 * falls back to the bare book id, exactly as `fixtureBookLabel`'s own doc
 * comment says it should when a book hasn't loaded in this session yet.
 */
describe('fixture orders list', () => {
  // NOTE: `ordersStore()` is a module-level singleton (by design -- see its
  // own doc comment), shared across every test in this file. These
  // assertions are therefore written relative to a fresh baseline taken at
  // the start of each test, never against an assumed-empty store -- earlier
  // describe blocks in this same file have already created orders by the
  // time these run.
  it('fixtureHasOrders is true once at least one draft exists', () => {
    fixtureCreateOrderDraft('enzo-year-one');
    expect(fixtureHasOrders()).toBe(true);
  });

  it('lists every order across books, newest first, with a fallback title', () => {
    const baselineIds = new Set(fixtureListOrders().map((r) => r.id));
    const first = fixtureCreateOrderDraft('enzo-year-one');
    const second = fixtureCreateOrderDraft('enzo-year-one');

    const rows = fixtureListOrders();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(first.orderId);
    expect(ids).toContain(second.orderId);
    expect(rows.length).toBe(baselineIds.size + 2);
    // `createdAt` for both orders is `Date.now()` at creation time, which can
    // tie at millisecond resolution in a fast test run -- assert ordering is
    // non-decreasing by `created_at` rather than assuming a strict tie-break.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].created_at >= rows[i].created_at).toBe(true);
    }
    for (const row of rows) {
      expect(row.book_title).toBe('enzo-year-one');
      expect(row.book_id).toBe('enzo-year-one');
    }
  });
});
