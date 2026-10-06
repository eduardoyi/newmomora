import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryBookOrderRow } from '../../types';

/**
 * The Memory Book order screens render byte-for-byte the same after their
 * shared pieces were extracted for the holiday card flow (owner requirement:
 * "no visual change for books"). The snapshots in `__snapshots__/` were
 * captured from the screens BEFORE the extraction; a change to them is a
 * change to the book experience and must be deliberate.
 */

const state = vi.hoisted(() => ({ order: null as unknown }));

vi.mock('../useOrderStatus', () => ({
  useOrderStatus: () => ({ loading: false, error: null, order: state.order, reload: () => {} }),
}));
vi.mock('../ordersApi', () => ({
  createOrderDraft: () => new Promise(() => {}),
  quoteOrder: () => new Promise(() => {}),
  createCheckoutSession: () => new Promise(() => {}),
}));

import { CheckoutScreen } from '../CheckoutScreen';
import { OrderStatusScreen } from '../OrderStatusScreen';

function bookOrder(overrides: Partial<MemoryBookOrderRow> = {}): MemoryBookOrderRow {
  return {
    id: 'order-1',
    book_id: 'book-1',
    status: 'paid',
    price_cents: 5900,
    shipping_cost_cents: 1250,
    currency: 'usd',
    quoted_page_count: 48,
    prodigi_order_id: null,
    failure_reason: null,
    refunded_at: null,
    shipping_address: { name: 'Lucía Rivera', line1: '1 Example Street', city: 'Springfield', state: 'IL', postalCode: '62701', countryCode: 'US' },
    tracking_number: null,
    tracking_url: null,
    carrier: null,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

const noop = () => {};

function renderStatus(order: MemoryBookOrderRow, search = ''): string {
  state.order = order;
  (globalThis as unknown as { window: unknown }).window = { location: { search } };
  return renderToStaticMarkup(createElement(OrderStatusScreen, { orderId: order.id, onBackToBook: noop }));
}

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { location: { search: '' } };
});
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('book OrderStatusScreen output', () => {
  const cases: [string, Partial<MemoryBookOrderRow>, string][] = [
    ['quoted', { status: 'quoted' }, ''],
    ['paid, just returned from Stripe', { status: 'paid' }, '?checkout=success'],
    ['rendering', { status: 'rendering' }, ''],
    ['in production', { status: 'in_production' }, ''],
    ['shipped with a tracking link', { status: 'shipped', tracking_url: 'https://t.example.test/1', tracking_number: 'ZZ1', carrier: 'UPS' }, ''],
    ['shipped with a bare tracking number', { status: 'shipped', tracking_number: 'ZZ1', carrier: 'UPS' }, ''],
    ['delivered', { status: 'delivered' }, ''],
    ['failed', { status: 'failed' }, ''],
    ['cancelled before payment', { status: 'cancelled' }, ''],
    ['cancelled and refunded', { status: 'cancelled', refunded_at: '2026-10-03T12:00:00.000Z' }, ''],
    ['shipped without an address', { status: 'shipped', shipping_address: null }, ''],
  ];
  for (const [name, overrides, search] of cases) {
    it(name, () => {
      expect(renderStatus(bookOrder(overrides), search)).toMatchSnapshot();
    });
  }
});

describe('book CheckoutScreen output', () => {
  it('the first render (the order is being started)', () => {
    const html = renderToStaticMarkup(createElement(CheckoutScreen, { bookId: 'book-1', bookLabel: 'Lía — 2026', onBack: noop, onOrderPlaced: noop }));
    expect(html).toMatchSnapshot();
  });
});
