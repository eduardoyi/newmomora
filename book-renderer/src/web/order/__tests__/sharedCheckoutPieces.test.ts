import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cardOrderItem } from '../../card/checkout/cardOrderItems';
import { bookOrderItem, mergeOrderItems } from '../orderListItems';
import { CheckoutFrame, CheckoutQuote } from '../CheckoutShell';
import { OrderProgressStepper } from '../OrderProgressStepper';
import { CARD_STEPPER } from '../../card/checkout/cardProgress';
import { AddressForm } from '../AddressForm';

const state = vi.hoisted(() => ({ orders: [] as unknown[] }));
vi.mock('../useOrders', () => ({ useOrders: () => ({ loading: false, error: null, orders: state.orders, reload: () => {} }) }));

import { OrdersListScreen } from '../OrdersListScreen';

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
    expect(frame).toBe('<div class="checkout-screen"><header class="checkout-screen__header"><button type="button" class="checkout-screen__back">← B</button><span class="checkout-screen__title">T</span></header><div class="checkout-screen__body">body</div></div>');
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
  const card = cardOrderItem({ id: 'c1', card_id: 'card-1', status: 'paid', packs: 3, price_cents: 7470, currency: 'USD', refunded_at: null, created_at: '2026-10-02T12:00:00.000Z' });

  it('renders newest first, with the book row exactly as before', () => {
    state.orders = mergeOrderItems([book], [card]);
    const html = renderToStaticMarkup(createElement(OrdersListScreen, { onOpenOrder: noop, onOpenCardOrder: noop, onBack: noop }));
    expect(html.indexOf('Holiday cards')).toBeGreaterThan(-1);
    expect(html.indexOf('Holiday cards')).toBeLessThan(html.indexOf('Lía — 2026'));
    expect(html).toContain(
      '<li><button type="button" class="orders-list__item"><div class="orders-list__item-main"><span class="orders-list__item-title">Lía — 2026</span><span class="orders-list__item-date">',
    );
    expect(html).toContain('<span class="order-status-chip order-status-chip--positive">Shipped</span><span class="orders-list__item-total">$71.50</span>');
    expect(html).toContain('<span class="order-status-chip order-status-chip--positive">Payment received</span><span class="orders-list__item-total">$74.70</span>');
    expect(html).toContain('· 30 cards');
  });

  it('a card row without a card to open is inert', () => {
    state.orders = [cardOrderItem({ id: 'c2', card_id: null, status: 'shipped', packs: 2, price_cents: 4980, currency: 'USD', refunded_at: null, created_at: '2026-10-02T12:00:00.000Z' })];
    const html = renderToStaticMarkup(createElement(OrdersListScreen, { onOpenOrder: noop, onOpenCardOrder: noop, onBack: noop }));
    expect(html).toContain('class="orders-list__item" disabled=""');
  });
});
