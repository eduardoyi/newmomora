import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cardOrderItem } from '../../card/checkout/cardOrderItems';
import { bookOrderItem, mergeOrderItems } from '../orderListItems';
import { CheckoutFrame, CheckoutQuote } from '../CheckoutShell';
import { OrderProgressStepper } from '../OrderProgressStepper';
import { CARD_STEPPER } from '../../card/checkout/cardProgress';
import { AddressForm } from '../AddressForm';

const state = vi.hoisted(() => ({ orders: [] as unknown[] | null, error: null as string | null }));
vi.mock('../useOrders', () => ({ useOrders: () => ({ loading: false, error: state.error, orders: state.orders, reload: () => {} }) }));

import { cardStatusPath, orderRowLabel, OrdersListScreen } from '../OrdersListScreen';
import { OrderStatusError } from '../OrderStatusError';
import { friendlyLoadError, ORDER_LOAD_ERROR, ORDER_NOT_FOUND_ERROR, ORDERS_LOAD_ERROR } from '../loadErrors';
import { statusErrorMessage } from '../../card/checkout/cardOrderStatusCopy';

const noop = () => {};

describe('book rendering through the shared pieces is the original markup', () => {
  it('the quote card (hand-written from the book checkout\'s original JSX)', () => {
    const html = renderToStaticMarkup(
      createElement(CheckoutQuote, {
        lines: [
          { label: 'Book', value: '$59.00' },
          { label: 'Shipping', value: '$12.50' },
        ],
        total: '$71.50',
        taxNote: 'Tax, if applicable, is calculated at checkout.',
        error: null,
        payLabel: 'Continue to payment',
        paying: false,
        onPay: noop,
      }),
    );
    expect(html).toBe(
      '<div class="checkout-quote"><dl class="checkout-quote__lines"><dt>Book</dt><dd>$59.00</dd><dt>Shipping</dt><dd>$12.50</dd><dt class="checkout-quote__total-label">Total</dt><dd class="checkout-quote__total-value">$71.50</dd></dl><p class="checkout-quote__tax-note">Tax, if applicable, is calculated at checkout.</p><button type="button" class="checkout-quote__pay">Continue to payment</button></div>',
    );
  });

  it('a paying quote disables the pay button; the frame omits an absent notice', () => {
    const paying = renderToStaticMarkup(
      createElement(CheckoutQuote, { lines: [], total: '$1.00', taxNote: 't', error: null, payLabel: 'Redirecting to checkout…', paying: true, onPay: noop }),
    );
    expect(paying).toContain('<button type="button" class="checkout-quote__pay" disabled="">Redirecting to checkout…</button>');
    const frame = renderToStaticMarkup(createElement(CheckoutFrame, { title: 'T', backLabel: 'B', onBack: noop, children: 'body' }));
    // The title is a real <h1> (the only deliberate markup change to the book checkout).
    expect(frame).toBe('<div class="checkout-screen"><header class="checkout-screen__header"><button type="button" class="checkout-screen__back">← B</button><h1 class="checkout-screen__title">T</h1></header><div class="checkout-screen__body">body</div></div>');
  });

  it('the book stepper (default config) still draws its six steps', () => {
    const html = renderToStaticMarkup(createElement(OrderProgressStepper, { status: 'in_production' }));
    expect([...html.matchAll(/order-progress__label">([^<]+)</g)].map((m) => m[1])).toEqual(['Paid', 'Preparing', 'Sent to print', 'Printing', 'Shipped', 'Delivered']);
    expect(html).toContain('Printing</span><span class="order-progress__hint">4–6 days');
  });

  it('the book address form keeps its markup (state is free text, city optional)', () => {
    expect(renderToStaticMarkup(createElement(AddressForm, { submitting: false, onSubmit: noop }))).toMatchSnapshot();
  });
});

describe('the card stepper draws through the same component', () => {
  const labels = (html: string) => [...html.matchAll(/order-progress__label">([^<]+)</g)].map((m) => m[1]);

  it('right after payment: Paid done, Preparing current (with its hint)', () => {
    const html = renderToStaticMarkup(createElement(OrderProgressStepper, { status: 'paid', config: CARD_STEPPER }));
    expect(labels(html)).toEqual(['Paid', 'Preparing', 'Sent to print', 'Printing', 'Shipped']);
    expect(html.match(/order-progress__step--done/g)).toHaveLength(1);
    expect(html.match(/order-progress__step--current/g)).toHaveLength(1);
    expect(html).toContain('Preparing</span><span class="order-progress__hint">just a few minutes');
    expect(html).toContain('aria-current="step"');
  });

  it('submitted is Sent to print; shipped is complete', () => {
    const submitted = renderToStaticMarkup(createElement(OrderProgressStepper, { status: 'submitted', config: CARD_STEPPER }));
    expect(submitted.match(/order-progress__step--done/g)).toHaveLength(2);
    const shipped = renderToStaticMarkup(createElement(OrderProgressStepper, { status: 'shipped', config: CARD_STEPPER }));
    expect(shipped).not.toContain('order-progress__step--current');
    expect(shipped.match(/order-progress__step--done/g)).toHaveLength(5);
  });
});

describe('the orders list shows books and holiday cards together', () => {
  const book = bookOrderItem({
    id: 'b1', book_id: 'bk', status: 'shipped', price_cents: 5900, shipping_cost_cents: 1250, currency: 'usd', refunded_at: null,
    created_at: '2026-10-01T12:00:00.000Z', book_title: 'Lía — 2026',
  });
  const card = cardOrderItem({ id: 'c1', card_id: 'card-1', status: 'paid', packs: 3, price_cents: 7470, currency: 'USD', refunded_at: null, created_at: '2026-10-02T12:00:00.000Z', card: { year: 2026 } });
  const render = () => renderToStaticMarkup(createElement(OrdersListScreen, { onOpenOrder: noop, onOpenCardOrder: noop }));

  it('renders newest first, with a real h1 (the shared header is the one top bar, not this screen) and an accessible name per row', () => {
    state.orders = mergeOrderItems([book], [card]);
    state.error = null;
    const html = render();
    expect(html).toContain('<h1 class="orders-list__title">Your orders</h1>');
    expect(html).not.toContain('← Home'); // the shared ShopHeader carries it
    expect(html).not.toContain('<header');
    expect(html).not.toContain('Your books');
    expect(html.indexOf('Holiday cards 2026')).toBeGreaterThan(-1);
    expect(html.indexOf('Holiday cards 2026')).toBeLessThan(html.indexOf('Lía — 2026'));
    expect(html).toContain('<span class="order-status-chip order-status-chip--positive">Shipped</span><span class="orders-list__item-total">$71.50</span>');
    expect(html).toContain('<span class="order-status-chip order-status-chip--positive">Payment received</span><span class="orders-list__item-total">$74.70</span>');
    expect(html).toContain('· 30 cards');
    expect(html).toContain('aria-label="Holiday cards 2026, 30 cards, ');
    expect(html).toContain('Payment received, $74.70"');
  });

  it('never renders a disabled row, even for a card that was deleted', () => {
    state.orders = [cardOrderItem({ id: 'c2', card_id: null, card: null, status: 'shipped', packs: 2, price_cents: 4980, currency: 'USD', refunded_at: null, created_at: '2026-10-02T12:00:00.000Z' })];
    state.error = null;
    const html = render();
    expect(html).not.toContain('disabled');
    expect(html).toContain('Holiday cards 2026');
  });

  it('empty state and error state use friendly copy with a retry', () => {
    state.orders = [];
    state.error = null;
    expect(render()).toContain("No orders yet. When you order a Memory Book or holiday cards, they&#x27;ll show up here so you can track them.");
    state.orders = null;
    state.error = ORDERS_LOAD_ERROR;
    const html = render();
    expect(html).toContain("We couldn&#x27;t load your orders. Check your connection and try again.");
    expect(html).toContain('Try again');
  });
});

describe('opening a card order', () => {
  it('a card whose page is gone opens on its own at /order/<id>?kind=card', () => {
    expect(cardStatusPath('order-1')).toBe('/order/order-1?kind=card');
    expect(cardStatusPath('a b')).toBe('/order/a%20b?kind=card');
  });
  it('a row\'s accessible name says what, when, status and total', () => {
    const item = cardOrderItem({ id: 'c', card_id: null, card: null, status: 'shipped', packs: 3, price_cents: 7470, currency: 'USD', refunded_at: '2026-10-03T12:00:00Z', created_at: '2026-10-02T12:00:00.000Z' });
    const label = orderRowLabel(item);
    expect(label.startsWith('Holiday cards 2026, 30 cards, ')).toBe(true);
    expect(label.endsWith('Shipped, $74.70, Refunded')).toBe(true);
  });
});

describe('status pages', () => {
  it('the error page is the same for both products: message, Try again, Your orders', () => {
    const html = renderToStaticMarkup(createElement(OrderStatusError, { onRetry: noop, onOpenOrders: noop }));
    expect(html).toContain('<h1 class="order-status__sr-only">Order status</h1>');
    expect(html).toContain("We couldn&#x27;t load this order. Check your connection and try again.");
    expect(html).toContain('>Try again</button>');
    expect(html).toContain('>Your orders</button>');
  });
});

describe('friendly errors', () => {
  it('never pass a raw message through, and log it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(friendlyLoadError({ message: 'JWT expired' }, ORDERS_LOAD_ERROR, 'orders list')).toBe(ORDERS_LOAD_ERROR);
    expect(friendlyLoadError(new Error('TypeError: Failed to fetch'), ORDER_LOAD_ERROR, 'order status')).not.toContain('fetch');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0])).toContain('JWT expired');
    spy.mockRestore();
  });

  it('a card status read maps to friendly copy by code', () => {
    expect(statusErrorMessage({ code: 'ORDER_NOT_FOUND', message: 'x', action: 'back_to_editor' })).toBe(ORDER_NOT_FOUND_ERROR);
    expect(statusErrorMessage({ code: 'network_error', message: 'Could not reach Supabase 500', action: 'retry' })).toBe(ORDER_LOAD_ERROR);
    expect(statusErrorMessage({ code: 'unauthorized', message: 'Your sign-in has ended. Reload the page to sign in again.', action: 'reload' })).toMatch(/sign-in/);
    expect(statusErrorMessage(null)).toBe(ORDER_LOAD_ERROR);
  });
});
