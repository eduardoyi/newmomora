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
    fixtureSetOrderStatus(orderId, 'failed');
    expect(fixtureGetOrder(orderId)?.failureReason).toBeTruthy();
    expect(fixtureGetOrder(orderId)?.prodigiOrderId).toBeNull();

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
