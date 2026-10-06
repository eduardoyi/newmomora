import { describe, expect, it } from 'vitest';
import { parsePath } from '../router';

describe('router parsePath', () => {
  it('keeps the existing routes unchanged', () => {
    expect(parsePath('/')).toEqual({ screen: 'list' });
    expect(parsePath('/b/enzo-year-one')).toEqual({ screen: 'book', bookId: 'enzo-year-one' });
    expect(parsePath('/b/enzo-year-one/')).toEqual({ screen: 'book', bookId: 'enzo-year-one' });
    expect(parsePath('/order/abc')).toEqual({ screen: 'order', orderId: 'abc' });
    expect(parsePath('/orders')).toEqual({ screen: 'orders' });
    expect(parsePath('/orders/')).toEqual({ screen: 'orders' });
    expect(parsePath('/nothing/here')).toEqual({ screen: 'list' });
  });

  it('routes /c/<id> to the card screen (query strings are the screen\'s business)', () => {
    const id = '3f2b8c1e-0000-4000-8000-00000000c0de';
    expect(parsePath(`/c/${id}`)).toEqual({ screen: 'card', cardId: id });
    expect(parsePath(`/c/${id}/`)).toEqual({ screen: 'card', cardId: id });
    // The router matches the pathname only (Stripe returns with ?order=&checkout=).
    expect(parsePath(new URL(`https://shop.example/c/${id}?order=o1&checkout=success`).pathname)).toEqual({ screen: 'card', cardId: id });
  });

  it('does not treat /c, /c/ or deeper paths as a card', () => {
    expect(parsePath('/c')).toEqual({ screen: 'list' });
    expect(parsePath('/c/')).toEqual({ screen: 'list' });
    expect(parsePath('/c/abc/extra')).toEqual({ screen: 'list' });
    expect(parsePath('/cards/abc')).toEqual({ screen: 'list' });
  });
});
