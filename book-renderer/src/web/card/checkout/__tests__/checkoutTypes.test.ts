import { describe, expect, it } from 'vitest';
import { CardApiError } from '../../cardTypes';
import {
  PACK_OPTIONS,
  formatMoney,
  isSafeCheckoutUrl,
  parseCancel,
  parseCheckout,
  parseDraft,
  parseOrderRow,
  parseOrderStatus,
  parseQuote,
  safeTrackingUrl,
} from '../checkoutTypes';

describe('packs and prices', () => {
  it('offers 10 / 20 / 30 / 50 / 100 cards, totals from the tier table', () => {
    expect(PACK_OPTIONS.map((o) => [o.packs, o.cards, o.totalCents])).toEqual([
      [1, 10, 2990],
      [2, 20, 4980],
      [3, 30, 6870],
      [5, 50, 9950],
      [10, 100, 17900],
    ]);
    expect(formatMoney(6870)).toBe('$68.70');
  });
});

describe('parsers', () => {
  it('create_draft', () => {
    expect(parseDraft({ success: true, orderId: 'order-1', status: 'draft' })).toEqual({ orderId: 'order-1' });
    expect(() => parseDraft({ success: true })).toThrow(CardApiError);
  });

  it('quote', () => {
    const q = parseQuote({ success: true, orderId: 'o', status: 'quoted', region: 'US', format: '5R', packs: 3, cards: 30, priceCents: 6870, currency: 'USD' });
    expect(q).toEqual({ orderId: 'o', packs: 3, cards: 30, priceCents: 6870, currency: 'USD', region: 'US', format: '5R' });
    expect(() => parseQuote({ orderId: 'o', packs: 4, priceCents: 1 })).toThrow(CardApiError);
    expect(() => parseQuote({ orderId: 'o', packs: 2 })).toThrow(CardApiError);
  });

  it('create_checkout accepts only an https URL (or the dev walkthrough\'s own origin)', () => {
    expect(parseCheckout({ orderId: 'o', checkoutUrl: 'https://checkout.stripe.test/c/pay/cs_1', sessionId: 's', resumed: true })).toEqual({
      orderId: 'o',
      checkoutUrl: 'https://checkout.stripe.test/c/pay/cs_1',
      resumed: true,
      expiresAt: null,
    });
    expect(parseCheckout({ orderId: 'o', checkoutUrl: 'https://checkout.stripe.test/x', expiresAt: '2026-10-07T12:35:00.000Z' }).expiresAt).toBe('2026-10-07T12:35:00.000Z');
    expect(parseCheckout({ orderId: 'o', checkoutUrl: 'https://checkout.stripe.test/x' }).expiresAt).toBeNull();
    expect(() => parseCheckout({ orderId: 'o', checkoutUrl: 'javascript:alert(1)' })).toThrow(CardApiError);
    expect(() => parseCheckout({ orderId: 'o', checkoutUrl: 'http://evil.test/pay' })).toThrow(CardApiError);
    expect(() => parseCheckout({ orderId: 'o' })).toThrow(CardApiError);
    expect(isSafeCheckoutUrl('http://localhost:5173/c/x?order=1', 'http://localhost:5173')).toBe(true);
    expect(isSafeCheckoutUrl('http://localhost:9999/c/x', 'http://localhost:5173')).toBe(false);
  });

  it('status keeps tracking and refund info, and survives a status it does not know', () => {
    const shipped = parseOrderStatus({
      orderId: 'o', cardId: 'c', status: 'shipped', packs: 2, cards: 20, priceCents: 4980, currency: 'USD', region: 'US',
      gelatoStatus: 'shipped', trackingNumber: 'ZZ1', trackingUrl: 'https://t.example.test/ZZ1', carrier: 'UPS', shippedAt: '2026-10-20T10:00:00Z', failureReason: null, refunded: false,
    });
    expect(shipped).toMatchObject({ status: 'shipped', cards: 20, trackingUrl: 'https://t.example.test/ZZ1', carrier: 'UPS', refunded: false });
    expect(parseOrderStatus({ orderId: 'o', status: 'delivered' }).status).toBe('unknown');
    expect(parseOrderStatus({ orderId: 'o', status: 'cancelled', refunded: true }).refunded).toBe(true);
    expect(() => parseOrderStatus({ status: 'paid' })).toThrow(CardApiError);
  });

  it('a tracking link is only followed when it is http(s)', () => {
    expect(safeTrackingUrl('javascript:alert(1)')).toBeNull();
    expect(safeTrackingUrl('not a url')).toBeNull();
    expect(safeTrackingUrl(null)).toBeNull();
    expect(safeTrackingUrl('https://t.example.test/1')).toBe('https://t.example.test/1');
    expect(parseOrderStatus({ orderId: 'o', status: 'shipped', trackingUrl: 'javascript:alert(1)' }).trackingUrl).toBeNull();
  });

  it('a holiday_card_orders row (the direct, buyer-only read) maps onto the same status shape', () => {
    const row = parseOrderRow({
      id: 'o', card_id: 'c', status: 'cancelled', packs: 3, price_cents: 6870, currency: 'USD', region: 'US', gelato_status: null,
      tracking_number: null, tracking_url: null, carrier: null, shipped_at: null, failure_reason: null, refunded_at: '2026-10-03T12:00:00Z',
      shipping_address: { name: 'Lucía Rivera', line1: '1 Example Street', city: 'Springfield', state: 'IL', postalCode: '62701', countryCode: 'US' },
      created_at: '2026-10-01T10:00:00Z',
    });
    expect(row).toMatchObject({ orderId: 'o', cardId: 'c', status: 'cancelled', cards: 30, priceCents: 6870, refunded: true, refundedAt: '2026-10-03T12:00:00Z', createdAt: '2026-10-01T10:00:00Z' });
    expect(row.shippingAddress).toEqual({ name: 'Lucía Rivera', line1: '1 Example Street', city: 'Springfield', state: 'IL', postalCode: '62701', countryCode: 'US' });
    expect(parseOrderRow({ id: 'o', status: 'paid', shipping_address: { name: 'x' } }).shippingAddress).toBeNull();
    expect(() => parseOrderRow(null)).toThrow(CardApiError);
  });

  it('cancel_checkout', () => {
    expect(parseCancel({ success: true, status: 'cancelled' })).toEqual({ status: 'cancelled' });
  });
});

import { shipByNoteFor } from '../checkoutCopy';
import { rawGet } from '../../__tests__/helpers';
import { parseHolidayCard } from '../../cardTypes';

describe('ship-by note', () => {
  it('comes from the server card view; absent or blank is null', () => {
    expect(parseHolidayCard(rawGet({ shipByNote: 'Order by Dec 10 for Christmas delivery in the US.' })).shipByNote).toBe('Order by Dec 10 for Christmas delivery in the US.');
    expect(parseHolidayCard(rawGet()).shipByNote).toBeNull();
    expect(parseHolidayCard(rawGet({ shipByNote: '   ' })).shipByNote).toBeNull();
  });

  it('is shown for US addresses (or an address not chosen yet) and hidden for Canada or when empty', () => {
    const note = 'Order by Dec 10 for Christmas delivery in the US.';
    expect(shipByNoteFor(note, 'US')).toBe(note);
    expect(shipByNoteFor(note, null)).toBe(note);
    expect(shipByNoteFor(note, 'CA')).toBeNull();
    expect(shipByNoteFor(null, 'US')).toBeNull();
    expect(shipByNoteFor('  ', 'US')).toBeNull();
    expect(shipByNoteFor(undefined, 'US')).toBeNull();
  });
});
