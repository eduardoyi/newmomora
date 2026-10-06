import { describe, expect, it } from 'vitest';
import { cardOrderItem, safeCardOrderItems } from '../../card/checkout/cardOrderItems';
import type { MemoryBookOrderListRow } from '../../types';
import { bookOrderItem, mergeOrderItems } from '../orderListItems';

const book = (o: Partial<MemoryBookOrderListRow> = {}): MemoryBookOrderListRow => ({
  id: 'book-order-1',
  book_id: 'book-1',
  status: 'shipped',
  price_cents: 5900,
  shipping_cost_cents: 1250,
  currency: 'usd',
  refunded_at: null,
  created_at: '2026-10-01T10:00:00.000Z',
  book_title: 'Lía — 2026',
  ...o,
});

const card = (o: Record<string, unknown> = {}) =>
  cardOrderItem({
    id: 'card-order-1',
    card_id: 'card-1',
    status: 'paid',
    packs: 3,
    price_cents: 7470,
    currency: 'USD',
    refunded_at: null,
    created_at: '2026-10-02T10:00:00.000Z',
    ...o,
  });

describe('the book adapter keeps the list row as it always was', () => {
  it('title, chip, total and refund flag', () => {
    expect(bookOrderItem(book())).toEqual({
      kind: 'book',
      id: 'book-order-1',
      title: 'Lía — 2026',
      detail: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      chip: { label: 'Shipped', tone: 'positive' },
      total: '$71.50',
      refunded: false,
      terminal: false,
      cardId: null,
    });
    expect(bookOrderItem(book({ status: 'delivered', refunded_at: '2026-10-05T10:00:00Z' }))).toMatchObject({ terminal: true, refunded: true });
    expect(bookOrderItem(book({ price_cents: null, shipping_cost_cents: null })).total).toBeNull();
  });
});

describe('the card adapter', () => {
  it('is labelled "Holiday cards" with the card count, in the book\'s status vocabulary', () => {
    expect(card()).toEqual({
      kind: 'card',
      id: 'card-order-1',
      title: 'Holiday cards',
      detail: '30 cards',
      createdAt: '2026-10-02T10:00:00.000Z',
      chip: { label: 'Payment received', tone: 'positive' },
      total: '$74.70',
      refunded: false,
      terminal: false,
      cardId: 'card-1',
    });
  });

  it('knows when to stop polling, a deleted card, a refund and a status it has not seen', () => {
    expect(card({ status: 'shipped' }).terminal).toBe(true);
    expect(card({ status: 'in_production' }).terminal).toBe(false);
    expect(card({ card_id: null }).cardId).toBeNull();
    expect(card({ status: 'cancelled', refunded_at: '2026-10-03T12:00:00Z' })).toMatchObject({ refunded: true, chip: { label: 'Cancelled' } });
    expect(card({ status: 'brand_new' }).chip.label).toBe('In progress');
    expect(card({ status: 'brand_new' }).terminal).toBe(true);
    expect(card({ packs: null, price_cents: null }).detail).toBeNull();
  });
});

describe('mergeOrderItems', () => {
  it('lists books and cards together, newest first', () => {
    const merged = mergeOrderItems(
      [bookOrderItem(book({ id: 'b-old', created_at: '2026-09-01T10:00:00Z' })), bookOrderItem(book({ id: 'b-new', created_at: '2026-10-05T10:00:00Z' }))],
      [card({ id: 'c-mid', created_at: '2026-10-02T10:00:00Z' })],
    );
    expect(merged.map((i) => `${i.kind}:${i.id}`)).toEqual(['book:b-new', 'card:c-mid', 'book:b-old']);
  });

  it('is stable for equal times (books first) and handles an empty side', () => {
    const same = '2026-10-02T10:00:00.000Z';
    expect(mergeOrderItems([bookOrderItem(book({ id: 'b', created_at: same }))], [card({ id: 'c', created_at: same })]).map((i) => i.kind)).toEqual(['book', 'card']);
    expect(mergeOrderItems([], [])).toEqual([]);
    expect(mergeOrderItems([], [card()]).map((i) => i.id)).toEqual(['card-order-1']);
  });
});

describe('safeCardOrderItems', () => {
  const good = { id: 'c1', card_id: 'card-1', status: 'paid', packs: 3, price_cents: 7470, currency: 'USD', refunded_at: null, created_at: '2026-10-02T10:00:00.000Z' };

  it('skips malformed rows and keeps the good ones', () => {
    const items = safeCardOrderItems([null, 'x', 5, {}, { ...good, id: 7 }, { ...good, created_at: 'not a date' }, { ...good, status: null }, good, { ...good, id: 'c2', packs: 'many', price_cents: '1' }]);
    expect(items.map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(items[1]).toMatchObject({ detail: null, total: null });
  });

  it('an unknown status is kept, generic, and not polled', () => {
    const [item] = safeCardOrderItems([{ ...good, status: 'brand_new' }]);
    expect(item).toMatchObject({ chip: { label: 'In progress' }, terminal: true });
  });

  it('a non-array result is an empty list', () => {
    expect(safeCardOrderItems(null)).toEqual([]);
    expect(safeCardOrderItems({ rows: [] })).toEqual([]);
  });
});
